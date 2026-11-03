import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG, quantize, stats } from '../gesture.mjs';
import { quantizationDiagnostics, reportTestCapture } from '../diagnostics.mjs';

const pose = (changes = {}) => ({ thumb: 1, index: 1, middle: 1, ring: 1, pinky: 1,
  sp_im: 0, sp_mr: 0, sp_rp: 0, ...changes });
const capture = values => stats(Array.from({ length: 25 }, (_, i) =>
  Object.fromEntries(Object.entries(values).map(([key, value]) =>
    [key, value + (i < 12 ? -0.01 : i > 12 ? 0.01 : 0)]))));
const blocked = (summary, settings) => quantizationDiagnostics(summary, settings).some(row => row.blocksCapture);

test('diagnostic distances match current thumb and spread rejection boundaries', () => {
  const thumb = capture(pose({ thumb: 1.13 }));
  const thumbRow = quantizationDiagnostics(thumb).find(row => row.feature === 'thumb');
  assert.equal(thumbRow.boundary, 1.15);
  assert.ok(Math.abs(thumbRow.distance - 0.02) < 1e-12);
  assert.equal(thumbRow.ambiguous, true);
  assert.equal(thumbRow.unstable, false);
  assert.match(quantize(thumb).reason, /thumb finger is between positions/);

  const spread = capture(pose({ index: 2, middle: 2, sp_im: 11 }));
  const spreadRow = quantizationDiagnostics(spread).find(row => row.feature === 'sp_im');
  assert.equal(spreadRow.boundary, 12);
  assert.equal(spreadRow.distance, 1);
  assert.equal(spreadRow.applicable, true);
  assert.equal(spreadRow.ambiguous, true);
  assert.equal(spreadRow.unstable, false);
  assert.match(quantize(spread).reason, /Finger spread is ambiguous/);
});

test('synthetic alternatives show acceptance versus signature-flip tradeoff', () => {
  const thumbLeft = capture(pose({ thumb: 1.121 }));
  const thumbRight = capture(pose({ thumb: 1.179 }));
  assert.equal(blocked(thumbLeft, { ratioMargin: CFG.MARGIN_R }), true);
  assert.equal(blocked(thumbRight, { ratioMargin: CFG.MARGIN_R }), true);
  assert.equal(blocked(thumbLeft, { ratioMargin: 0.02 }), false);
  assert.equal(blocked(thumbRight, { ratioMargin: 0.02 }), false);
  assert.notEqual(quantize(thumbLeft, { legacy: true }).sig, quantize(thumbRight, { legacy: true }).sig);

  const spreadLeft = capture(pose({ index: 2, middle: 2, sp_im: 10.5 }));
  const spreadRight = capture(pose({ index: 2, middle: 2, sp_im: 13.5 }));
  assert.equal(blocked(spreadLeft, { angleMargin: CFG.MARGIN_A }), true);
  assert.equal(blocked(spreadRight, { angleMargin: CFG.MARGIN_A }), true);
  assert.equal(blocked(spreadLeft, { angleMargin: 1 }), false);
  assert.equal(blocked(spreadRight, { angleMargin: 1 }), false);
  assert.notEqual(quantize(spreadLeft, { legacy: true }).sig, quantize(spreadRight, { legacy: true }).sig);

  const clearThumb = capture(pose({ thumb: 1.10 }));
  const clearSpread = capture(pose({ index: 2, middle: 2, sp_im: 9.5 }));
  assert.equal(blocked(clearThumb), false);
  assert.equal(blocked(clearThumb, { ratioMargin: 0.06 }), true);
  assert.equal(blocked(clearSpread), false);
  assert.equal(blocked(clearSpread, { angleMargin: 3 }), true);
});

test('loosening ambiguity margins does not waive excessive variability', () => {
  const frames = Array.from({ length: 25 }, (_, i) => pose({ thumb: i % 2 ? 0.8 : 1.2 }));
  const summary = stats(frames);
  const thumbRow = quantizationDiagnostics(summary, { ratioMargin: 0.02 }).find(row => row.feature === 'thumb');
  assert.ok(thumbRow.standardDeviation > CFG.MAX_STD_R);
  assert.equal(thumbRow.unstable, true);
  assert.equal(blocked(summary, { ratioMargin: 0.02, angleMargin: 1 }), true);
  assert.match(quantize(summary).reason, /thumb is moving too much/);
});

test('baseline diagnostic agrees with quantize on deterministic stable cases', () => {
  for (const values of [pose(), pose({ thumb: 1.13 }),
    pose({ index: 2, middle: 2, sp_im: 11 }), pose({ index: 2, middle: 2, sp_im: 16 })]) {
    const summary = capture(values);
    assert.equal(blocked(summary), !quantize(summary).ok);
  }
});

test('console reporter includes accepted signature and derived summary only', () => {
  const summary = capture(pose({ index: 2, middle: 2, sp_im: 8 }));
  summary.pin = 'must-not-log';
  summary.frames = [{ rawLandmark: 'must-not-log' }];
  const info = [], tables = [];
  reportTestCapture(summary, quantize(summary), {
    info: (...args) => info.push(args), table: value => tables.push(value)
  });
  assert.equal(info.length, 1);
  assert.equal(info[0][1].outcome, 'ACCEPTED');
  assert.equal(info[0][1].signature, 'GC1:T0-I2-M2-R0-P0-a0-bx-cx');
  assert.equal(info[0][1].reason, null);
  assert.equal(tables[0].length, 8);
  assert.equal(tables[0].find(row => row.feature === 'sp_im').median, 8);
  assert.equal(JSON.stringify([info, tables]).includes('must-not-log'), false);
});

test('console reporter includes rejection reason but no final signature', () => {
  const summary = capture(pose({ pinky: 1.68 }));
  const result = quantize(summary);
  assert.equal(result.ok, false);
  const info = [], tables = [];
  reportTestCapture(summary, result, {
    info: (...args) => info.push(args), table: value => tables.push(value)
  });
  assert.equal(info[0][1].outcome, 'REJECTED');
  assert.equal(info[0][1].signature, null);
  assert.match(info[0][1].reason, /pinky finger is between positions/);
  assert.equal(tables[0].find(row => row.feature === 'pinky').ambiguous, true);
});
