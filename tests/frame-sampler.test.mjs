import test from 'node:test';
import assert from 'node:assert/strict';
import { DecodedFrameSampler } from '../frame-sampler.mjs';

function callbacks() {
  const pending = new Map();
  let nextId = 0;
  return {
    pending,
    request(callback) { const id = ++nextId; pending.set(id, callback); return id; },
    cancel(id) { pending.delete(id); },
    fire(...args) {
      const [id, callback] = pending.entries().next().value;
      pending.delete(id);
      callback(...args);
    }
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('video-frame callback counts each presented frame once and skips duplicates', async () => {
  const queue = callbacks(), seen = [], errors = [];
  const video = { requestVideoFrameCallback: callback => queue.request(callback),
    cancelVideoFrameCallback: id => queue.cancel(id) };
  const sampler = new DecodedFrameSampler(video, { onFrame: id => seen.push(id), onError: e => errors.push(e) });
  sampler.start();
  for (const id of [1, 1, 2, 2, 5]) { queue.fire(0, { presentedFrames: id }); await flush(); }
  assert.deepEqual(seen, [1, 2, 5]);
  assert.deepEqual(errors, []);
  sampler.stop();
  assert.equal(queue.pending.size, 0);
});

test('a second inference is not scheduled until the previous one finishes', async () => {
  const queue = callbacks();
  let finish, calls = 0;
  const video = { requestVideoFrameCallback: callback => queue.request(callback),
    cancelVideoFrameCallback: id => queue.cancel(id) };
  const sampler = new DecodedFrameSampler(video, {
    onFrame: () => { calls++; return new Promise(resolve => { finish = resolve; }); },
    onError: error => { throw error; }
  });
  sampler.start();
  queue.fire(0, { presentedFrames: 1 });
  assert.equal(queue.pending.size, 0);
  assert.equal(calls, 1);
  finish(); await flush();
  assert.equal(queue.pending.size, 1);
  sampler.stop();
  assert.equal(queue.pending.size, 0);
});

test('fallback uses displayed-frame count, never playback time, and cancels polling', async () => {
  const queue = callbacks(), seen = [];
  let count = 0;
  const video = { getVideoPlaybackQuality: () => ({ totalVideoFrames: count }) };
  const sampler = new DecodedFrameSampler(video, {
    onFrame: id => seen.push(id), onError: error => { throw error; },
    requestFrame: callback => queue.request(callback), cancelFrame: id => queue.cancel(id)
  });
  sampler.start();
  for (count of [0, 1, 1, 2]) { queue.fire(); await flush(); }
  assert.deepEqual(seen, [1, 2]);
  sampler.stop();
  assert.equal(queue.pending.size, 0);
});

test('missing or invalid frame counters fail closed and clear pending callbacks', async () => {
  assert.throws(() => new DecodedFrameSampler({}, { onFrame() {}, onError() {} }).start(), /cannot identify/);
  const queue = callbacks(), errors = [];
  const video = { requestVideoFrameCallback: callback => queue.request(callback),
    cancelVideoFrameCallback: id => queue.cancel(id) };
  const sampler = new DecodedFrameSampler(video, { onFrame() { throw new Error('model failed'); }, onError: e => errors.push(e) });
  sampler.start(); queue.fire(0, { presentedFrames: NaN }); await flush();
  assert.equal(sampler.running, false);
  assert.equal(queue.pending.size, 0);
  assert.match(errors[0].message, /decoded-frame counter/);
});

test('inference failure stops sampling and a stopped in-flight inference cannot reschedule', async () => {
  const queue = callbacks(), errors = [];
  const video = { requestVideoFrameCallback: callback => queue.request(callback),
    cancelVideoFrameCallback: id => queue.cancel(id) };
  const failing = new DecodedFrameSampler(video, {
    onFrame: () => { throw new Error('model failed'); }, onError: error => errors.push(error)
  });
  failing.start(); queue.fire(0, { presentedFrames: 1 }); await flush();
  assert.equal(failing.running, false);
  assert.equal(queue.pending.size, 0);
  assert.equal(errors[0].message, 'model failed');

  let finish;
  const stopped = new DecodedFrameSampler(video, {
    onFrame: () => new Promise(resolve => { finish = resolve; }), onError: error => errors.push(error)
  });
  stopped.start(); queue.fire(0, { presentedFrames: 2 });
  stopped.stop(); finish(); await flush();
  assert.equal(queue.pending.size, 0);
});
