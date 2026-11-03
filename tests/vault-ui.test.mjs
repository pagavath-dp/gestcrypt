import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { V3VaultUiController, LEGACY_VAULT_MESSAGE } from '../vault-ui.mjs';

const text = value => new TextEncoder().encode(value);
const vaultFile = (version = 3) => new File([new Uint8Array([...text('GCRY'), version, 0, 0])], 'input.gcry');
const deferred = () => { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject }; };

function harness({ file = new File([text('hello')], 'hello.txt'),
  clipboardFails = false, clipboardGate = null, gestureError = null, deviceError = null, crypto = {} } = {}) {
  const ids = ['file', 'passphrase', 'passphraseConfirm', 'vaultRecoveryInput', 'vaultRecoveryCode',
    'vaultPendingFilename',
    'vaultRecoverySaved', 'vaultPending', 'vaultEnrollStatus', 'status', 'btnVaultInitDevice',
    'btnVaultEnrollStart', 'btnVaultEnrollCapture', 'btnVaultEnrollCancel', 'btnEnc', 'btnDec',
    'btnVaultRecover', 'btnVaultRebind', 'btnVaultCopyRecovery', 'btnVaultDownloadRecovery',
    'btnVaultDownloadPending', 'btnVaultDiscardPending'];
  const elements = Object.fromEntries(ids.map(id => [id, { value: '', textContent: '', checked: false,
    disabled: false, classList: { hidden: id === 'vaultPending', add() { this.hidden = true; },
      remove() { this.hidden = false; } } }]));
  elements.file.files = [file];
  elements.passphrase.value = 'test passphrase';
  const downloads = [], calls = { captures: [], crypto: [], device: 0, clipboard: [], busy: [], cancelled: 0 };
  let enrollmentStep = 0;
  const gestureService = {
    store: { async read() { return null; } },
    async startEnrollment() { enrollmentStep = 0; return { nextCapture: 1 }; },
    async captureEnrollmentStep() { enrollmentStep++; return enrollmentStep === 1
      ? { complete: false, nextCapture: 2 } : { complete: true }; },
    cancelEnrollment() { calls.cancelled++; },
    dispose() { calls.cancelled++; },
    async verifyAndRun(operation, action) {
      calls.captures.push(operation);
      if (gestureError) throw gestureError;
      return action();
    }
  };
  const deviceStore = {
    async openDevice() { calls.device++; if (deviceError) throw deviceError; return { key: 'device' }; },
    async createDevice() { calls.device++; return { key: 'device' }; }
  };
  const implementation = {
    async encryptV3(input, passphrase, device) {
      calls.crypto.push(['encrypt', input, passphrase, device]);
      return { blob: new Blob([text('ciphertext')]), recoveryCode: 'FILE-RECOVERY-CODE',
        recoveryKey: new Uint8Array(32).fill(7) };
    },
    async decryptV3Normal(input, passphrase, device) {
      calls.crypto.push(['normal', input, passphrase, device]);
      return { blob: new Blob([text('plaintext')]), name: 'secret.txt' };
    },
    async decryptV3Recovery(input, code) {
      calls.crypto.push(['recovery', input, code]);
      return { blob: new Blob([text('plaintext')]), name: 'secret.txt' };
    },
    async rewrapV3(input, unlock, passphrase, device, options) {
      calls.crypto.push(['rebind', input, unlock, passphrase, device, options]);
      return { blob: new Blob([text('rebound ciphertext')]), name: 'secret.txt',
        recoveryCode: 'NEW-RECOVERY-CODE', recoveryKey: new Uint8Array(32).fill(8) };
    }, ...crypto
  };
  const controller = new V3VaultUiController({ get: id => elements[id], gestureService,
    deviceStore, crypto: implementation, download: (blob, name) => downloads.push({ blob, name }),
    clipboard: { async writeText(value) {
      if (clipboardGate) await clipboardGate;
      if (clipboardFails) throw new Error('denied');
      calls.clipboard.push(value);
    } },
    confirmDiscard: () => true, onBusy: value => calls.busy.push(value) });
  controller.bind();
  return { controller, elements, downloads, calls };
}

test('V3 Vault markup and visible handlers contain no legacy decrypt action', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const pane = html.slice(html.indexOf('<div id="paneMain"'), html.indexOf('<div id="paneTest"'));
  assert.match(pane, /Normal access requires your enrolled gesture/);
  assert.doesNotMatch(pane, /\bV[123]\b/i);
  assert.match(pane, /btnVaultEnrollStart/);
  assert.match(pane, /btnVaultRecover/);
  assert.match(pane, /btnVaultRebind/);
  assert.match(html, /vaultUi\.bind\(\)/);
  assert.match(html, /btnEnc"\)\.onclick = \(\) => status\("Vault is not ready/);
  assert.doesNotMatch(pane, /Legacy v1 PIN|Older v1 files still require/);
});

test('two explicit enrollment actions precede normal V3 encryption and recovery-key gate', async () => {
  const ui = harness();
  await ui.elements.btnVaultEnrollStart.onclick();
  await ui.elements.btnVaultEnrollCapture.onclick();
  assert.match(ui.elements.vaultEnrollStatus.textContent, /First capture accepted/);
  await ui.elements.btnVaultEnrollCapture.onclick();
  assert.match(ui.elements.vaultEnrollStatus.textContent, /enrolled/);
  ui.elements.passphrase.value = 'long valid passphrase';
  ui.elements.passphraseConfirm.value = 'long valid passphrase';
  await ui.elements.btnEnc.onclick();
  assert.deepEqual(ui.calls.captures, ['encrypt']);
  assert.deepEqual(ui.calls.crypto.map(item => item[0]), ['encrypt']);
  assert.equal(ui.downloads.length, 0, 'encrypted file is held pending backup');
  assert.equal(ui.elements.vaultRecoveryCode.textContent, 'FILE-RECOVERY-CODE');
  assert.equal(ui.elements.vaultPendingFilename.textContent, 'Pending encrypted file: hello.txt.gcry');
  assert.equal(ui.elements.file.disabled, true);
  assert.equal(ui.elements.btnVaultDownloadPending.disabled, true);
  assert.equal(ui.calls.busy.at(-1), true, 'pending recovery backup keeps navigation locked');
  ui.controller.downloadPending();
  assert.equal(ui.downloads.length, 0);
  await ui.elements.btnVaultCopyRecovery.onclick();
  assert.deepEqual(ui.calls.clipboard, ['FILE-RECOVERY-CODE']);
  assert.equal(ui.elements.btnVaultDownloadPending.disabled, true, 'copy alone is not acknowledgement');
  ui.elements.vaultRecoverySaved.checked = true;
  ui.elements.vaultRecoverySaved.onchange();
  assert.equal(ui.elements.btnVaultDownloadPending.disabled, false);
  ui.elements.btnVaultDownloadPending.onclick();
  assert.equal(ui.downloads.length, 1);
  assert.equal(ui.downloads[0].name, 'hello.txt.gcry');
  assert.equal(ui.elements.vaultRecoveryCode.textContent, '');
  assert.equal(ui.elements.vaultPendingFilename.textContent, '');
  assert.equal(ui.elements.file.disabled, false);
  assert.equal(ui.controller.pending, null);
  assert.equal(ui.calls.busy.at(-1), false);
  assert.equal(ui.elements.passphrase.value, '');
});

test('each normal decrypt requests another fresh gesture and only authenticated plaintext downloads', async () => {
  const ui = harness({ file: vaultFile() });
  ui.elements.passphrase.value = 'correct passphrase';
  await ui.elements.btnDec.onclick();
  ui.elements.passphrase.value = 'correct passphrase';
  await ui.elements.btnDec.onclick();
  assert.deepEqual(ui.calls.captures, ['decrypt', 'decrypt']);
  assert.deepEqual(ui.calls.crypto.map(item => item[0]), ['normal', 'normal']);
  assert.equal(ui.downloads.length, 2);
  assert.equal(await ui.downloads[0].blob.text(), 'plaintext');
});

test('V1 and V2 are rejected with exact text before device, gesture, credentials or KDF', async () => {
  for (const version of [1, 2]) {
    const ui = harness({ file: vaultFile(version) });
    ui.elements.passphrase.value = 'entered but unread';
    await ui.elements.btnDec.onclick();
    assert.equal(ui.elements.status.textContent, LEGACY_VAULT_MESSAGE);
    assert.equal(ui.calls.device, 0);
    assert.deepEqual(ui.calls.captures, []);
    assert.deepEqual(ui.calls.crypto, []);
    assert.equal(ui.downloads.length, 0);
  }
});

test('emergency recovery needs neither camera, passphrase nor original device profile', async () => {
  const ui = harness({ file: vaultFile(), deviceError: new Error('Vault device key is missing.') });
  ui.elements.vaultRecoveryInput.value = 'FILE-RECOVERY-CODE';
  await ui.elements.btnVaultRecover.onclick();
  assert.deepEqual(ui.calls.captures, []);
  assert.equal(ui.calls.device, 0);
  assert.deepEqual(ui.calls.crypto.map(item => item[0]), ['recovery']);
  assert.equal(ui.downloads.length, 1);
  assert.equal(await ui.downloads[0].blob.text(), 'plaintext');
  assert.equal(ui.elements.vaultRecoveryInput.value, '');
});

test('rebind keeps original input and rotates recovery key, requiring new backup and acknowledgement', async () => {
  const file = vaultFile(), ui = harness({ file });
  ui.elements.vaultRecoveryInput.value = 'FILE-RECOVERY-CODE';
  ui.elements.passphrase.value = 'new long passphrase';
  ui.elements.passphraseConfirm.value = 'new long passphrase';
  await ui.elements.btnVaultRebind.onclick();
  assert.equal(ui.calls.crypto[0][0], 'rebind');
  assert.equal(ui.calls.crypto[0][1], file);
  assert.deepEqual(ui.calls.crypto[0][2], { recoveryCode: 'FILE-RECOVERY-CODE' });
  assert.deepEqual(ui.calls.crypto[0][5], { rotateRecoveryKey: true });
  assert.equal(ui.calls.captures.length, 0);
  assert.equal(ui.downloads.length, 0);
  assert.equal(ui.elements.vaultRecoveryCode.textContent, 'NEW-RECOVERY-CODE');
  ui.elements.btnVaultDownloadRecovery.onclick();
  assert.equal(ui.downloads[0].name, 'input.rebound.gcry.recovery-key.txt');
  assert.equal(ui.elements.btnVaultDownloadPending.disabled, true);
  ui.elements.vaultRecoverySaved.checked = true;
  ui.elements.vaultRecoverySaved.onchange();
  ui.elements.btnVaultDownloadPending.onclick();
  assert.equal(ui.downloads[1].name, 'input.rebound.gcry');
  assert.equal(ui.elements.vaultRecoveryCode.textContent, '');
  assert.equal(ui.elements.file.files[0], file, 'original selected file is never overwritten');
});

test('failed gesture, camera, device and authentication paths never download output', async () => {
  for (const error of [new Error('Enroll a Vault gesture before normal access.'),
    new Error('Vault gesture did not match.'), new Error('Vault gesture capture was rejected as ambiguous or unstable.'),
    new Error('Camera permission denied.')]) {
    const ui = harness({ file: vaultFile(), gestureError: error });
    await ui.elements.btnDec.onclick();
    assert.equal(ui.downloads.length, 0);
    assert.equal(ui.calls.crypto.length, 0);
  }
  const missing = harness({ deviceError: new Error('Vault device key is missing.') });
  await missing.elements.btnEnc.onclick();
  assert.equal(missing.downloads.length, 0);
  assert.equal(missing.calls.captures.length, 0);
  const tampered = harness({ file: vaultFile(), crypto: {
    decryptV3Normal: async () => { throw new Error('V3 authentication failed: wrong credentials or modified file.'); }
  } });
  await tampered.elements.btnDec.onclick();
  assert.equal(tampered.downloads.length, 0);
  assert.match(tampered.elements.status.textContent, /No plaintext was released/);
  const badRecovery = harness({ file: vaultFile(), crypto: {
    decryptV3Recovery: async () => { throw new Error('Invalid V3 recovery-key checksum.'); }
  } });
  badRecovery.elements.vaultRecoveryInput.value = 'wrong';
  await badRecovery.elements.btnVaultRecover.onclick();
  assert.equal(badRecovery.downloads.length, 0);
  assert.match(badRecovery.elements.status.textContent, /Recovery failed/);
});

test('copy failure, pending output and camera cancellation remain fail closed', async () => {
  const ui = harness({ clipboardFails: true });
  ui.elements.passphrase.value = 'long valid passphrase';
  ui.elements.passphraseConfirm.value = 'long valid passphrase';
  await ui.elements.btnEnc.onclick();
  await ui.elements.btnVaultCopyRecovery.onclick();
  ui.elements.vaultRecoverySaved.checked = true;
  ui.elements.vaultRecoverySaved.onchange();
  assert.equal(ui.elements.btnVaultDownloadPending.disabled, true);
  ui.controller.downloadPending();
  assert.equal(ui.downloads.length, 0);
  await ui.controller.encrypt();
  assert.equal(ui.calls.crypto.length, 1, 'a pending file cannot be replaced');
  ui.elements.btnVaultEnrollCancel.onclick();
  assert.equal(ui.calls.cancelled, 1);
  ui.elements.btnVaultDiscardPending.onclick();
  assert.equal(ui.controller.pending, null);
});

test('late clipboard success cannot acknowledge a different generated file', async () => {
  const gate = deferred();
  let count = 0;
  const ui = harness({ clipboardGate: gate.promise, crypto: {
    async encryptV3() {
      count++;
      return { blob: new Blob([text('ciphertext-' + count)]), recoveryCode: 'RECOVERY-' + count,
        recoveryKey: new Uint8Array(32) };
    }
  } });
  const prepare = () => {
    ui.elements.passphrase.value = 'long valid passphrase';
    ui.elements.passphraseConfirm.value = 'long valid passphrase';
  };
  prepare(); await ui.controller.encrypt();
  const oldCopy = ui.controller.copyRecoveryKey();
  ui.controller.discardPending();
  prepare(); await ui.controller.encrypt();
  assert.equal(ui.controller.pending.recoveryCode, 'RECOVERY-2');
  ui.elements.vaultRecoverySaved.checked = true;
  gate.resolve(); await oldCopy;
  assert.equal(ui.controller.pending.backupDone, false);
  assert.equal(ui.elements.btnVaultDownloadPending.disabled, true);
  ui.controller.downloadPending();
  assert.equal(ui.downloads.length, 0);
  ui.controller.downloadRecoveryKey();
  assert.equal(await ui.downloads[0].blob.text(), 'RECOVERY-2\n');
  assert.equal(ui.elements.btnVaultDownloadPending.disabled, false);
});

test('acknowledgement and file selection are reset or locked per operation', async () => {
  let count = 0;
  const ui = harness({ crypto: { async encryptV3() {
    count++;
    return { blob: new Blob([text('ciphertext-' + count)]), recoveryCode: 'CODE-' + count,
      recoveryKey: new Uint8Array(32) };
  } } });
  for (let round = 1; round <= 2; round++) {
    ui.elements.passphrase.value = 'long valid passphrase';
    ui.elements.passphraseConfirm.value = 'long valid passphrase';
    await ui.controller.encrypt();
    assert.equal(ui.elements.file.disabled, true);
    assert.equal(ui.elements.vaultRecoverySaved.checked, false);
    assert.equal(ui.controller.pending.backupDone, false);
    assert.equal(ui.elements.btnVaultDownloadPending.disabled, true);
    ui.controller.downloadRecoveryKey();
    ui.elements.vaultRecoverySaved.checked = true;
    ui.elements.vaultRecoverySaved.onchange();
    ui.controller.downloadPending();
    assert.equal(ui.elements.file.disabled, false);
  }
  assert.equal(count, 2);
  assert.equal(ui.downloads.filter(item => item.name === 'hello.txt.gcry').length, 2);
  assert.notEqual(await ui.downloads[0].blob.text(), await ui.downloads[2].blob.text());
});

test('duplicate submissions and disposal cannot create or reveal late output', async () => {
  const gate = deferred();
  const output = { blob: new Blob([text('ciphertext')]), recoveryCode: 'LATE-CODE',
    recoveryKey: new Uint8Array(32).fill(9) };
  const ui = harness({ crypto: { encryptV3: () => gate.promise } });
  ui.elements.passphrase.value = 'long valid passphrase';
  ui.elements.passphraseConfirm.value = 'long valid passphrase';
  const first = ui.controller.encrypt();
  const second = ui.controller.encrypt();
  await second;
  assert.equal(ui.calls.captures.length, 1, 'a second click cannot start another capture');
  ui.controller.dispose();
  gate.resolve(output);
  await first;
  assert.equal(ui.controller.pending, null);
  assert.equal(ui.elements.vaultRecoveryCode.textContent, '');
  assert.equal(ui.downloads.length, 0);
  assert.equal(ui.elements.btnEnc.disabled, true);
  assert.deepEqual(output.recoveryKey, new Uint8Array(32), 'returned raw key is wiped after late result');
});

test('enrollment UI does not claim cancellation after template save begins', () => {
  const ui = harness();
  ui.controller.enrollmentPending = true;
  ui.controller.gestureService.cancelEnrollment = () => false;
  ui.controller.cancelEnrollment();
  assert.equal(ui.controller.enrollmentPending, true);
  assert.match(ui.elements.vaultEnrollStatus.textContent, /save is finishing/);
});
