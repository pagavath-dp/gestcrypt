const aborted = signal => signal.reason instanceof Error ? signal.reason : new Error('Camera initialization was cancelled.');

// Reject promptly on cancellation, including when a browser API cannot itself be aborted.
// A resource that arrives after cancellation is disposed by onLateValue.
export function awaitStartup(promise, signal, onLateValue = () => {}) {
  if (signal.aborted) {
    Promise.resolve(promise).then(value => { try { onLateValue(value); } catch {} }, () => {});
    return Promise.reject(aborted(signal));
  }
  return new Promise((resolve, reject) => {
    let active = true;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => { active = false; cleanup(); reject(aborted(signal)); };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(value => {
      if (!active) { try { onLateValue(value); } catch {} return; }
      cleanup(); resolve(value);
    }, error => {
      if (!active) return;
      cleanup(); reject(error);
    });
  });
}

export function waitForVideoMetadata(video, signal) {
  if (signal.aborted) return Promise.reject(aborted(signal));
  if (video.readyState >= 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', onMetadata);
      video.removeEventListener('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const onMetadata = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error('Camera video failed before metadata loaded.')); };
    const onAbort = () => { cleanup(); reject(aborted(signal)); };
    video.addEventListener('loadedmetadata', onMetadata, { once: true });
    video.addEventListener('error', onError, { once: true });
    signal.addEventListener('abort', onAbort, { once: true });
    if (video.readyState >= 1) onMetadata();
  });
}
