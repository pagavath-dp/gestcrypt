import { CFG, stats, quantize } from './gesture.mjs';
import { sharedCameraOperations } from './camera-operations.mjs';

export const VAULT_GESTURE_DB_NAME = 'gestcrypt-v3-vault-gesture';
export const VAULT_GESTURE_DB_VERSION = 1;
const STORE = 'template';
const SLOT = 'primary';
const SIGNATURE = /^GC1:T[0-2]-I[0-2]-M[0-2]-R[0-2]-P[0-2]-a[01x]-b[01x]-c[01x]$/;
const FEATURES = ['thumb', 'index', 'middle', 'ring', 'pinky', 'sp_im', 'sp_mr', 'sp_rp'];
const CAPTURE_TIMEOUT_MS = 45000; // Camera startup, fresh readiness, and capture each have their own bounds.

function failure(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validTemplate(record) {
  return record?.slot === SLOT && record.version === 1 &&
    Number.isSafeInteger(record.revision) && record.revision > 0 &&
    typeof record.signature === 'string' && SIGNATURE.test(record.signature);
}

export class VaultGestureStore {
  constructor(indexedDBFactory = globalThis.indexedDB) { this.indexedDBFactory = indexedDBFactory; }

  async #database() {
    if (!this.indexedDBFactory) throw failure('Vault gesture storage is unavailable.', 'storage');
    return new Promise((resolve, reject) => {
      let settled = false, request;
      try { request = this.indexedDBFactory.open(VAULT_GESTURE_DB_NAME, VAULT_GESTURE_DB_VERSION); }
      catch (error) { reject(error); return; }
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'slot' });
      };
      request.onsuccess = () => {
        if (settled) request.result.close();
        else { settled = true; resolve(request.result); }
      };
      request.onerror = () => {
        if (!settled) { settled = true; reject(request.error || failure('Vault gesture storage could not open.', 'storage')); }
      };
      request.onblocked = () => {
        if (!settled) { settled = true; reject(failure('Vault gesture storage upgrade is blocked.', 'storage')); }
      };
    });
  }

  async #transaction(mode, operation) {
    const db = await this.#database();
    return new Promise((resolve, reject) => {
      let tx, value, reason;
      try { tx = db.transaction(STORE, mode); }
      catch (error) { db.close(); reject(error); return; }
      tx.oncomplete = () => { db.close(); resolve(value); };
      tx.onabort = () => { db.close(); reject(reason || tx.error || failure('Vault gesture storage transaction failed.', 'storage')); };
      tx.onerror = () => { /* onabort reports the transaction error */ };
      const abort = error => { reason = error; try { tx.abort(); } catch { db.close(); reject(error); } };
      try { operation(tx.objectStore(STORE), result => { value = result; }, abort); }
      catch (error) { abort(error); }
    });
  }

  async read() {
    const record = await this.#transaction('readonly', (store, finish) => {
      store.get(SLOT).onsuccess = event => finish(event.target.result);
    });
    if (record === undefined) return null;
    if (!validTemplate(record)) throw failure('Vault gesture template is corrupt or incompatible.', 'storage');
    return { signature: record.signature, revision: record.revision };
  }

  async saveConfirmed(signature, expectedRevision = null) {
    if (typeof signature !== 'string' || !SIGNATURE.test(signature) ||
        (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1))) {
      throw failure('Invalid Vault gesture enrollment.', 'invalid');
    }
    return this.#transaction('readwrite', (store, finish, abort) => {
      store.get(SLOT).onsuccess = event => {
        const current = event.target.result;
        if (current !== undefined && !validTemplate(current)) {
          abort(failure('Vault gesture template is corrupt or incompatible.', 'storage')); return;
        }
        if ((current?.revision ?? null) !== expectedRevision) {
          abort(failure('Vault gesture template changed; enrollment was not saved.', 'conflict')); return;
        }
        const revision = (current?.revision ?? 0) + 1;
        store.put({ slot: SLOT, version: 1, revision, signature });
        finish(revision);
      };
    });
  }
}

export class VaultGestureService {
  constructor({ store, captureFrames, coordinator = sharedCameraOperations,
    timeoutMs = CAPTURE_TIMEOUT_MS, page = globalThis.window } = {}) {
    if (!store || typeof store.read !== 'function' || typeof store.saveConfirmed !== 'function' ||
        typeof captureFrames !== 'function' || !coordinator || typeof coordinator.run !== 'function') {
      throw new TypeError('Vault gesture storage, capture, and camera coordination are required.');
    }
    this.store = store;
    this.captureFrames = captureFrames;
    this.coordinator = coordinator;
    this.timeoutMs = timeoutMs;
    this.pendingEnrollment = null;
    this.enrollmentCommitting = false;
    this.activeController = null;
    this.disposed = false;
    this.page = page;
    this.onPageHide = () => this.dispose();
    this.page?.addEventListener?.('pagehide', this.onPageHide);
  }

  async startEnrollment({ replace = false } = {}) {
    if (this.disposed || this.pendingEnrollment || this.activeController) throw failure('Vault enrollment is unavailable.', 'busy');
    const existing = await this.store.read();
    if (this.disposed || this.pendingEnrollment || this.activeController) throw failure('Vault enrollment is unavailable.', 'busy');
    if (existing && !replace) throw failure('A Vault gesture is already enrolled. Explicit re-enrollment is required.', 'exists');
    this.pendingEnrollment = { firstSignature: null, expectedRevision: existing?.revision ?? null };
    return { nextCapture: 1 };
  }

  cancelEnrollment() {
    if (this.enrollmentCommitting) return false;
    this.pendingEnrollment = null;
    this.activeController?.abort(failure('Vault gesture capture cancelled.', 'cancelled'));
    return true;
  }

  dispose() {
    this.disposed = true;
    this.cancelEnrollment();
    this.page?.removeEventListener?.('pagehide', this.onPageHide);
  }

  async #freshSignature(signal) {
    if (this.disposed || signal?.aborted) throw failure('Vault gesture capture cancelled.', 'cancelled');
    const controller = new AbortController();
    this.activeController = controller;
    const onAbort = () => controller.abort(failure('Vault gesture capture cancelled.', 'cancelled'));
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = globalThis.setTimeout(() => controller.abort(
      failure('Vault gesture capture timed out.', 'timeout')), this.timeoutMs);
    try {
      if (signal?.aborted) onAbort();
      // The adapter must ensure camera startup, a new readiness observation, and
      // one production CapturePolicy capture. It must settle when aborted.
      const frames = await this.captureFrames({ signal: controller.signal });
      if (controller.signal.aborted || this.disposed) throw controller.signal.reason || failure('Vault gesture capture cancelled.', 'cancelled');
      if (!Array.isArray(frames) || frames.length !== CFG.FRAMES ||
          !frames.every(frame => frame && FEATURES.every(key => Number.isFinite(frame[key])))) {
        throw failure('Vault gesture capture was incomplete or invalid.', 'invalid');
      }
      const result = quantize(stats(frames));
      if (!result.ok) throw failure('Vault gesture capture was rejected as ambiguous or unstable.', 'rejected');
      return result.sig;
    } finally {
      globalThis.clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (this.activeController === controller) this.activeController = null;
    }
  }

  async captureEnrollmentStep({ signal } = {}) {
    const pending = this.pendingEnrollment;
    if (!pending || this.disposed || this.activeController) throw failure('Start a Vault enrollment before each capture step.', 'busy');
    try {
      return await this.coordinator.run('vault-enrollment', async () => {
        const signature = await this.#freshSignature(signal);
        if (this.pendingEnrollment !== pending || signal?.aborted || this.disposed) {
          throw failure('Vault enrollment was cancelled.', 'cancelled');
        }
        if (pending.firstSignature === null) {
          pending.firstSignature = signature;
          return { complete: false, nextCapture: 2 };
        }
        if (signature !== pending.firstSignature) throw failure('The two Vault captures did not match. Enroll again.', 'mismatch');
        this.enrollmentCommitting = true;
        try { await this.store.saveConfirmed(signature, pending.expectedRevision); }
        finally { this.enrollmentCommitting = false; }
        this.pendingEnrollment = null;
        return { complete: true };
      });
    } catch (error) {
      if (this.pendingEnrollment === pending) this.pendingEnrollment = null;
      throw error;
    }
  }

  async verifyAndRun(operation, action, { signal } = {}) {
    if (!['encrypt', 'decrypt'].includes(operation) || typeof action !== 'function') {
      throw failure('Choose one normal Vault operation.', 'invalid');
    }
    if (this.disposed || this.pendingEnrollment || this.activeController) throw failure('Vault gesture verification is unavailable.', 'busy');
    return this.coordinator.run('vault-' + operation, async () => {
      const template = await this.store.read();
      if (!template) throw failure('Enroll a Vault gesture before normal access.', 'not_enrolled');
      const signature = await this.#freshSignature(signal);
      if (signal?.aborted || this.disposed) throw failure('Vault gesture verification was cancelled.', 'cancelled');
      if (signature !== template.signature) throw failure('Vault gesture did not match.', 'mismatch');
      const result = await action(); // No reusable verification token or signature leaves this service.
      if (signal?.aborted || this.disposed) {
        result?.recoveryKey?.fill(0);
        throw failure('Vault operation was cancelled.', 'cancelled');
      }
      return result;
    });
  }
}
