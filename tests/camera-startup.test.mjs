import test from 'node:test';
import assert from 'node:assert/strict';
import { awaitStartup, waitForVideoMetadata } from '../camera-startup.mjs';

class Video extends EventTarget {
  readyState = 0;
  listeners = new Map();
  addEventListener(type, listener, options) {
    this.listeners.set(type, (this.listeners.get(type) ?? 0) + 1);
    super.addEventListener(type, listener, options);
  }
  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? 0) - 1);
    super.removeEventListener(type, listener);
  }
}
const assertClean = video => {
  assert.equal(video.listeners.get('loadedmetadata'), 0);
  assert.equal(video.listeners.get('error'), 0);
};

test('metadata success and already-loaded video leave no startup listeners', async () => {
  const video = new Video(), controller = new AbortController();
  const pending = waitForVideoMetadata(video, controller.signal);
  video.readyState = 1;
  video.dispatchEvent(new Event('loadedmetadata'));
  await pending;
  assertClean(video);
  await waitForVideoMetadata(video, controller.signal);
  assertClean(video);
});

test('video error and cancellation reject metadata wait and remove listeners', async () => {
  const failed = new Video(), first = new AbortController();
  const onError = waitForVideoMetadata(failed, first.signal);
  failed.dispatchEvent(new Event('error'));
  await assert.rejects(onError, /video failed/);
  assertClean(failed);

  const cancelled = new Video(), second = new AbortController();
  const onAbort = waitForVideoMetadata(cancelled, second.signal);
  second.abort(new Error('Camera stream ended.'));
  await assert.rejects(onAbort, /stream ended/);
  assertClean(cancelled);
  cancelled.dispatchEvent(new Event('loadedmetadata'));
});

test('cancellation rejects an in-flight media request and stops a late stream', async () => {
  let supplyStream;
  const media = new Promise(resolve => { supplyStream = resolve; });
  const controller = new AbortController();
  let stops = 0;
  const pending = awaitStartup(media, controller.signal, stream => stream.getTracks().forEach(track => track.stop()));
  controller.abort(new Error('Camera initialization timed out.'));
  await assert.rejects(pending, /timed out/);
  supplyStream({ getTracks: () => [{ stop: () => { stops++; } }] });
  await Promise.resolve();
  assert.equal(stops, 1);
});

test('late model resource is closed after cancellation', async () => {
  let supplyModel, closes = 0;
  const model = new Promise(resolve => { supplyModel = resolve; });
  const controller = new AbortController();
  const pending = awaitStartup(model, controller.signal, value => value.close());
  controller.abort(new Error('Camera initialization was cancelled.'));
  await assert.rejects(pending, /cancelled/);
  supplyModel({ close: () => { closes++; } });
  await Promise.resolve();
  assert.equal(closes, 1);
});
