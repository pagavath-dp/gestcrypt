import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG, quantize } from '../gesture.mjs';
import { EVALUATION_CONFIGS, quantizeForEvaluation } from '../evaluation-quantizer.mjs';

const summary = (value = {}) => ({ med: { thumb: 1, index: 1, middle: 1, ring: 1, pinky: 1,
  sp_im: 0, sp_mr: 0, sp_rp: 0, ...value }, sd: { thumb: 0, index: 0, middle: 0,
    ring: 0, pinky: 0, sp_im: 0, sp_mr: 0, sp_rp: 0 } });
const [loose, baseline, strict] = EVALUATION_CONFIGS;

test('baseline shadow quantizer matches production on a finite feature grid', () => {
  const ratios = [0.8, 1.11, 1.15, 1.19, 1.26, 1.30, 1.34, 1.56, 1.60, 1.64,
    1.66, 1.70, 1.74, 2];
  const angles = [0, 8, 9, 10, 11, 12, 13, 14, 15, 20];
  for (const thumb of ratios) for (const index of ratios) for (const angle of angles) {
    const sample = summary({ thumb, index, middle: 2, sp_im: angle });
    for (const sd of [0, CFG.MAX_STD_R, CFG.MAX_STD_R + 0.001]) {
      sample.sd.index = sd;
      const actual = quantize(sample), shadow = quantizeForEvaluation(sample, baseline);
      assert.equal(shadow.ok, actual.ok);
      assert.equal(shadow.reason, actual.reason);
      assert.equal(shadow.sig, actual.sig);
    }
  }
  for (const sd of [0, CFG.MAX_STD_A, CFG.MAX_STD_A + 0.001]) {
    const sample = summary({ index: 2, middle: 2, sp_im: 20 }); sample.sd.sp_im = sd;
    assert.equal(quantizeForEvaluation(sample, baseline).ok, quantize(sample).ok);
  }
  let seed = 1987;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let i = 0; i < 5000; i++) {
    const sample = summary(Object.fromEntries(['thumb', 'index', 'middle', 'ring', 'pinky']
      .map(key => [key, 0.7 + next() * 1.6])));
    for (const key of ['sp_im', 'sp_mr', 'sp_rp']) sample.med[key] = next() * 30;
    for (const key of ['thumb', 'index', 'middle', 'ring', 'pinky']) sample.sd[key] = next() * 0.15;
    for (const key of ['sp_im', 'sp_mr', 'sp_rp']) sample.sd[key] = next() * 8;
    const actual = quantize(sample), shadow = quantizeForEvaluation(sample, baseline);
    assert.equal(shadow.ok, actual.ok);
    assert.equal(shadow.reason, actual.reason);
    assert.equal(shadow.sig, actual.sig);
  }
});

test('candidate margins change only the configured ambiguity bands', () => {
  const near = summary({ index: 1.325 });
  assert.equal(quantizeForEvaluation(near, loose).ok, true);
  assert.equal(quantizeForEvaluation(near, baseline).code, 'finger_ambiguous');
  assert.equal(quantizeForEvaluation(near, strict).code, 'finger_ambiguous');
  const spread = summary({ index: 2, middle: 2, sp_im: 14.5 });
  assert.equal(quantizeForEvaluation(spread, baseline).ok, true);
  assert.equal(quantizeForEvaluation(spread, strict).code, 'spread_ambiguous');
  const unstable = summary(); unstable.sd.index = CFG.MAX_STD_R + 0.001;
  for (const config of EVALUATION_CONFIGS) assert.equal(quantizeForEvaluation(unstable, config).code, 'finger_unstable');
});
