export const CFG = {
  FRAMES: 25,
  FINGER_T: [1.30, 1.70],
  THUMB_T: [1.15, 1.60],
  SPREAD_T: 12,
  MARGIN_R: 0.04,
  MARGIN_A: 2,
  MAX_STD_R: 0.12,
  MAX_STD_A: 6,
  KDF_ITER: 600000
};

export function stats(frames) {
  const med = {}, sd = {};
  for (const k of Object.keys(frames[0])) {
    const a = frames.map(f => f[k]).sort((x, y) => x - y);
    med[k] = a[a.length >> 1];
    const m = a.reduce((s, v) => s + v, 0) / a.length;
    sd[k] = Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
  }
  return { med, sd };
}

export function quantize({ med, sd }, { legacy = false } = {}) {
  const out = [], lvl = {};
  const ratioMargin = legacy ? 0 : CFG.MARGIN_R;
  const angleMargin = legacy ? 0 : CFG.MARGIN_A;
  const fingers = [["thumb", CFG.THUMB_T, "T"], ["index", CFG.FINGER_T, "I"], ["middle", CFG.FINGER_T, "M"], ["ring", CFG.FINGER_T, "R"], ["pinky", CFG.FINGER_T, "P"]];
  for (const [k, t, c] of fingers) {
    if ((!legacy && (!Number.isFinite(med[k]) || !Number.isFinite(sd[k]))) || sd[k] > CFG.MAX_STD_R) return { ok: false, reason: `Hold steady: ${k} is moving too much.` };
    const v = med[k];
    if (Math.abs(v - t[0]) < ratioMargin || Math.abs(v - t[1]) < ratioMargin) return { ok: false, reason: `The ${k} finger is between positions. Curl or extend it more clearly.` };
    lvl[k] = v < t[0] ? 0 : v < t[1] ? 1 : 2;
    out.push(c + lvl[k]);
  }
  // spread only counts when both neighbouring fingers are fully extended
  for (const [k, a, b, c] of [["sp_im", "index", "middle", "a"], ["sp_mr", "middle", "ring", "b"], ["sp_rp", "ring", "pinky", "c"]]) {
    if (lvl[a] === 2 && lvl[b] === 2) {
      if ((!legacy && (!Number.isFinite(med[k]) || !Number.isFinite(sd[k]))) || sd[k] > CFG.MAX_STD_A) return { ok: false, reason: "Hold steady: finger spread is changing." };
      if (Math.abs(med[k] - CFG.SPREAD_T) < angleMargin) return { ok: false, reason: "Finger spread is ambiguous. Spread them wider or hold them together." };
      out.push(c + (med[k] > CFG.SPREAD_T ? 1 : 0));
    } else out.push(c + "x");
  }
  return { ok: true, sig: "GC1:" + out.join("-") };
}
