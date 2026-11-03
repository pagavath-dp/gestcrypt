// Connects VaultGestureService to the existing browser camera pipeline. The
// supplied functions are the same startup, fresh-readiness and CapturePolicy
// functions used by the study; this adapter does not run another frame loop.
export function createVaultCameraCapture({ ensureCamera, waitForFreshReadiness, capturePose }) {
  if (![ensureCamera, waitForFreshReadiness, capturePose].every(fn => typeof fn === 'function')) {
    throw new TypeError('Vault camera startup, readiness, and capture functions are required.');
  }
  return async function captureVaultFrames({ signal } = {}) {
    if (!signal || signal.aborted) throw signal?.reason || new Error('Vault capture was cancelled.');
    await ensureCamera({ signal });
    if (signal.aborted) throw signal.reason;
    await waitForFreshReadiness({ signal });
    if (signal.aborted) throw signal.reason;
    const frames = await capturePose({ legacy: false, signal });
    if (signal.aborted) throw signal.reason;
    return frames;
  };
}
