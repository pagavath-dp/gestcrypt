import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { VaultGestureService, VaultGestureStore, VAULT_GESTURE_DB_NAME } from '../vault-gesture.mjs';
import { CameraOperationCoordinator } from '../camera-operations.mjs';
import { stats, quantize } from '../gesture.mjs';

const extended = { thumb: 2, index: 2, middle: 2, ring: 2, pinky: 2,
  sp_im: 20, sp_mr: 20, sp_rp: 20 };
const folded = { thumb: 0.8, index: 0.8, middle: 0.8, ring: 0.8, pinky: 0.8,
  sp_im: 0, sp_mr: 0, sp_rp: 0 };
const frames = value => Array.from({ length: 25 }, () => ({ ...value }));
const openFrames = frames(extended), fistFrames = frames(folded);
const openSignature = quantize(stats(openFrames)).sig;
const fistSignature = quantize(stats(fistFrames)).sig;

function memoryTemplateStore() {
  let template = null;
  return {
    async read() { return template ? { ...template } : null; },
    async saveConfirmed(signature, expectedRevision) {
      if ((template?.revision ?? null) !== expectedRevision) throw new Error('Template changed.');
      template = { signature, revision: (template?.revision ?? 0) + 1 };
    },
    snapshot() { return template ? { ...template } : null; }
  };
}
function queuedCapture(...outcomes) {
  let calls = 0;
  const captureFrames = async ({ signal }) => {
    calls++;
    const next = outcomes.shift();
    if (next === undefined) throw new Error('Unexpected capture request.');
    if (signal.aborted) throw signal.reason;
    return typeof next === 'function' ? next(signal) : next;
  };
  captureFrames.calls = () => calls;
  return captureFrames;
}
const abortableHold = signal => new Promise((resolve, reject) => {
  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});
const service = (store, captureFrames, coordinator = new CameraOperationCoordinator(), options = {}) =>
  new VaultGestureService({ store, captureFrames, coordinator, ...options });

test('two separately initiated matching production captures enroll once', async () => {
  const store = memoryTemplateStore(), capture = queuedCapture(openFrames, openFrames);
  const vault = service(store, capture);
  assert.deepEqual(await vault.startEnrollment(), { nextCapture: 1 });
  assert.deepEqual(await vault.captureEnrollmentStep(), { complete: false, nextCapture: 2 });
  assert.equal(store.snapshot(), null, 'first capture is never persisted');
  assert.equal(capture.calls(), 1);
  assert.deepEqual(await vault.captureEnrollmentStep(), { complete: true });
  assert.equal(capture.calls(), 2);
  assert.deepEqual(store.snapshot(), { signature: openSignature, revision: 1 });
  await assert.rejects(vault.startEnrollment(), /already enrolled/);
});

test('mismatched second capture rejects enrollment without partial template', async () => {
  const store = memoryTemplateStore(), vault = service(store, queuedCapture(openFrames, fistFrames));
  await vault.startEnrollment();
  await vault.captureEnrollmentStep();
  await assert.rejects(vault.captureEnrollmentStep(), /did not match/);
  assert.equal(store.snapshot(), null);
  assert.equal(vault.pendingEnrollment, null);
});

test('re-enrollment failure preserves the prior confirmed template', async () => {
  const store = memoryTemplateStore();
  await store.saveConfirmed(fistSignature, null);
  const vault = service(store, queuedCapture(openFrames, fistFrames));
  await vault.startEnrollment({ replace: true });
  await vault.captureEnrollmentStep();
  await assert.rejects(vault.captureEnrollmentStep(), /did not match/);
  assert.deepEqual(store.snapshot(), { signature: fistSignature, revision: 1 });
});

test('cancelled enrollment and camera failure clear pending state', async () => {
  const store = memoryTemplateStore();
  const vault = service(store, queuedCapture(openFrames, abortableHold));
  await vault.startEnrollment();
  await vault.captureEnrollmentStep();
  const pending = vault.captureEnrollmentStep();
  vault.cancelEnrollment();
  await assert.rejects(pending, /cancelled/);
  assert.equal(store.snapshot(), null);
  assert.equal(vault.pendingEnrollment, null);
  const failed = service(store, queuedCapture(() => { throw new Error('camera error'); }));
  await failed.startEnrollment();
  await assert.rejects(failed.captureEnrollmentStep(), /camera error/);
  assert.equal(failed.pendingEnrollment, null);
});

test('fresh verification runs one action per new capture and cannot reuse a match', async () => {
  const store = memoryTemplateStore();
  await store.saveConfirmed(openSignature, null);
  const capture = queuedCapture(openFrames, fistFrames, openFrames);
  const vault = service(store, capture);
  let actions = 0;
  assert.equal(await vault.verifyAndRun('encrypt', () => { actions++; return 'encrypted'; }), 'encrypted');
  await assert.rejects(vault.verifyAndRun('decrypt', () => { actions++; return 'plaintext'; }), /did not match/);
  assert.equal(actions, 1);
  assert.equal(await vault.verifyAndRun('decrypt', () => { actions++; return 'decrypted'; }), 'decrypted');
  assert.equal(capture.calls(), 3);
  assert.equal(actions, 2);
  await assert.rejects(vault.verifyAndRun('encrypt', () => { actions++; }), /Unexpected capture request/);
  assert.equal(actions, 2);
});

test('ambiguous and incomplete captures deny verification without invoking the action', async () => {
  const store = memoryTemplateStore();
  await store.saveConfirmed(openSignature, null);
  const ambiguous = frames({ ...extended, index: 1.30 });
  const capture = queuedCapture(ambiguous, openFrames.slice(0, 24),
    () => { throw new Error('second hand entered'); });
  const vault = service(store, capture);
  let actions = 0;
  for (const pattern of [/ambiguous or unstable/, /incomplete or invalid/, /second hand/]) {
    await assert.rejects(vault.verifyAndRun('encrypt', () => { actions++; }), pattern);
  }
  assert.equal(actions, 0);
  assert.equal(vault.activeController, null);
});

test('timeout, external cancellation and dispose release verification state', async () => {
  const store = memoryTemplateStore();
  await store.saveConfirmed(openSignature, null);
  const timeoutVault = service(store, queuedCapture(abortableHold, openFrames),
    new CameraOperationCoordinator(), { timeoutMs: 10 });
  await assert.rejects(timeoutVault.verifyAndRun('encrypt', () => 'never'), /timed out/);
  assert.equal(timeoutVault.activeController, null);
  assert.equal(await timeoutVault.verifyAndRun('encrypt', () => 'after timeout'), 'after timeout');
  const controller = new AbortController();
  const cancelledVault = service(store, queuedCapture(abortableHold));
  const pending = cancelledVault.verifyAndRun('decrypt', () => 'never', { signal: controller.signal });
  await Promise.resolve();
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(cancelledVault.activeController, null);
  const disposed = service(store, queuedCapture(abortableHold));
  const inProgress = disposed.verifyAndRun('decrypt', () => 'never');
  await Promise.resolve();
  disposed.dispose();
  await assert.rejects(inProgress, /cancelled/);
  await assert.rejects(disposed.verifyAndRun('decrypt', () => 'never'), /unavailable/);
});

test('page exit aborts pending capture and clears enrollment state', async () => {
  const page = new EventTarget(), store = memoryTemplateStore();
  const vault = service(store, queuedCapture(abortableHold), new CameraOperationCoordinator(), { page });
  await vault.startEnrollment();
  const pending = vault.captureEnrollmentStep();
  await Promise.resolve();
  page.dispatchEvent(new Event('pagehide'));
  await assert.rejects(pending, /cancelled/);
  assert.equal(vault.pendingEnrollment, null);
  assert.equal(vault.activeController, null);
  assert.equal(store.snapshot(), null);
});

test('cancellation during an in-flight Vault action returns no result and releases camera lock', async () => {
  const store = memoryTemplateStore();
  await store.saveConfirmed(openSignature, null);
  const coordinator = new CameraOperationCoordinator();
  const controller = new AbortController();
  let startAction, finishAction;
  const actionStarted = new Promise(resolve => { startAction = resolve; });
  const actionResult = new Promise(resolve => { finishAction = resolve; });
  const vault = service(store, queuedCapture(openFrames), coordinator);
  const pending = vault.verifyAndRun('encrypt', () => { startAction(); return actionResult; },
    { signal: controller.signal });
  await actionStarted;
  const output = { recoveryKey: new Uint8Array(32).fill(7), blob: new Blob(['ciphertext']) };
  controller.abort();
  finishAction(output);
  let returned;
  await assert.rejects(async () => { returned = await pending; }, /cancelled/);
  assert.equal(returned, undefined);
  assert.deepEqual(output.recoveryKey, new Uint8Array(32));
  assert.equal(coordinator.active, null);
});

test('enrollment save cannot be reported as cancelled after its transaction starts', async () => {
  const base = memoryTemplateStore();
  let saveStarted, finishSave;
  const started = new Promise(resolve => { saveStarted = resolve; });
  const gate = new Promise(resolve => { finishSave = resolve; });
  const store = { read: () => base.read(), async saveConfirmed(signature, revision) {
    saveStarted();
    await gate;
    return base.saveConfirmed(signature, revision);
  } };
  const vault = service(store, queuedCapture(openFrames, openFrames));
  await vault.startEnrollment();
  await vault.captureEnrollmentStep();
  const second = vault.captureEnrollmentStep();
  await started;
  assert.equal(vault.cancelEnrollment(), false);
  finishSave();
  assert.deepEqual(await second, { complete: true });
  assert.deepEqual(base.snapshot(), { signature: openSignature, revision: 1 });
  assert.equal(vault.enrollmentCommitting, false);
});

test('shared coordinator blocks Vault while StudyRecorder owns camera, then releases it', async () => {
  const coordinator = new CameraOperationCoordinator();
  const store = memoryTemplateStore();
  await store.saveConfirmed(openSignature, null);
  const capture = queuedCapture(openFrames);
  const vault = service(store, capture, coordinator);
  const releaseStudy = coordinator.acquire('study');
  await assert.rejects(vault.verifyAndRun('encrypt', () => 'never'), /already in progress/);
  assert.equal(capture.calls(), 0);
  releaseStudy();
  assert.equal(await vault.verifyAndRun('encrypt', () => 'allowed'), 'allowed');
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /sharedCameraOperations\.acquire\("study"\)/);
  assert.match(html, /releaseCamera\(\)/);
});

// Narrow store double to validate IndexedDB separation and atomic template replacement.
function templateDatabase() {
  let record, schema = false, tail = Promise.resolve();
  const names = [];
  return { names, snapshot: () => record && structuredClone(record),
    open(name, version) {
      names.push(name); assert.equal(version, 1);
      const request = {};
      queueMicrotask(() => {
        const db = { objectStoreNames: { contains: value => schema && value === 'template' },
          createObjectStore(name, options) { assert.equal(name, 'template'); assert.deepEqual(options, { keyPath: 'slot' }); schema = true; },
          close() {}, transaction(name, mode) {
            assert.equal(name, 'template');
            const jobs = [];
            const tx = { abort() { tx.aborted = true; }, objectStore() {
              const queue = (kind, value) => { const req = {}; jobs.push({ kind, value, req }); return req; };
              return { get: value => queue('get', value), put: value => queue('put', value) };
            } };
            const next = tail.then(async () => {
              let staged = record && structuredClone(record);
              for (let i = 0; i < jobs.length && !tx.aborted; i++) {
                const { kind, value, req } = jobs[i];
                if (kind === 'get') req.result = staged && value === staged.slot ? structuredClone(staged) : undefined;
                else staged = structuredClone(value);
                req.onsuccess?.({ target: req });
                await Promise.resolve();
              }
              if (tx.aborted) tx.onabort?.();
              else { if (mode === 'readwrite') record = staged; tx.oncomplete?.(); }
            });
            tail = next.catch(() => {});
            return tx;
          } };
        request.result = db;
        if (!schema) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    }
  };
}

test('Vault template persists in its own versioned IndexedDB, with no study-storage access', async () => {
  const db = templateDatabase();
  const first = new VaultGestureStore(db);
  assert.equal(await first.read(), null);
  assert.equal(await first.saveConfirmed(openSignature, null), 1);
  const reopened = new VaultGestureStore(db);
  assert.deepEqual(await reopened.read(), { signature: openSignature, revision: 1 });
  await assert.rejects(first.saveConfirmed(fistSignature, null), /changed/);
  assert.equal(await reopened.saveConfirmed(fistSignature, 1), 2);
  assert.deepEqual(await first.read(), { signature: fistSignature, revision: 2 });
  assert.ok(db.names.every(name => name === VAULT_GESTURE_DB_NAME));
  assert.equal(db.snapshot().slot, 'primary');
});
