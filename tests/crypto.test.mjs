import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptFile, decryptFile, parseEncrypted } from '../crypto.mjs';

const sig = 'GC1:T0-I2-M2-R0-P0-a0-bx-cx';
const pin = 'long example PIN';
const input = () => new File(['sample plaintext'], 'note.txt');
const asFile = bytes => new File([bytes], 'note.txt.gcry');
const bytes = async blob => new Uint8Array(await blob.arrayBuffer());

test('version-1 round trip preserves filename, content, and hash', async () => {
  const encrypted = await encryptFile(input(), sig, pin);
  const decrypted = await decryptFile(asFile(await bytes(encrypted.blob)), sig, pin);
  assert.equal(decrypted.name, 'note.txt');
  assert.equal(await decrypted.blob.text(), 'sample plaintext');
  assert.equal(decrypted.hash, encrypted.hash);
});

test('empty plaintext and UTF-8 filename remain valid version-1 files', async () => {
  const encrypted = await encryptFile(new File([], 'résumé.txt'), sig, pin);
  const decrypted = await decryptFile(asFile(encrypted.blob), sig, pin);
  assert.equal(decrypted.name, 'résumé.txt');
  assert.equal(decrypted.blob.size, 0);
});

test('wrong gesture and wrong PIN cannot decrypt', async () => {
  const data = await bytes((await encryptFile(input(), sig, pin)).blob);
  await assert.rejects(decryptFile(asFile(data), sig, 'wrong'), /Decryption failed/);
  await assert.rejects(decryptFile(asFile(data), 'GC1:T1-I2-M2-R0-P0-a0-bx-cx', pin), /Decryption failed/);
});

test('ciphertext and authenticated header tampering fail', async () => {
  const original = await bytes((await encryptFile(input(), sig, pin)).blob);
  for (const index of [5, 21, 35, original.length - 1]) {
    const altered = original.slice();
    altered[index] ^= 1;
    await assert.rejects(decryptFile(asFile(altered), sig, pin));
  }
});

test('version-1 ciphertext-body modification returns no plaintext blob', async () => {
  const original = await bytes((await encryptFile(input(), sig, pin)).blob);
  const parsed = parseEncrypted(original);
  const bodyOffset = parsed.header.length;
  assert.ok(parsed.ciphertext.length > 16, 'fixture must contain ciphertext before the tag');
  assert.ok(bodyOffset < original.length - 16, 'modified byte must be outside the authentication tag');
  const altered = original.slice(); altered[bodyOffset] ^= 1;
  let opened;
  await assert.rejects(async () => { opened = await decryptFile(asFile(altered), sig, pin); },
    /Decryption failed: wrong gesture or PIN, or the file was modified/);
  assert.equal(opened, undefined);
});

test('truncation, bad lengths, magic and version are rejected by parser', async () => {
  const original = await bytes((await encryptFile(input(), sig, pin)).blob);
  assert.throws(() => parseEncrypted(original.slice(0, 34)), /truncated/);
  assert.throws(() => parseEncrypted(original.slice(0, 50)), /truncated/);
  const badLength = original.slice(); badLength[33] = 0xff; badLength[34] = 0xff;
  assert.throws(() => parseEncrypted(badLength), /filename or ciphertext is truncated/);
  const noTag = original.slice(0, 35 + 'note.txt'.length + 15);
  assert.throws(() => parseEncrypted(noTag), /filename or ciphertext is truncated/);
  const badUtf8 = original.slice(); badUtf8[35] = 0xff;
  assert.throws(() => parseEncrypted(badUtf8), /filename is not UTF-8/);
  const badMagic = original.slice(); badMagic[0] = 0;
  assert.throws(() => parseEncrypted(badMagic), /Not a GestCrypt/);
  const badVersion = original.slice(); badVersion[4] = 2;
  assert.throws(() => parseEncrypted(badVersion), /Unsupported/);
  await assert.rejects(decryptFile(asFile(badVersion), sig, pin), /Unsupported/);
});

test('encryption rejects filenames that exceed the two-byte format field', async () => {
  await assert.rejects(encryptFile(new File(['x'], 'a'.repeat(65536)), sig, pin), /Filename is too long/);
});

test('an independently constructed legacy version-1 file remains readable', async () => {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const name = new TextEncoder().encode('older.txt');
  const header = new Uint8Array(35 + name.length);
  header.set(new TextEncoder().encode('GCRY')); header[4] = 1;
  header.set(salt, 5); header.set(iv, 21);
  new DataView(header.buffer).setUint16(33, name.length); header.set(name, 35);
  const source = await crypto.subtle.importKey('raw', new TextEncoder().encode(sig + '|' + pin), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' }, source, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: header }, key, new TextEncoder().encode('old content')));
  const result = await decryptFile(asFile(new Blob([header, ct])), sig, pin);
  assert.equal(result.name, 'older.txt');
  assert.equal(await result.blob.text(), 'old content');
});
