import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { detectFormat, decryptByVersion } from '../format-dispatch.mjs';
import { encryptV2, parseV2 } from '../vault-v2.mjs';

// Execute the actual inline decryption handler with a minimal DOM/download harness.
// This checks handler control flow; it is not a real-browser download test.
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const start = html.indexOf('async function run(mode) {');
const end = html.indexOf('$("btnEnc").onclick', start);
assert.ok(start >= 0 && end > start, 'inline decryption handler must be present');
const handlerSource = html.slice(start, end);
const passphrase = 'correct horse battery staple';

function harness(file, secret) {
  const elements = {
    file: { files: [file] }, passphrase: { value: secret },
    passphraseConfirm: { value: '' }, pin: { value: '' }, bar: { style: { width: '' } }
  };
  const downloads = [], statuses = [], busyStates = [];
  const run = vm.runInNewContext(handlerSource + '\nrun', {
    $: id => elements[id],
    status: message => statuses.push(message),
    busy: value => busyStates.push(value),
    download: (blob, name) => downloads.push({ blob, name }),
    detectFormat, decryptByVersion,
    ensureCamera: () => { throw new Error('V2 must not start the camera.'); },
    getSignature: () => { throw new Error('V2 must not capture a gesture.'); }
  });
  return { run, downloads, statuses, busyStates, elements };
}

test('inline UI handler starts no download on wrong v2 passphrase', async () => {
  const encrypted = await encryptV2(new File(['plain'], 'plain.txt'), passphrase);
  const ui = harness(new File([encrypted.blob], 'plain.gcry'), 'wrong passphrase');
  await ui.run('dec');
  assert.equal(ui.downloads.length, 0);
  assert.match(ui.statuses.at(-1), /Decryption failed: wrong passphrase or the file was modified/);
  assert.deepEqual(ui.busyStates, [true, false]);
});

test('inline UI handler starts no download on v2 ciphertext-body tampering', async () => {
  const encrypted = await encryptV2(new File(['plain'], 'plain.txt'), passphrase);
  const altered = new Uint8Array(await encrypted.blob.arrayBuffer());
  const bodyOffset = parseV2(altered).header.length;
  assert.ok(bodyOffset < altered.length - 16);
  altered[bodyOffset] ^= 1;
  const ui = harness(new File([altered], 'tampered.gcry'), passphrase);
  await ui.run('dec');
  assert.equal(ui.downloads.length, 0);
  assert.match(ui.statuses.at(-1), /Decryption failed: wrong passphrase or the file was modified/);
});

test('inline UI handler passes authenticated v2 plaintext to download', async () => {
  const encrypted = await encryptV2(new File(['plain'], 'plain.txt'), passphrase);
  const ui = harness(new File([encrypted.blob], 'plain.gcry'), passphrase);
  await ui.run('dec');
  assert.equal(ui.downloads.length, 1);
  assert.equal(ui.downloads[0].name, 'plain.txt');
  assert.equal(await ui.downloads[0].blob.text(), 'plain');
  assert.match(ui.statuses.at(-1), /Decrypted plain.txt/);
});
