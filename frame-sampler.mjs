// Schedule one inference per decoded video frame. A browser without a frame
// counter cannot safely provide capture samples, so it is not used as fallback.
export class DecodedFrameSampler {
  constructor(video, { onFrame, onError, requestFrame = globalThis.requestAnimationFrame,
    cancelFrame = globalThis.cancelAnimationFrame }) {
    this.video = video;
    this.onFrame = onFrame;
    this.onError = onError;
    this.requestFrame = requestFrame;
    this.cancelFrame = cancelFrame;
    this.running = false;
    this.pending = null;
    this.lastFrameId = -1;
    this.mode = null;
  }

  start() {
    if (this.running) return;
    if (typeof this.video.requestVideoFrameCallback === 'function' &&
        typeof this.video.cancelVideoFrameCallback === 'function') this.mode = 'video';
    else if (typeof this.video.getVideoPlaybackQuality === 'function' &&
             Number.isSafeInteger(this.video.getVideoPlaybackQuality()?.totalVideoFrames)) this.mode = 'quality';
    else throw new Error('This browser cannot identify decoded camera frames. Use a current Chrome browser.');
    this.running = true;
    this.schedule();
  }

  stop() {
    this.running = false;
    if (this.pending !== null) {
      if (this.mode === 'video') this.video.cancelVideoFrameCallback(this.pending);
      else this.cancelFrame(this.pending);
      this.pending = null;
    }
  }

  fail(error) {
    if (!this.running) return;
    this.stop();
    this.onError(error);
  }

  schedule() {
    if (!this.running) return;
    try {
      if (this.mode === 'video') {
        this.pending = this.video.requestVideoFrameCallback((_, metadata) => {
          this.pending = null;
          this.accept(metadata?.presentedFrames);
        });
      } else {
        this.pending = this.requestFrame(() => {
          this.pending = null;
          try { this.accept(this.video.getVideoPlaybackQuality()?.totalVideoFrames); }
          catch (error) { this.fail(error); }
        });
      }
    } catch (error) { this.fail(error); }
  }

  accept(frameId) {
    if (!this.running) return;
    if (!Number.isSafeInteger(frameId) || frameId < 0) {
      this.fail(new Error('The camera did not provide a valid decoded-frame counter.'));
      return;
    }
    if (frameId === 0) { this.schedule(); return; }
    if (frameId <= this.lastFrameId) { this.schedule(); return; }
    this.lastFrameId = frameId;
    let work;
    try { work = this.onFrame(frameId); }
    catch (error) { this.fail(error); return; }
    Promise.resolve(work).then(() => this.schedule(), error => this.fail(error));
  }
}
