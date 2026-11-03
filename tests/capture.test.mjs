import test from 'node:test';
import assert from 'node:assert/strict';
import { CAPTURE_CONFIG, CapturePolicy } from '../capture.mjs';

const point = (x, y) => ({ x, y, z: 0 });
function hand(shift = 0, scale = 1) {
  return Array.from({ length: 21 }, (_, i) => point(0.2 + shift + (i % 5) * 0.03 * scale,
    0.3 + Math.floor(i / 5) * 0.04 * scale));
}
function result(count = 1, options = {}) {
  const landmarks = Array.from({ length: count }, (_, i) => hand(i * 0.25, options.scale || 1));
  return { landmarks, worldLandmarks: landmarks.map(points => points.map(p => ({ ...p }))),
    handedness: Array.from({ length: count }, () => [{ categoryName: 'Right', score: 0.99 }]) };
}
function harness() {
  const policy = new CapturePolicy({ extractFeatures: world => ({ marker: world[0].x }) });
  let tick = 0;
  const feed = detected => { tick++; return policy.observe(detected, tick / 30, tick * 33); };
  const ready = () => { for (let i = 0; i < CAPTURE_CONFIG.READY_FRAMES; i++) feed(result()); };
  const start = () => policy.start(tick * 33);
  return { policy, feed, ready, start };
}

test('readiness needs five consecutive valid single-hand frames, then 25 capture frames', () => {
  const h = harness();
  for (let i = 1; i < CAPTURE_CONFIG.READY_FRAMES; i++) assert.equal(h.feed(result()).state, 'WAITING');
  assert.equal(h.start().code, 'not_ready');
  h.ready();
  assert.equal(h.policy.state, 'SINGLE_HAND_READY');
  assert.equal(h.start().state, 'CAPTURING');
  for (let i = 1; i < CAPTURE_CONFIG.CAPTURE_FRAMES; i++) assert.equal(h.feed(result()).state, 'CAPTURING');
  const accepted = h.feed(result());
  assert.equal(accepted.state, 'ACCEPTED');
  assert.equal(accepted.frames.length, 25);
  assert.equal(h.policy.frames.length, 0);
});

test('zero or two hands cannot establish readiness or start capture', () => {
  const h = harness();
  for (let i = 0; i < 6; i++) assert.equal(h.feed(result(0)).state, 'WAITING');
  assert.equal(h.start().code, 'not_ready');
  for (let i = 0; i < 6; i++) assert.equal(h.feed(result(2)).code, 'multi_hand');
  assert.equal(h.start().code, 'not_ready');
  assert.equal(h.policy.frames.length, 0);
});

test('a second hand removes readiness even if it was established first', () => {
  const h = harness(); h.ready();
  assert.equal(h.feed(result(2)).code, 'multi_hand');
  assert.equal(h.start().code, 'not_ready');
});

for (const position of [1, 13, 25]) {
  test(`second hand at capture frame ${position} aborts and clears`, () => {
    const h = harness(); h.ready(); h.start();
    for (let i = 1; i < position; i++) h.feed(result());
    const rejected = h.feed(result(2));
    assert.equal(rejected.state, 'REJECTED');
    assert.equal(rejected.code, 'multi_hand');
    assert.equal(h.policy.frames.length, 0);
    assert.equal('frames' in rejected, false);
  });

  test(`hand disappearance at capture frame ${position} aborts and clears`, () => {
    const h = harness(); h.ready(); h.start();
    for (let i = 1; i < position; i++) h.feed(result());
    const rejected = h.feed(result(0));
    assert.equal(rejected.state, 'REJECTED');
    assert.equal(rejected.code, 'no_hand');
    assert.equal(h.policy.frames.length, 0);
  });
}

test('obvious wrist or palm jump and size jump abort capture', () => {
  const moved = result(); moved.landmarks[0] = hand(0.4);
  const large = result(1, { scale: 3 });
  for (const unexpected of [moved, large]) {
    const h = harness(); h.ready(); h.start(); h.feed(result());
    assert.equal(h.feed(unexpected).code, 'continuity');
    assert.equal(h.policy.frames.length, 0);
  }
});

test('conservative continuity boundaries allow ordinary movement and reject larger jumps', () => {
  const h = harness(); h.ready(); h.start(); h.feed(result());
  const within = result(); within.landmarks[0] = hand(0.34);
  assert.equal(h.feed(within).state, 'CAPTURING');
  const beyond = result(); beyond.landmarks[0] = hand(0.71);
  assert.equal(h.feed(beyond).code, 'continuity');

  const size = harness(); size.ready(); size.start(); size.feed(result());
  assert.equal(size.feed(result(1, { scale: 2.4 })).state, 'CAPTURING');
  assert.equal(size.feed(result(1, { scale: 2.4 / 2.6 })).code, 'continuity');
});

test('missing, inconsistent, and non-finite landmarks abort active capture', () => {
  const missingWorld = { landmarks: [hand()], worldLandmarks: [] };
  const shortImage = result(); shortImage.landmarks[0] = shortImage.landmarks[0].slice(0, 20);
  const nonfinite = result(); nonfinite.worldLandmarks[0][0].x = NaN;
  for (const bad of [undefined, missingWorld, shortImage, nonfinite]) {
    const h = harness(); h.ready(); h.start();
    assert.equal(h.feed(bad).code, 'invalid');
    assert.equal(h.policy.frames.length, 0);
  }
});

test('non-finite derived features reject new captures but retain version-1 decryption compatibility', () => {
  const make = () => new CapturePolicy({ extractFeatures: () => ({ ratio: NaN }) });
  const newer = make();
  for (let i = 1; i <= CAPTURE_CONFIG.READY_FRAMES; i++) {
    const event = newer.observe(result(), i, i * 33);
    assert.notEqual(event.state, 'SINGLE_HAND_READY');
  }
  assert.equal(newer.state, 'LEGACY_READY');
  assert.equal(newer.start(CAPTURE_CONFIG.READY_FRAMES * 33).code, 'not_ready');
  assert.equal(newer.frames.length, 0);

  const legacy = make();
  for (let i = 1; i <= CAPTURE_CONFIG.READY_FRAMES; i++) legacy.observe(result(), i, i * 33);
  assert.equal(legacy.start(CAPTURE_CONFIG.READY_FRAMES * 33, { legacy: true }).state, 'CAPTURING');
  let final;
  for (let i = 1; i <= CAPTURE_CONFIG.CAPTURE_FRAMES; i++) final = legacy.observe(result(), i + 5, 165 + i * 33);
  assert.equal(final.state, 'ACCEPTED');
  assert.equal(final.frames.length, CAPTURE_CONFIG.CAPTURE_FRAMES);
});

test('new readiness requires consecutive finite features, including after legacy-only readiness', () => {
  let feature = 1;
  const policy = new CapturePolicy({ extractFeatures: () => ({ ratio: feature }) });
  let tick = 0;
  const feed = () => policy.observe(result(), ++tick, tick * 33);
  for (let i = 0; i < 4; i++) assert.equal(feed().state, 'WAITING');
  feature = Infinity;
  assert.equal(feed().state, 'LEGACY_READY');
  assert.equal(policy.finiteReadyCount, 0);
  feature = 1;
  for (let i = 0; i < 4; i++) assert.equal(feed().state, 'LEGACY_READY');
  assert.equal(feed().state, 'SINGLE_HAND_READY');
  assert.equal(policy.start(tick * 33).state, 'CAPTURING');
});

test('duplicate video timestamps, stale readiness, timeout, and camera error fail closed', () => {
  const h = harness(); h.ready(); h.start(); h.feed(result());
  const duplicate = h.policy.observe(result(), (CAPTURE_CONFIG.READY_FRAMES + 1) / 30,
    (CAPTURE_CONFIG.READY_FRAMES + 2) * 33);
  assert.equal(duplicate.code, 'stale');
  assert.equal(h.policy.frames.length, 0);
  h.ready();
  assert.equal(h.policy.start(100000).code, 'stale');
  h.ready(); h.start(); h.feed(result());
  assert.equal(h.policy.timeout().code, 'timeout');
  assert.equal(h.policy.frames.length, 0);
  h.ready(); h.start(); h.feed(result());
  assert.equal(h.policy.cameraError().code, 'camera_error');
  assert.equal(h.policy.frames.length, 0);
});

test('a long gap between processed frames cancels capture', () => {
  const h = harness(); h.ready(); h.start(); h.feed(result());
  const late = h.policy.observe(result(), 1, 5000);
  assert.equal(late.code, 'stale');
  assert.equal(h.policy.frames.length, 0);
});

test('a failed attempt cannot contribute frames to the next successful one', () => {
  const h = harness(); h.ready(); h.start();
  for (let i = 0; i < 12; i++) h.feed(result());
  h.feed(result(2));
  h.ready(); h.start();
  for (let i = 0; i < 24; i++) assert.equal(h.feed(result()).state, 'CAPTURING');
  assert.equal(h.feed(result()).frames.length, 25);
});
