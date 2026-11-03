import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createVaultCameraCapture } from '../vault-camera-adapter.mjs';
import { VaultGestureService } from '../vault-gesture.mjs';
import { CameraOperationCoordinator } from '../camera-operations.mjs';
import { quantize, stats } from '../gesture.mjs';

const features = { thumb: 2, index: 2, middle: 2, ring: 2, pinky: 2,
  sp_im: 20, sp_mr: 20, sp_rp: 20 };
const freshFrames = () => Array.from({ length: 25 }, () => ({ ...features }));
const expectedSignature = quantize(stats(freshFrames())).sig;
const template = { async read() { return { signature: expectedSignature, revision: 1 }; },
  async saveConfirmed() { throw new Error('Verification must not modify enrollment.'); } };
const deferred = () => { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject }; };

test('adapter uses startup, a fresh readiness wait, then a new nonlegacy capture', async () => {
  const calls = [];
  const capture = createVaultCameraCapture({
    ensureCamera: async ({ signal }) => { assert.equal(signal.aborted, false); calls.push('camera'); },
    waitForFreshReadiness: async ({ signal }) => { assert.equal(signal.aborted, false); calls.push('readiness'); },
    capturePose: async ({ legacy, signal }) => {
      assert.equal(legacy, false); assert.equal(signal.aborted, false); calls.push('capture');
      return freshFrames();
    }
  });
  const vault = new VaultGestureService({ store: template, captureFrames: capture,
    coordinator: new CameraOperationCoordinator() });
  assert.equal(await vault.verifyAndRun('encrypt', () => 'operation allowed'), 'operation allowed');
  assert.deepEqual(calls, ['camera', 'readiness', 'capture']);
  assert.equal(await vault.verifyAndRun('decrypt', () => 'second operation allowed'), 'second operation allowed');
  assert.deepEqual(calls, ['camera', 'readiness', 'capture', 'camera', 'readiness', 'capture']);
  vault.dispose();
});

test('abort during startup blocks readiness and capture even if startup resolves late', async () => {
  const startup = deferred();
  const controller = new AbortController();
  let readiness = 0, captures = 0;
  const capture = createVaultCameraCapture({ ensureCamera: () => startup.promise,
    waitForFreshReadiness: () => { readiness++; }, capturePose: () => { captures++; } });
  const pending = capture({ signal: controller.signal });
  controller.abort(new Error('cancelled startup'));
  startup.resolve();
  await assert.rejects(pending, /cancelled startup/);
  assert.equal(readiness, 0);
  assert.equal(captures, 0);
});

test('abort during readiness prevents capture and leaves the next request fresh', async () => {
  const waiting = deferred(), controller = new AbortController();
  let captures = 0;
  const capture = createVaultCameraCapture({ ensureCamera: async () => {},
    waitForFreshReadiness: () => waiting.promise,
    capturePose: () => { captures++; return freshFrames(); } });
  const pending = capture({ signal: controller.signal });
  await Promise.resolve();
  controller.abort(new Error('readiness cancelled'));
  waiting.resolve();
  await assert.rejects(pending, /readiness cancelled/);
  assert.equal(captures, 0);
});

test('late capture resolution after abort never runs a Vault action and releases camera lock', async () => {
  const captureResult = deferred(), controller = new AbortController();
  const coordinator = new CameraOperationCoordinator();
  const capture = createVaultCameraCapture({ ensureCamera: async () => {},
    waitForFreshReadiness: async () => {}, capturePose: () => captureResult.promise });
  const vault = new VaultGestureService({ store: template, captureFrames: capture, coordinator });
  let actions = 0;
  const pending = vault.verifyAndRun('decrypt', () => { actions++; return 'plaintext'; }, { signal: controller.signal });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  controller.abort(new Error('cancelled before frame result'));
  captureResult.resolve(freshFrames());
  await assert.rejects(pending, /cancelled before frame result|cancelled/);
  assert.equal(actions, 0);
  assert.equal(coordinator.active, null);
  vault.dispose();
});

test('startup failure and timeout deny operation and release coordinator lock', async () => {
  const coordinator = new CameraOperationCoordinator();
  let actions = 0;
  const startupFailure = createVaultCameraCapture({
    ensureCamera: async () => { throw new Error('camera permission denied'); },
    waitForFreshReadiness: () => { throw new Error('unexpected readiness'); },
    capturePose: () => { throw new Error('unexpected capture'); }
  });
  const failed = new VaultGestureService({ store: template, captureFrames: startupFailure, coordinator });
  await assert.rejects(failed.verifyAndRun('encrypt', () => { actions++; }), /camera permission denied/);
  assert.equal(coordinator.active, null);
  failed.dispose();

  const timeoutCapture = createVaultCameraCapture({ ensureCamera: async () => {},
    waitForFreshReadiness: ({ signal }) => new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
    capturePose: () => { throw new Error('unexpected capture'); } });
  const timed = new VaultGestureService({ store: template, captureFrames: timeoutCapture,
    coordinator, timeoutMs: 10 });
  await assert.rejects(timed.verifyAndRun('decrypt', () => { actions++; }), /timed out/);
  assert.equal(actions, 0);
  assert.equal(coordinator.active, null);
  timed.dispose();
});

// Exercise the actual inline promise/cancellation code without browser storage or camera.
async function inlineCaptureHarness() {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const start = html.indexOf('function showCaptureEvent(event) {');
  const end = html.indexOf('async function getSignature(', start);
  assert.ok(start >= 0 && end > start);
  const script = html.slice(start, end);
  const timers = new Map(); let nextTimer = 1;
  const policy = { start: () => ({ state: 'CAPTURING', message: 'capturing' }),
    reject: (code, message) => ({ state: 'REJECTED', code, message }),
    timeout: () => ({ state: 'REJECTED', code: 'timeout', message: 'capture timeout' }) };
  const elements = { captureStatus: { textContent: '' }, bar: { style: {} } };
  const context = vm.createContext({ capturePolicy: policy, capture: null, freshReadinessWait: null,
    landmarker: {}, frameSampler: { running: true }, CAPTURE_CONFIG: { TIMEOUT_MS: 10000, MAX_FRAME_AGE_MS: 1000 },
    CFG: { FRAMES: 25 }, $: key => elements[key], performance: { now: () => 100 },
    setTimeout: callback => { const id = nextTimer++; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id), FreshReadinessWait: class {
      constructor() { this.pending = true; }
      wait() { return new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; }); }
      cancel(message) { this.pending = false; this.reject(new Error(message)); }
    } });
  vm.runInContext(script, context);
  return { context, timers, elements };
}

test('actual inline capture cancellation clears timer and rejects late accepted frames', async () => {
  const { context, timers } = await inlineCaptureHarness();
  const controller = new AbortController();
  const pending = vm.runInContext('capturePose({ signal: suppliedSignal })',
    Object.assign(context, { suppliedSignal: controller.signal }));
  assert.equal(timers.size, 1);
  controller.abort(new Error('operator cancelled'));
  await assert.rejects(pending, /operator cancelled/);
  assert.equal(timers.size, 0);
  vm.runInContext('showCaptureEvent({state:"ACCEPTED",message:"late",frames:[1]})', context);
  assert.equal(vm.runInContext('capture', context), null);
});

test('actual inline readiness cancellation clears the pending gate', async () => {
  const { context } = await inlineCaptureHarness();
  const controller = new AbortController();
  context.suppliedSignal = controller.signal;
  const pending = vm.runInContext('waitForFreshReadiness({ signal: suppliedSignal })', context);
  assert.notEqual(vm.runInContext('freshReadinessWait', context), null);
  const reason = new Error('Vault readiness timed out');
  reason.code = 'timeout';
  controller.abort(reason);
  await assert.rejects(pending, /Vault readiness timed out/);
  assert.equal(vm.runInContext('freshReadinessWait', context), null);
});
