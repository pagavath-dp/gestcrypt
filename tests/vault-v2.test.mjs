import test from 'node:test';
import assert from 'node:assert/strict';
import { V2_LIMITS, parseV2, encryptV2, decryptV2 } from '../vault-v2.mjs';

const passphrase = 'correct horse battery staple';
const file = (content = 'private data', name = 'résumé.txt') => new File([content], name);
const asFile = bytes => new File([bytes], 'input.gcry');
const bytes = async blob => new Uint8Array(await blob.arrayBuffer());
const encrypted = async () => bytes((await encryptV2(file(), passphrase)).blob);

test('v2 round trip preserves bytes, authenticated filename, and hash', async () => {
  const source = new File([new Uint8Array([0, 1, 255, 42])], 'résumé.txt');
  const result = await encryptV2(source, passphrase);
  const parsed = parseV2(await bytes(result.blob));
  assert.equal(parsed.iterations, V2_LIMITS.WRITE_ITERATIONS);
  assert.equal(parsed.wrappedDek.length, 48);
  assert.equal(parsed.ciphertext.length, source.size + 16);
  const opened = await decryptV2(asFile(result.blob), passphrase);
  assert.equal(opened.name, 'résumé.txt');
  assert.deepEqual(await bytes(opened.blob), new Uint8Array([0, 1, 255, 42]));
  assert.equal(opened.hash, result.hash);
});

test('v2 supports empty plaintext and creates fresh per-file key material', async () => {
  const empty = await encryptV2(file(''), passphrase);
  assert.equal((await decryptV2(asFile(empty.blob), passphrase)).blob.size, 0);
  const a = parseV2(await encrypted()), b = parseV2(await encrypted());
  assert.notDeepEqual(a.salt, b.salt);
  assert.notDeepEqual(a.wrapIv, b.wrapIv);
  assert.notDeepEqual(a.dataIv, b.dataIv);
  assert.notDeepEqual(a.wrappedDek, b.wrappedDek);
});

test('wrong passphrase and modified authenticated fields release no plaintext', async () => {
  const original = await encrypted();
  await assert.rejects(decryptV2(asFile(original), 'incorrect passphrase'), /Decryption failed/);
  const nameEnd = 52 + new TextEncoder().encode('résumé.txt').length;
  for (const offset of [10, 26, 38, 52, nameEnd, original.length - 1]) {
    const changed = original.slice(); changed[offset] ^= 1;
    await assert.rejects(decryptV2(asFile(changed), passphrase), /Decryption failed|Invalid GestCrypt v2/);
  }
  const changedIterations = original.slice();
  new DataView(changedIterations.buffer).setUint32(6, V2_LIMITS.WRITE_ITERATIONS + 1, false);
  await assert.rejects(decryptV2(asFile(changedIterations), passphrase), /Decryption failed/);
  const changedNameLength = original.slice();
  changedNameLength[51] -= 1;
  await assert.rejects(decryptV2(asFile(changedNameLength), passphrase), /Decryption failed|Invalid GestCrypt v2/);
});

test('v2 ciphertext body and wrapped-DEK tag tampering return no plaintext blob', async () => {
  const original = await encrypted();
  const parsed = parseV2(original);
  const headerEnd = parsed.header.length;
  const wrapTagOffset = parsed.prefix.length + V2_LIMITS.DEK_BYTES;
  assert.ok(headerEnd < original.length - V2_LIMITS.TAG_BYTES);
  assert.ok(wrapTagOffset >= parsed.prefix.length + V2_LIMITS.DEK_BYTES);
  assert.ok(wrapTagOffset < headerEnd);
  for (const [label, offset] of [['ciphertext body', headerEnd], ['wrapped-DEK tag', wrapTagOffset]]) {
    const changed = original.slice(); changed[offset] ^= 1;
    let opened;
    await assert.rejects(async () => { opened = await decryptV2(asFile(changed), passphrase); },
      /Decryption failed: wrong passphrase or the file was modified/, label);
    assert.equal(opened, undefined, `${label} must not return a plaintext result`);
  }
});

test('v2 parser accepts the exact maximum encoded size and rejects one byte more', async () => {
  const nameLength = V2_LIMITS.MAX_FILENAME_BYTES;
  const headerLength = V2_LIMITS.PREFIX_BYTES + nameLength + V2_LIMITS.WRAPPED_DEK_BYTES;
  const maximum = headerLength + V2_LIMITS.MAX_PLAINTEXT_BYTES + V2_LIMITS.TAG_BYTES;
  const data = new Uint8Array(maximum);
  data.set(new TextEncoder().encode('GCRY'));
  data[4] = V2_LIMITS.VERSION; data[5] = V2_LIMITS.KDF_ID;
  const view = new DataView(data.buffer);
  view.setUint32(6, V2_LIMITS.MIN_ITERATIONS, false);
  view.setUint16(50, nameLength, false);
  data.fill(0x61, V2_LIMITS.PREFIX_BYTES, V2_LIMITS.PREFIX_BYTES + nameLength);
  const parsed = parseV2(data);
  assert.equal(parsed.name, 'a'.repeat(nameLength));
  assert.equal(parsed.ciphertext.length, V2_LIMITS.MAX_PLAINTEXT_BYTES + V2_LIMITS.TAG_BYTES);
  assert.throws(() => parseV2(new Uint8Array(maximum + 1)), /file length is outside supported bounds/);
  let reads = 0;
  await assert.rejects(decryptV2({ size: maximum + 1, arrayBuffer() { reads++; throw new Error('unexpected read'); } }, passphrase),
    /file length is outside supported bounds/);
  assert.equal(reads, 0);
});

test('v2 255-byte filename round trips and 256 bytes is rejected', async () => {
  const name = 'a'.repeat(V2_LIMITS.MAX_FILENAME_BYTES);
  const result = await encryptV2(file('x', name), passphrase);
  assert.equal((await decryptV2(asFile(result.blob), passphrase)).name, name);
  await assert.rejects(encryptV2(file('x', name + 'a'), passphrase), /Filename exceeds/);
});

test('v2 malformed header boundaries, names, and KDF fields reject before PBKDF2', async () => {
  const original = await encrypted();
  const parsed = parseV2(original);
  const prefixEnd = parsed.prefix.length, headerEnd = parsed.header.length;
  const cases = [
    ...[0, 4, 5, 10, 26, 38, 50, 52, prefixEnd - 1, prefixEnd,
      prefixEnd + V2_LIMITS.DEK_BYTES, headerEnd - 1,
      headerEnd, headerEnd + 15].map(length => [original.slice(0, length), /length|truncated|header/]),
    [Object.assign(original.slice(), { 4: 3 }), /Unsupported GestCrypt file version/],
    [Object.assign(original.slice(), { 5: 2 }), /unsupported KDF identifier/],
    [Object.assign(original.slice(), { 52: 0xff }), /filename is not valid UTF-8 or is unsafe/],
    [Object.assign(original.slice(), { 52: 0x2f }), /filename is not valid UTF-8 or is unsafe/],
    [Object.assign(original.slice(), { 52: 0x5c }), /filename is not valid UTF-8 or is unsafe/],
    [Object.assign(original.slice(), { 52: 0 }), /filename is not valid UTF-8 or is unsafe/]
  ];
  for (const iterations of [V2_LIMITS.MIN_ITERATIONS - 1, V2_LIMITS.MAX_ITERATIONS + 1]) {
    const altered = original.slice(); new DataView(altered.buffer).setUint32(6, iterations, false);
    cases.push([altered, /PBKDF2 iteration count is outside supported bounds/]);
  }
  const subtle = crypto.subtle, originalDeriveKey = subtle.deriveKey;
  let kdfCalls = 0;
  subtle.deriveKey = function (...args) { kdfCalls++; return originalDeriveKey.apply(this, args); };
  try {
    for (const [data, error] of cases) {
      let opened;
      await assert.rejects(async () => { opened = await decryptV2(asFile(data), passphrase); }, error);
      assert.equal(opened, undefined);
    }
    assert.equal(kdfCalls, 0, 'malformed inputs must fail before PBKDF2');
  } finally { delete subtle.deriveKey; }
});

test('v2 rejects malformed lengths, KDF parameters, and unsupported identifiers before KDF', async () => {
  const original = await encrypted();
  const cases = [
    [0, 0, /Not a GestCrypt/],
    [4, 3, /Unsupported/],
    [5, 2, /KDF identifier/],
    [8, 0, /iteration count/],
    [50, 1, /filename length|header/]
  ];
  for (const [offset, value, message] of cases) {
    const changed = original.slice(); changed[offset] = value;
    assert.throws(() => parseV2(changed), message);
    await assert.rejects(decryptV2(asFile(changed), ''), message);
  }
  const high = original.slice(); new DataView(high.buffer).setUint32(6, V2_LIMITS.MAX_ITERATIONS + 1, false);
  assert.throws(() => parseV2(high), /iteration count/);
  const low = original.slice(); new DataView(low.buffer).setUint32(6, V2_LIMITS.MIN_ITERATIONS - 1, false);
  assert.throws(() => parseV2(low), /iteration count/);
  const zeroName = original.slice(); zeroName[50] = 0; zeroName[51] = 0;
  assert.throws(() => parseV2(zeroName), /filename length/);
  const longName = original.slice(); longName[50] = 1; longName[51] = 0;
  assert.throws(() => parseV2(longName), /filename length/);
  for (const length of [0, 5, 51]) {
    assert.throws(() => parseV2(original.slice(0, length)));
  }
  await assert.rejects(decryptV2(asFile(original.slice(0, -1)), passphrase), /Decryption failed/);
  const noTag = original.slice(0, original.length - 'private data'.length - 1);
  assert.throws(() => parseV2(noTag), /length/);
});

test('v2 rejects unsafe filenames and enforces whole-file limits before reading', async () => {
  await assert.rejects(encryptV2(file('x', '../bad'), passphrase), /filename/i);
  await assert.rejects(encryptV2(file('x', 'a'.repeat(256)), passphrase), /Filename exceeds/);
  const oversized = { size: V2_LIMITS.MAX_PLAINTEXT_BYTES + 1, name: 'large.bin',
    arrayBuffer() { throw new Error('Must not read'); } };
  await assert.rejects(encryptV2(oversized, passphrase), /32 MiB/);
  const oversizedEncrypted = { size: V2_LIMITS.MAX_PLAINTEXT_BYTES + 1000,
    arrayBuffer() { throw new Error('Must not read'); } };
  await assert.rejects(decryptV2(oversizedEncrypted, passphrase), /file length/);
});

test('v2 writer requires a nonblank passphrase of at least 12 characters', async () => {
  await assert.rejects(encryptV2(file(), ''), /Passphrase/);
  await assert.rejects(encryptV2(file(), 'short'), /12 characters/);
  await assert.rejects(encryptV2(file(), ' '.repeat(12)), /nonblank/);
  await assert.rejects(encryptV2(file(), 'a'.repeat(1025)), /1024/);
  const original = await encrypted();
  await assert.rejects(decryptV2(asFile(original), 'a'.repeat(1025)), /1024/);
});

test('independently encoded v2 file decrypts with specified offsets and AAD', async () => {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const wrapIv = crypto.getRandomValues(new Uint8Array(12));
  const dataIv = crypto.getRandomValues(new Uint8Array(12));
  const rawDek = crypto.getRandomValues(new Uint8Array(32));
  const name = enc.encode('independent.txt');
  const prefix = new Uint8Array(52 + name.length);
  prefix.set(enc.encode('GCRY')); prefix[4] = 2; prefix[5] = 1;
  new DataView(prefix.buffer).setUint32(6, 600000, false);
  prefix.set(salt, 10); prefix.set(wrapIv, 26); prefix.set(dataIv, 38);
  new DataView(prefix.buffer).setUint16(50, name.length, false); prefix.set(name, 52);
  const source = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  const kek = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' },
    source, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const wrapAad = new Uint8Array([...enc.encode('GestCrypt-v2-wrap'), 0, ...prefix]);
  const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: wrapIv,
    additionalData: wrapAad, tagLength: 128 }, kek, rawDek));
  const header = new Uint8Array([...prefix, ...wrapped]);
  const dek = await crypto.subtle.importKey('raw', rawDek, 'AES-GCM', false, ['encrypt']);
  const dataAad = new Uint8Array([...enc.encode('GestCrypt-v2-data'), 0, ...header]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: dataIv,
    additionalData: dataAad, tagLength: 128 }, dek, enc.encode('independent content')));
  rawDek.fill(0);
  const opened = await decryptV2(asFile(new Blob([header, ciphertext])), passphrase);
  assert.equal(opened.name, 'independent.txt');
  assert.equal(await opened.blob.text(), 'independent content');
});
