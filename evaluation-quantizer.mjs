import { CFG } from './gesture.mjs';

export const EVALUATION_CONFIGS = Object.freeze([
  Object.freeze({ id: 'loose', ratioMargin: 0.02, angleMargin: 1 }),
  Object.freeze({ id: 'baseline', ratioMargin: 0.04, angleMargin: 2 }),
  Object.freeze({ id: 'strict', ratioMargin: 0.06, angleMargin: 3 })
]);

// Study-only shadow quantizer. It does not alter CFG or the production quantizer.
export function quantizeForEvaluation({ med, sd }, config) {
  if (!EVALUATION_CONFIGS.includes(config)) throw new Error('Unknown evaluation configuration.');
  const out = [], levels = {};
  for (const [key, thresholds, letter] of [
    ['thumb', CFG.THUMB_T, 'T'], ['index', CFG.FINGER_T, 'I'],
    ['middle', CFG.FINGER_T, 'M'], ['ring', CFG.FINGER_T, 'R'], ['pinky', CFG.FINGER_T, 'P']
  ]) {
    if (!Number.isFinite(med[key]) || !Number.isFinite(sd[key]) || sd[key] > CFG.MAX_STD_R) {
      return { ok: false, code: 'finger_unstable', reason: `Hold steady: ${key} is moving too much.` };
    }
    const value = med[key];
    if (Math.abs(value - thresholds[0]) < config.ratioMargin || Math.abs(value - thresholds[1]) < config.ratioMargin) {
      return { ok: false, code: 'finger_ambiguous', reason: `The ${key} finger is between positions. Curl or extend it more clearly.` };
    }
    levels[key] = value < thresholds[0] ? 0 : value < thresholds[1] ? 1 : 2;
    out.push(letter + levels[key]);
  }
  for (const [key, left, right, letter] of [
    ['sp_im', 'index', 'middle', 'a'], ['sp_mr', 'middle', 'ring', 'b'], ['sp_rp', 'ring', 'pinky', 'c']
  ]) {
    if (levels[left] === 2 && levels[right] === 2) {
      if (!Number.isFinite(med[key]) || !Number.isFinite(sd[key]) || sd[key] > CFG.MAX_STD_A) {
        return { ok: false, code: 'spread_unstable', reason: 'Hold steady: finger spread is changing.' };
      }
      if (Math.abs(med[key] - CFG.SPREAD_T) < config.angleMargin) {
        return { ok: false, code: 'spread_ambiguous', reason: 'Finger spread is ambiguous. Spread them wider or hold them together.' };
      }
      out.push(letter + (med[key] > CFG.SPREAD_T ? 1 : 0));
    } else out.push(letter + 'x');
  }
  return { ok: true, code: 'accepted', sig: 'GC1:' + out.join('-') };
}
