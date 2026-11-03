// A button press may follow a blocking browser dialog. Wait for a processed
// observation after that press before trusting the capture policy's readiness.
export class FreshReadinessWait {
  constructor({ afterMs, maxAgeMs, timeoutMs, now = () => performance.now(),
    setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimer = id => globalThis.clearTimeout(id) }) {
    this.afterMs = afterMs;
    this.maxAgeMs = maxAgeMs;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.pending = null;
    this.timer = null;
  }

  wait() {
    if (this.pending) throw new Error('A readiness wait is already active.');
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.timer = this.setTimer(() => this.cancel(
        'Fresh single-hand readiness was not reached in time. Reposition your hand and retry.', 'not_ready'), this.timeoutMs);
    });
  }

  observe(event, observedAt) {
    if (!this.pending || event?.state !== 'SINGLE_HAND_READY' || event.code !== 'ready' ||
        !Number.isFinite(observedAt) || observedAt <= this.afterMs ||
        this.now() - observedAt > this.maxAgeMs) return false;
    const { resolve } = this.pending;
    this.cleanup();
    resolve();
    return true;
  }

  cancel(message, code = 'camera_error') {
    if (!this.pending) return false;
    const { reject } = this.pending;
    this.cleanup();
    const error = new Error(message);
    error.code = code;
    reject(error);
    return true;
  }

  cleanup() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.pending = null;
  }
}
