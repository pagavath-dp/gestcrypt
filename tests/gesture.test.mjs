import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG, quantize, stats } from '../gesture.mjs';

const sample = (changes = {}, sdChanges = {}) => ({
  med: { thumb: 1, index: 1, middle: 1, ring: 1, pinky: 1,
    sp_im: 0, sp_mr: 0, sp_rp: 0, ...changes },
  sd: { thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0,
    sp_im: 0, sp_mr: 0, sp_rp: 0, ...sdChanges }
});

test('legacy ratio boundaries use the higher bucket at equality', () => {
  assert.equal(quantize(sample({ index: CFG.FINGER_T[0] }), { legacy: true }).sig, 'GC1:T0-I1-M0-R0-P0-ax-bx-cx');
  assert.equal(quantize(sample({ index: CFG.FINGER_T[1] }), { legacy: true }).sig, 'GC1:T0-I2-M0-R0-P0-ax-bx-cx');
  assert.equal(quantize(sample({ thumb: CFG.THUMB_T[0] }), { legacy: true }).sig, 'GC1:T1-I0-M0-R0-P0-ax-bx-cx');
});

test('legacy spread boundary uses together at equality', () => {
  assert.equal(quantize(sample({ index: 2, middle: 2, sp_im: CFG.SPREAD_T }), { legacy: true }).sig,
    'GC1:T0-I2-M2-R0-P0-a0-bx-cx');
});

test('legacy stability thresholds reject only values above maximum', () => {
  assert.equal(quantize(sample({}, { index: CFG.MAX_STD_R })).ok, true);
  assert.equal(quantize(sample({}, { index: CFG.MAX_STD_R + 0.001 })).ok, false);
  assert.equal(quantize(sample({ index: 2, middle: 2 }, { sp_im: CFG.MAX_STD_A + 0.001 })).ok, false);
});

test('median uses the upper middle value across an even number of frames', () => {
  assert.equal(stats([{ index: 1 }, { index: 2 }]).med.index, 2);
});

test('new captures reject values inside ratio and spread guard bands', () => {
  assert.equal(quantize(sample({ index: CFG.FINGER_T[0] })).ok, false);
  assert.equal(quantize(sample({ index: CFG.FINGER_T[0] - CFG.MARGIN_R / 2 })).ok, false);
  assert.equal(quantize(sample({ index: CFG.FINGER_T[0] - CFG.MARGIN_R })).ok, true);
  assert.equal(quantize(sample({ index: 2, middle: 2, sp_im: CFG.SPREAD_T })).ok, false);
  assert.equal(quantize(sample({ index: 2, middle: 2, sp_im: CFG.SPREAD_T + CFG.MARGIN_A })).ok, true);
});

test('legacy version-1 decryption can still represent boundary signatures', () => {
  assert.equal(quantize(sample({ index: CFG.FINGER_T[0] }), { legacy: true }).ok, true);
  assert.equal(quantize(sample({ index: 2, middle: 2, sp_im: CFG.SPREAD_T }), { legacy: true }).ok, true);
});

test('invalid numeric features are rejected instead of becoming a signature', () => {
  assert.equal(quantize(sample({ thumb: NaN })).ok, false);
  assert.equal(quantize(sample({ index: 2, middle: 2, sp_im: NaN })).ok, false);
});

test('legacy decryption retains the original mapping of non-finite landmarks', () => {
  assert.equal(quantize(sample({ thumb: NaN }), { legacy: true }).sig,
    'GC1:T2-I0-M0-R0-P0-ax-bx-cx');
  assert.equal(quantize(sample({ index: 2, middle: 2, sp_im: NaN }), { legacy: true }).sig,
    'GC1:T0-I2-M2-R0-P0-a0-bx-cx');
});
