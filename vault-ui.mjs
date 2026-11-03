import { encryptV3, decryptV3Normal, decryptV3Recovery, rewrapV3 } from './vault-v3.mjs';

export const LEGACY_VAULT_MESSAGE = 'This file format is not supported by GestCrypt.';

export async function requireV3File(file) {
  if (!file || file.size < 5 || typeof file.slice !== 'function') throw new Error('Invalid or truncated GestCrypt file.');
  const prefix = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  if (prefix.length !== 5) throw new Error('Invalid or truncated GestCrypt file.');
  if ([71, 67, 82, 89].some((value, index) => prefix[index] !== value)) throw new Error('Not a GestCrypt file.');
  if (prefix[4] === 1 || prefix[4] === 2) throw new Error(LEGACY_VAULT_MESSAGE);
  if (prefix[4] !== 3) throw new Error(LEGACY_VAULT_MESSAGE);
  return file;
}

function safeMessage(error, operation) {
  const message = String(error?.message || '');
  if (message === LEGACY_VAULT_MESSAGE) return message;
  if (/^Choose a file|^Confirm the passphrase|^Finish or discard|^Back up the recovery key|^A recovery key is required/.test(message)) return message;
  if (/already enrolled/.test(message)) return 'A Vault gesture is already enrolled in this browser.';
  if (/Enroll a Vault gesture|not enrolled/.test(message)) return 'No Vault gesture is enrolled. Complete two matching enrollment captures first.';
  if (/did not match|ambiguous or unstable|incomplete or invalid/.test(message)) return 'Vault gesture mismatch or ambiguous capture. No Vault operation was performed.';
  if (/timed out|timeout/i.test(message)) return 'Camera readiness or capture timed out. No Vault operation was performed.';
  if (/cancelled|Page is closing/i.test(message)) return 'Vault capture cancelled. No Vault operation was performed.';
  if (/camera|media|permission|denied|video|model/i.test(message)) return 'Camera unavailable or permission denied. Check access and retry.';
  if (/device key is missing/i.test(message)) return 'This browser profile has no Vault device key. Set it up or use emergency recovery.';
  if (/device.key record is corrupt|device.key.*incompatible|device key changed/i.test(message)) return 'Vault device storage is corrupt or incompatible. Normal access is unavailable; use emergency recovery.';
  if (/original browser-profile key/i.test(message)) return 'This file needs its original browser profile for normal access. Use emergency recovery on this profile.';
  if (/nonce|transaction|database|IndexedDB|storage|blocked|counter/i.test(message)) return 'Vault storage or nonce reservation failed. No encrypted file was created.';
  if (/recovery|checksum|authentication failed/i.test(message)) return operation === 'recover' || operation === 'rebind'
    ? 'Recovery failed: incorrect recovery key or modified encrypted file. No plaintext was released.'
    : 'Authentication failed: incorrect passphrase or modified encrypted file. No plaintext was released.';
  if (/Invalid GestCrypt v3|Invalid or truncated|Not a GestCrypt|Unsupported GestCrypt/.test(message)) return 'Malformed or unsupported GestCrypt file. No plaintext was released.';
  if (/passphrase|filename|32 MiB|File exceeds/.test(message)) return 'Check the passphrase and file requirements, then retry.';
  return 'Vault operation failed safely. No file was downloaded.';
}

export class V3VaultUiController {
  constructor({ get, gestureService, deviceStore, download,
    crypto = { encryptV3, decryptV3Normal, decryptV3Recovery, rewrapV3 },
    clipboard = globalThis.navigator?.clipboard, confirmDiscard = message => globalThis.confirm(message),
    onBusy = () => {}, canStart = () => true } = {}) {
    if (![get, download].every(value => typeof value === 'function') || !gestureService || !deviceStore) {
      throw new TypeError('Vault UI dependencies are required.');
    }
    this.get = get;
    this.gestureService = gestureService;
    this.deviceStore = deviceStore;
    this.download = download;
    this.crypto = crypto;
    this.clipboard = clipboard;
    this.confirmDiscard = confirmDiscard;
    this.onBusy = onBusy;
    this.canStart = canStart;
    this.busy = false;
    this.enrollmentPending = false;
    this.pending = null;
    this.disposed = false;
  }

  #status(message) { this.get('status').textContent = message; }
  #enrollmentStatus(message) { this.get('vaultEnrollStatus').textContent = message; }
  #file() {
    const file = this.get('file').files[0];
    if (!file) throw new Error('Choose a file first.');
    return file;
  }
  #noPending() {
    if (this.pending) throw new Error('Finish or discard the pending encrypted file and recovery key first.');
  }
  #assertActive() {
    if (this.disposed) throw new Error('Vault page is closing.');
  }
  #clearCredentials() {
    this.get('passphrase').value = '';
    this.get('passphraseConfirm').value = '';
    this.get('vaultRecoveryInput').value = '';
  }
  #newPassphrase() {
    const value = this.get('passphrase').value;
    if (value !== this.get('passphraseConfirm').value) throw new Error('Confirm the passphrase: both entries must match.');
    if (Array.from(value).length < 12 || !value.trim() || new TextEncoder().encode(value).length > 1024) {
      throw new Error('New passphrase must be nonblank, at least 12 characters, and at most 1024 UTF-8 bytes.');
    }
    return value;
  }
  #stage(blob, name, recoveryCode) {
    this.#assertActive();
    if (!(blob instanceof Blob) || typeof recoveryCode !== 'string' || !recoveryCode) {
      throw new Error('Encrypted file output was incomplete.');
    }
    this.pending = { blob, name, recoveryCode, backupDone: false };
    this.get('vaultPendingFilename').textContent = 'Pending encrypted file: ' + name;
    this.get('vaultRecoveryCode').textContent = recoveryCode;
    this.get('vaultRecoverySaved').checked = false;
    this.get('vaultPending').classList.remove('hidden');
    this.updateControls();
  }
  #clearPending() {
    this.pending = null;
    this.get('vaultPendingFilename').textContent = '';
    this.get('vaultRecoveryCode').textContent = '';
    this.get('vaultRecoverySaved').checked = false;
    this.get('vaultPending').classList.add('hidden');
    this.onBusy(false);
    this.updateControls();
  }

  updateControls() {
    const blocked = this.disposed || this.busy || !!this.pending || !this.canStart();
    for (const id of ['file', 'passphrase', 'passphraseConfirm', 'vaultRecoveryInput']) {
      this.get(id).disabled = blocked;
    }
    for (const id of ['btnEnc', 'btnDec', 'btnVaultRecover', 'btnVaultRebind',
      'btnVaultInitDevice', 'btnVaultEnrollStart']) this.get(id).disabled = blocked ||
        (id === 'btnVaultEnrollStart' && this.enrollmentPending);
    this.get('btnVaultEnrollCapture').disabled = blocked || !this.enrollmentPending;
    this.get('btnVaultEnrollCancel').disabled = this.disposed || !this.enrollmentPending;
    this.get('btnVaultCopyRecovery').disabled = this.disposed || !this.pending || this.busy;
    this.get('btnVaultDownloadRecovery').disabled = this.disposed || !this.pending || this.busy;
    this.get('btnVaultDownloadPending').disabled = this.disposed || !this.pending || this.busy ||
      !this.pending.backupDone || !this.get('vaultRecoverySaved').checked;
    this.get('btnVaultDiscardPending').disabled = this.disposed || !this.pending || this.busy;
    this.get('vaultRecoverySaved').disabled = this.disposed || !this.pending;
  }

  async #task(operation, work) {
    if (this.disposed) return;
    if (this.busy || !this.canStart()) { this.#status('Finish the current operation before starting another.'); return; }
    this.busy = true;
    this.onBusy(true);
    this.updateControls();
    try { await work(); }
    catch (error) { this.#status(safeMessage(error, operation)); }
    finally {
      this.#clearCredentials();
      this.busy = false;
      this.onBusy(!!this.pending);
      this.updateControls();
    }
  }

  async setupDevice() {
    return this.#task('setup', async () => {
      this.#noPending();
      try { await this.deviceStore.openDevice(); this.#status('This browser profile already has its Vault device key.'); }
      catch (error) {
        if (!/device key is missing/i.test(error.message)) throw error;
        await this.deviceStore.createDevice();
        this.#status('Local non-extractable Vault device key created for this browser profile.');
      }
    });
  }

  async startEnrollment() {
    return this.#task('enroll', async () => {
      this.#noPending();
      await this.gestureService.startEnrollment();
      this.enrollmentPending = true;
      this.#enrollmentStatus('Enrollment started. Start the first capture, then start a separate matching second capture.');
    });
  }

  async captureEnrollmentStep() {
    return this.#task('enroll', async () => {
      if (!this.enrollmentPending) throw new Error('Start enrollment first.');
      try {
        const result = await this.gestureService.captureEnrollmentStep();
        if (result.complete) {
          this.enrollmentPending = false;
          this.#enrollmentStatus('Vault gesture enrolled in this browser. Its signature is not displayed or exported.');
        } else this.#enrollmentStatus('First capture accepted. Start a separate second capture of the same gesture.');
      } catch (error) {
        this.enrollmentPending = false;
        this.#enrollmentStatus('Enrollment failed or cancelled. No partial template was saved.');
        throw error;
      }
    });
  }

  cancelEnrollment() {
    if (this.gestureService.cancelEnrollment() === false) {
      this.#enrollmentStatus('Enrollment save is finishing; wait for its result.');
      return;
    }
    this.enrollmentPending = false;
    this.#enrollmentStatus('Enrollment cancelled. No partial template was saved.');
    this.updateControls();
  }

  async encrypt() {
    return this.#task('encrypt', async () => {
      this.#noPending();
      const file = this.#file();
      const passphrase = this.#newPassphrase();
      const device = await this.deviceStore.openDevice();
      this.#status('Verify your enrolled Vault gesture to encrypt this file.');
      const output = await this.gestureService.verifyAndRun('encrypt',
        () => this.crypto.encryptV3(file, passphrase, device));
      try { this.#stage(output.blob, file.name + '.gcry', output.recoveryCode); }
      finally { output.recoveryKey?.fill(0); }
      this.#status('File encrypted. Back up and acknowledge its one-time recovery key before downloading the encrypted file.');
    });
  }

  async decrypt() {
    return this.#task('decrypt', async () => {
      this.#noPending();
      const file = await requireV3File(this.#file()); // Before credentials, camera, or PBKDF2.
      const device = await this.deviceStore.openDevice();
      const passphrase = this.get('passphrase').value;
      if (!passphrase) throw new Error('A passphrase is required.');
      this.#status('Verify your enrolled Vault gesture to decrypt this file.');
      const output = await this.gestureService.verifyAndRun('decrypt',
        () => this.crypto.decryptV3Normal(file, passphrase, device));
      this.#assertActive();
      this.download(output.blob, output.name);
      this.#status('Authenticated file recovered: ' + output.name);
    });
  }

  async recover() {
    return this.#task('recover', async () => {
      this.#noPending();
      const file = await requireV3File(this.#file());
      const code = this.get('vaultRecoveryInput').value.trim();
      if (!code) throw new Error('A recovery key is required.');
      const output = await this.crypto.decryptV3Recovery(file, code);
      this.#assertActive();
      this.download(output.blob, output.name);
      this.#status('Authenticated file recovered with its file-specific recovery key: ' + output.name);
    });
  }

  async rebind() {
    return this.#task('rebind', async () => {
      this.#noPending();
      const file = await requireV3File(this.#file());
      const code = this.get('vaultRecoveryInput').value.trim();
      if (!code) throw new Error('A recovery key is required.');
      const passphrase = this.#newPassphrase();
      const device = await this.deviceStore.openDevice();
      const output = await this.crypto.rewrapV3(file, { recoveryCode: code }, passphrase, device,
        { rotateRecoveryKey: true });
      try { this.#stage(output.blob, file.name.replace(/\.gcry$/i, '') + '.rebound.gcry', output.recoveryCode); }
      finally { output.recoveryKey?.fill(0); }
      this.#status('Authenticated file rebound to this profile. The original remains unchanged. Back up and acknowledge the new file-specific recovery key before downloading the rebound file.');
    });
  }

  async copyRecoveryKey() {
    if (this.disposed || !this.pending) return;
    const pending = this.pending;
    try {
      if (typeof this.clipboard?.writeText !== 'function') throw new Error('Clipboard unavailable');
      await this.clipboard.writeText(pending.recoveryCode);
      if (this.disposed || this.pending !== pending) return; // A late clipboard result belongs only to its original file.
      pending.backupDone = true;
      this.#status('Recovery key copied. Save it securely, then acknowledge that you saved it.');
    } catch { if (this.pending === pending) this.#status('Copy failed. Use the recovery-key backup download instead.'); }
    this.updateControls();
  }

  downloadRecoveryKey() {
    if (this.disposed || !this.pending) return;
    try {
      this.download(new Blob([this.pending.recoveryCode + '\n'], { type: 'text/plain' }),
        this.pending.name + '.recovery-key.txt');
      this.pending.backupDone = true;
      this.#status('Recovery-key backup download requested. Confirm it was saved before downloading the encrypted file.');
    } catch { this.#status('Recovery-key backup failed. The encrypted-file download remains blocked.'); }
    this.updateControls();
  }

  downloadPending() {
    if (this.disposed) return;
    if (!this.pending || !this.pending.backupDone || !this.get('vaultRecoverySaved').checked) {
      this.#status('Back up the recovery key and check “I saved this file’s recovery key” first.');
      return;
    }
    try {
      this.download(this.pending.blob, this.pending.name);
      this.#clearPending();
      this.#status('Encrypted file download requested. The recovery key is no longer shown here.');
    } catch { this.#status('Encrypted-file download failed. The pending file and recovery key remain available.'); }
  }

  discardPending() {
    if (this.disposed || !this.pending) return;
    if (!this.confirmDiscard('Discard the pending encrypted file and its one-time recovery-key display?')) return;
    this.#clearPending();
    this.#status('Pending encrypted file discarded. No Vault file was downloaded.');
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.gestureService.dispose();
    this.#clearPending();
    this.#clearCredentials();
    this.enrollmentPending = false;
  }

  bind() {
    const handlers = {
      btnVaultInitDevice: () => this.setupDevice(), btnVaultEnrollStart: () => this.startEnrollment(),
      btnVaultEnrollCapture: () => this.captureEnrollmentStep(), btnVaultEnrollCancel: () => this.cancelEnrollment(),
      btnEnc: () => this.encrypt(), btnDec: () => this.decrypt(),
      btnVaultRecover: () => this.recover(), btnVaultRebind: () => this.rebind(),
      btnVaultCopyRecovery: () => this.copyRecoveryKey(),
      btnVaultDownloadRecovery: () => this.downloadRecoveryKey(),
      btnVaultDownloadPending: () => this.downloadPending(),
      btnVaultDiscardPending: () => this.discardPending()
    };
    for (const [id, handler] of Object.entries(handlers)) this.get(id).onclick = handler;
    this.get('vaultRecoverySaved').onchange = () => this.updateControls();
    this.updateControls();
  }
}
