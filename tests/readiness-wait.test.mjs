import test from 'node:test';
import assert from 'node:assert/strict';
import { FreshReadinessWait } from '../readiness-wait.mjs';
import { CapturePolicy, CAPTURE_CONFIG } from '../capture.mjs';

function clock() {
  let now = 0, callback = null, cleared = 0;
  return { now: () => now, at: value => { now = value; },
    setTimer: fn => { callback = fn; return 1; },
    clearTimer: id => { assert.equal(id, 1); callback = null; cleared++; },
    fire: () => { const fn = callback; assert.ok(fn); fn(); },
    pending: () => callback !== null, cleared: () => cleared };
}
const landmarks = () => Array.from({ length: 21 }, (_, i) => ({ x: .2 + i * .005, y: .3 + i * .004, z: 0 }));
const result = () => ({ landmarks: [landmarks()], worldLandmarks: [landmarks()], handedness: [[]] });
const policy = () => new CapturePolicy({ extractFeatures: () => ({ marker: 1 }) });

test('confirmation-length pause requires five fresh valid frames before readiness returns', async () => {
  const time = clock(), capture = policy();
  for (let i = 1; i <= 5; i++) capture.observe(result(), i, i * 30);
  assert.equal(capture.state, 'SINGLE_HAND_READY');
  time.at(2000);
  const gate = new FreshReadinessWait({ afterMs: 2000, maxAgeMs: 1000, timeoutMs: 10000, ...time });
  const waited = gate.wait();
  assert.equal(gate.observe({ state: 'SINGLE_HAND_READY', code: 'ready' }, 150), false);
  for (let i = 1; i <= 4; i++) {
    time.at(2000 + i * 30);
    const event = capture.observe(result(), 5 + i, time.now());
    assert.equal(event.state, 'WAITING');
    assert.equal(gate.observe(event, time.now()), false);
  }
  time.at(2150);
  const event = capture.observe(result(), 10, time.now());
  assert.equal(event.state, 'SINGLE_HAND_READY');
  assert.equal(gate.observe(event, time.now()), true);
  await waited;
  assert.equal(time.pending(), false);
  assert.equal(time.cleared(), 1);
});

test('capture starts once after restored readiness and uses exactly 25 new frames', async () => {
  const time = clock(), capture = policy();
  for (let i = 1; i <= 5; i++) capture.observe(result(), i, i * 30);
  time.at(2000);
  const gate = new FreshReadinessWait({ afterMs: 2000, maxAgeMs: 1000, timeoutMs: 10000, ...time });
  const waited = gate.wait();
  for (let i = 1; i <= 5; i++) {
    time.at(2000 + i * 30);
    gate.observe(capture.observe(result(), 5 + i, time.now()), time.now());
  }
  await waited;
  assert.equal(capture.start(time.now()).state, 'CAPTURING');
  for (let i = 1; i < CAPTURE_CONFIG.CAPTURE_FRAMES; i++) {
    time.at(2150 + i * 30);
    assert.equal(capture.observe(result(), 10 + i, time.now()).state, 'CAPTURING');
  }
  time.at(2150 + CAPTURE_CONFIG.CAPTURE_FRAMES * 30);
  const accepted = capture.observe(result(), 10 + CAPTURE_CONFIG.CAPTURE_FRAMES, time.now());
  assert.equal(accepted.state, 'ACCEPTED');
  assert.equal(accepted.frames.length, 25);
  assert.equal(capture.frames.length, 0);
});

test('readiness timeout rejects the waiting attempt and clears its timer', async () => {
  const time = clock();
  const gate = new FreshReadinessWait({ afterMs: 0, maxAgeMs: 1000, timeoutMs: 10000, ...time });
  const waited = gate.wait();
  time.fire();
  await assert.rejects(waited, error => error.code === 'not_ready' && /Fresh single-hand readiness/.test(error.message));
  assert.equal(time.pending(), false);
  assert.equal(gate.observe({ state: 'SINGLE_HAND_READY', code: 'ready' }, 1), false);
});

test('camera or page cancellation rejects once and leaves no pending timer', async () => {
  const time = clock();
  const gate = new FreshReadinessWait({ afterMs: 0, maxAgeMs: 1000, timeoutMs: 10000, ...time });
  const waited = gate.wait();
  assert.equal(gate.cancel('Page is closing.', 'interrupted'), true);
  await assert.rejects(waited, error => error.code === 'interrupted');
  assert.equal(gate.cancel('Duplicate cancellation'), false);
  assert.equal(time.pending(), false);
  assert.equal(time.cleared(), 1);
});

test('browser-style timer methods retain their required receiver', async () => {
  let pending = null, cleared = 0;
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  globalThis.setTimeout = function (callback) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    pending = callback;
    return 1;
  };
  globalThis.clearTimeout = function (id) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    assert.equal(id, 1);
    pending = null;
    cleared++;
  };
  try {
    const gate = new FreshReadinessWait({ afterMs: 0, maxAgeMs: 1000, timeoutMs: 10000, now: () => 2 });
    const waited = gate.wait();
    assert.equal(gate.observe({ state: 'SINGLE_HAND_READY', code: 'ready' }, 1), true);
    await waited;
    assert.equal(pending, null);
    assert.equal(cleared, 1);
  } finally {
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
  }
});
