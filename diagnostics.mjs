import { CFG } from './gesture.mjs';

// Derived summaries only. No frames, landmarks, credentials, or file contents.
export function quantizationDiagnostics({ med, sd }, {
  ratioMargin = CFG.MARGIN_R, angleMargin = CFG.MARGIN_A, legacy = false
} = {}) {
  const rows = [];
  const levels = {};
  for (const [feature, boundaries] of [
    ['thumb', CFG.THUMB_T], ['index', CFG.FINGER_T], ['middle', CFG.FINGER_T],
    ['ring', CFG.FINGER_T], ['pinky', CFG.FINGER_T]
  ]) {
    const median = med[feature], variability = sd[feature];
    const boundary = Math.abs(median - boundaries[0]) <= Math.abs(median - boundaries[1]) ? boundaries[0] : boundaries[1];
    const distance = Math.abs(median - boundary);
    const margin = legacy ? 0 : ratioMargin;
    const nonFinite = !Number.isFinite(median) || !Number.isFinite(variability);
    const unstable = variability > CFG.MAX_STD_R;
    const ambiguous = distance < margin;
    levels[feature] = median < boundaries[0] ? 0 : median < boundaries[1] ? 1 : 2;
    rows.push({ feature, unit: 'ratio', applicable: true, median, boundary, distance, margin,
      standardDeviation: variability, maxStandardDeviation: CFG.MAX_STD_R,
      nonFinite, unstable, ambiguous, blocksCapture: legacy ? unstable : nonFinite || unstable || ambiguous });
  }
  for (const [feature, left, right] of [
    ['sp_im', 'index', 'middle'], ['sp_mr', 'middle', 'ring'], ['sp_rp', 'ring', 'pinky']
  ]) {
    const median = med[feature], variability = sd[feature];
    const applicable = levels[left] === 2 && levels[right] === 2;
    const boundary = CFG.SPREAD_T, distance = Math.abs(median - boundary), margin = legacy ? 0 : angleMargin;
    const nonFinite = !Number.isFinite(median) || !Number.isFinite(variability);
    const unstable = variability > CFG.MAX_STD_A;
    const ambiguous = distance < margin;
    rows.push({ feature, unit: 'degrees', applicable, median, boundary, distance, margin,
      standardDeviation: variability, maxStandardDeviation: CFG.MAX_STD_A,
      nonFinite, unstable, ambiguous, blocksCapture: applicable && (legacy ? unstable : nonFinite || unstable || ambiguous) });
  }
  return rows;
}

export function reportTestCapture(summary, result, logger = console) {
  logger.info('GestCrypt test capture:', {
    outcome: result.ok ? 'ACCEPTED' : 'REJECTED',
    signature: result.ok ? result.sig : null,
    reason: result.ok ? null : result.reason
  });
  logger.table(quantizationDiagnostics(summary));
}
