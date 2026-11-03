export const CAPTURE_CONFIG = Object.freeze({
  READY_FRAMES: 5,
  CAPTURE_FRAMES: 25,
  MAX_WRIST_JUMP: 0.35,
  MAX_PALM_JUMP: 0.35,
  MAX_SIZE_RATIO: 2.5,
  MAX_FRAME_AGE_MS: 1000,
  TIMEOUT_MS: 10000
});

const finitePoint = point => point && ['x', 'y', 'z'].every(axis => Number.isFinite(point[axis]));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function snapshot(landmarks) {
  const xs = landmarks.map(point => point.x);
  const ys = landmarks.map(point => point.y);
  const palm = [0, 5, 9, 13, 17].reduce((sum, index) => ({
    x: sum.x + landmarks[index].x / 5,
    y: sum.y + landmarks[index].y / 5
  }), { x: 0, y: 0 });
  return {
    wrist: landmarks[0], palm,
    size: Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
  };
}

export class CapturePolicy {
  constructor({ extractFeatures, config = {} }) {
    if (typeof extractFeatures !== 'function') throw new TypeError('Feature extraction is required.');
    this.extractFeatures = extractFeatures;
    this.config = { ...CAPTURE_CONFIG, ...config };
    this.state = 'WAITING';
    this.frames = [];
    this.readyCount = 0;
    this.finiteReadyCount = 0;
    this.previous = null;
    this.lastFrameId = -Infinity;
    this.lastObservedAt = -Infinity;
    this.active = false;
    this.legacy = false;
    this.lastCode = 'no_hand';
  }

  event(code, message, extra = {}) {
    this.lastCode = code;
    return { state: this.state, code, message, progress: this.frames.length, ...extra };
  }

  reject(code, message) {
    this.state = 'REJECTED';
    this.active = false;
    this.legacy = false;
    this.frames = [];
    this.readyCount = 0;
    this.finiteReadyCount = 0;
    this.previous = null;
    return this.event(code, message);
  }

  classify(result) {
    const image = result?.landmarks;
    const world = result?.worldLandmarks;
    if (!Array.isArray(image) || !Array.isArray(world)) return { code: 'invalid' };
    if (image.length > 1) return { code: 'multi_hand' };
    if (image.length === 0 && world.length === 0) return { code: 'no_hand' };
    if (image.length !== 1 || world.length !== 1) return { code: 'invalid' };
    if (result.handedness !== undefined && (!Array.isArray(result.handedness) || result.handedness.length !== 1)) return { code: 'invalid' };
    const nl = image[0], wl = world[0];
    if (!Array.isArray(nl) || !Array.isArray(wl) || nl.length !== 21 || wl.length !== 21 ||
        !nl.every(finitePoint) || !wl.every(finitePoint)) return { code: 'invalid' };
    const position = snapshot(nl);
    if (!(position.size > 0)) return { code: 'invalid' };
    let features;
    try { features = this.extractFeatures(wl); }
    catch { return { code: 'invalid' }; }
    if (!features || !Object.values(features).length || !Object.values(features).every(value => typeof value === 'number')) return { code: 'invalid' };
    return { code: 'valid', position, features, featuresFinite: Object.values(features).every(Number.isFinite), hand: { image: nl, world: wl } };
  }

  discontinuity(next) {
    if (!this.previous) return false;
    const ratio = next.size / this.previous.size;
    return distance(next.wrist, this.previous.wrist) > this.config.MAX_WRIST_JUMP ||
      distance(next.palm, this.previous.palm) > this.config.MAX_PALM_JUMP ||
      ratio > this.config.MAX_SIZE_RATIO || ratio < 1 / this.config.MAX_SIZE_RATIO;
  }

  observe(result, frameId, nowMs) {
    if (!Number.isFinite(frameId) || frameId <= this.lastFrameId ||
        !Number.isFinite(nowMs) || nowMs < this.lastObservedAt) {
      if (this.active) return this.reject('stale', 'Capture cancelled — camera frames stopped. Try again.');
      this.state = 'WAITING'; this.readyCount = 0; this.finiteReadyCount = 0; this.previous = null;
      return this.event('stale', 'Waiting for fresh camera frames.');
    }
    if (nowMs - this.lastObservedAt > this.config.MAX_FRAME_AGE_MS) {
      if (this.active) return this.reject('stale', 'Capture cancelled — camera frames stopped. Try again.');
      this.readyCount = 0; this.finiteReadyCount = 0; this.previous = null;
    }
    this.lastFrameId = frameId;
    this.lastObservedAt = nowMs;
    const seen = this.classify(result);
    if (seen.code !== 'valid') {
      const messages = {
        no_hand: ['Show one hand in the camera.', 'Capture cancelled — hand disappeared. Try again.'],
        multi_hand: ['Show only one hand.', 'Capture cancelled — another hand was detected. Try again.'],
        invalid: ['Hand landmarks incomplete. Reposition your hand.', 'Capture cancelled — hand detection was incomplete. Try again.']
      };
      if (this.active) return this.reject(seen.code, messages[seen.code][1]);
      this.state = 'WAITING'; this.readyCount = 0; this.finiteReadyCount = 0; this.previous = null;
      return this.event(seen.code, messages[seen.code][0]);
    }
    if (this.discontinuity(seen.position)) {
      if (this.active) return this.reject('continuity', 'Capture cancelled — hand position changed abruptly. Try again.');
      this.state = 'WAITING'; this.readyCount = 0; this.finiteReadyCount = 0; this.previous = null;
    }
    if (this.active) {
      if (!seen.featuresFinite && !this.legacy) return this.reject('invalid', 'Capture cancelled — hand features were invalid. Try again.');
      this.previous = seen.position;
      this.frames.push(seen.features);
      if (this.frames.length === this.config.CAPTURE_FRAMES) {
        const frames = this.frames;
        this.frames = []; this.readyCount = 0; this.finiteReadyCount = 0; this.previous = null; this.active = false; this.legacy = false;
        this.state = 'ACCEPTED';
        return this.event('accepted', 'Gesture capture complete.', { frames, hand: seen.hand, features: seen.features });
      }
      return this.event('capturing', 'Capturing: keep one hand steady.', { hand: seen.hand, features: seen.features });
    }
    this.previous = seen.position;
    this.readyCount++;
    this.finiteReadyCount = seen.featuresFinite ? this.finiteReadyCount + 1 : 0;
    this.state = this.finiteReadyCount >= this.config.READY_FRAMES ? 'SINGLE_HAND_READY' :
      this.readyCount >= this.config.READY_FRAMES ? 'LEGACY_READY' : 'WAITING';
    const message = this.state === 'SINGLE_HAND_READY' ? 'One hand ready. Press a capture button.' :
      this.state === 'LEGACY_READY' ? 'Pose features invalid for new capture. Reposition your hand; legacy decryption is available.' :
      'Hold one hand in view to get ready.';
    return this.event(this.state === 'SINGLE_HAND_READY' ? 'ready' : this.state === 'LEGACY_READY' ? 'legacy_ready' : 'waiting', message,
      { hand: seen.hand, features: seen.features });
  }

  start(nowMs, { legacy = false } = {}) {
    if (this.state !== 'SINGLE_HAND_READY' && !(legacy && this.state === 'LEGACY_READY')) {
      const message = this.lastCode === 'multi_hand' ? 'Show only one hand, then retry.' : 'Show one steady hand, then retry.';
      return this.reject('not_ready', message);
    }
    if (!Number.isFinite(nowMs) || nowMs < this.lastObservedAt || nowMs - this.lastObservedAt > this.config.MAX_FRAME_AGE_MS) {
      return this.reject('stale', 'Capture not started — camera frames are stale. Try again.');
    }
    this.state = 'CAPTURING'; this.active = true; this.legacy = legacy; this.frames = [];
    return this.event('capturing', 'Capturing: keep one hand steady.');
  }

  timeout() { return this.reject('timeout', 'Capture timed out. Show one hand and retry.'); }
  cameraError() { return this.reject('camera_error', 'Camera or hand model failed. Check access and retry.'); }
}
