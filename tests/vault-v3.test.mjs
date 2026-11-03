import test from 'node:test';
import assert from 'node:assert/strict';
import { V3_LIMITS, parseV3, encryptV3, decryptV3Normal, decryptV3Recovery,
  rewrapV3, encodeV3RecoveryKey } from '../vault-v3.mjs';

const fromHex = value => Uint8Array.from(value.match(/../g), pair => parseInt(pair, 16));
const fileBytes = async blob => new Uint8Array(await blob.arrayBuffer());
const asFile = bytes => new File([bytes], 'input.gcry');
const SHA_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const E0 = fromHex('4743525903010000606162636465666768696a6b6c6d6e6fb0b1b2b3b4b5b6b7b8b9babb00017801000927c0707172737475767778797a7b7c7d7e7f808182838485868788898a8bd0d1d2d3d4d5d6d7d8d9dadbdcdddedf909192930000000000000001632026c55fa3af805bf6a92d0028db34e4305f3fb621de533d43db7d94f76c25dd9205c09a054bb9e1624d0628afedd085f69adccc968dd1846d068437c69647910791ad622202f5a0a1a2a3a4a5a6a7a8a9aaabf7ae241cc6ceba0a51466bd5a5911ed9df26c7f4d85ab31adae5d4a1d5ff40c77c495c6f7a7e36fcffa729353c7ba49ec0c1c2c3c4c5c6c7c8c9cacb0c51e36852881da53929e98b3dcf2f0db010acbc2e63acc84183c2a3c656c544');
const R1 = fromHex('4743525903010000606162636465666768696a6b6c6d6e6fb0b1b2b3b4b5b6b7b8b9babb00017801000927c0303132333435363738393a3b3c3d3e3f404142434445464748494a4b101112131415161718191a1b1c1d1e1f202122230000000000000001a0a4c50cb1b8df2d34af5c723acd6c8b231484ea23bd890ed63013c04f02c815b2403de4441a7e8cd3a43c1be5052482c3d6858403b551b642e98f1420c7c7f3910791ad622202f5a0a1a2a3a4a5a6a7a8a9aaabf7ae241cc6ceba0a51466bd5a5911ed9df26c7f4d85ab31adae5d4a1d5ff40c77c495c6f7a7e36fcffa729353c7ba49e505152535455565758595a5b157f29d459b0a72ba7b3cfe974b5e4c8b010acbc2e63acc84183c2a3c656c544');
const B1 = fromHex('4743525903010000303132333435363738393a3b3c3d3e3f707172737475767778797a7b00016201000927c0404142434445464748494a4b4c4d4e4f505152535455565758595a5bd0d1d2d3d4d5d6d7d8d9dadbdcdddedf9091929300000000000000029221d764825ee46cfe772af9ddc434c4cf8d733aec911e3a10f79270ced63bf07e78d3c390132fd204ce941ee2f76a89b86e8abcd8bd2c57a80c534c3d163516e52bc0c5a27191f5606162636465666768696a6b46acb1852a6053cb88eb8c775594f2cd73e3f60e9f32fa61a8aa9939a4164a5997125895930d0d0035503f94741b4802808182838485868788898a8bcfa541cf20f8d38aef215525dc71a0bdb6ade6ed13e54db426d8d9e9309934c886');
const E0_HASH = '97c524ff87c3c2caa1b7dbe3f6c6d535425d691c9192799651b14f0455630039';
const R1_HASH = '816e7553350127a8a96da7408dd3422ca50cff436e0f2ddaa2c0ee76206ff05f';
const B1_HASH = '61e50804d9c090863dc893262812c55e064e7249bc73b8061bcb48f82dcfb816';
const E0_RECOVERY = '404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f';
const B1_RECOVERY = '101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f';
const E0_CODE = '40414243-44454647-48494A4B-4C4D4E4F-50515253-54555657-58595A5B-5C5D5E5F-F285739A';
const E0_PASS = 'vector-passphrase-2026';
const R1_PASS = 'new-profile-passphrase-2026';
const OLD_KEY = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const NEW_KEY = 'e0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff';
const OLD_ID = 'd0d1d2d3d4d5d6d7d8d9dadbdcdddedf';
const NEW_ID = '101112131415161718191a1b1c1d1e1f';
const OLD_NONCE = '909192930000000000000001';
const NEW_NONCE = '202122230000000000000001';
const B1_NONCE = '909192930000000000000002';

async function device(keyHex = OLD_KEY, idHex = OLD_ID, nonceHex = OLD_NONCE) {
  const key = await crypto.subtle.importKey('raw', fromHex(keyHex), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { key, id: fromHex(idHex), async reserveNonce() { return fromHex(nonceHex); } };
}
function randomSequence(values) {
  const pending = values.map(fromHex);
  const random = length => {
    const next = pending.shift();
    assert.ok(next, 'unexpected random draw');
    assert.equal(next.length, length, 'unexpected random draw length');
    return next;
  };
  random.finished = () => assert.equal(pending.length, 0, 'all fixed fixture bytes consumed');
  return random;
}
const e0Random = () => randomSequence([
  '202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f', E0_RECOVERY, '606162636465666768696a6b6c6d6e6f', 'b0b1b2b3b4b5b6b7b8b9babb',
  '707172737475767778797a7b7c7d7e7f', '808182838485868788898a8b', 'a0a1a2a3a4a5a6a7a8a9aaab', 'c0c1c2c3c4c5c6c7c8c9cacb'
]);
const r1Random = () => randomSequence(['303132333435363738393a3b3c3d3e3f', '404142434445464748494a4b', '505152535455565758595a5b']);
const b1Random = () => randomSequence([
  'e0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff',
  B1_RECOVERY, '303132333435363738393a3b3c3d3e3f', '707172737475767778797a7b',
  '404142434445464748494a4b4c4d4e4f', '505152535455565758595a5b',
  '606162636465666768696a6b', '808182838485868788898a8b'
]);
async function sha(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}
async function rejectsWithoutResult(operation, pattern) {
  let result;
  await assert.rejects(async () => { result = await operation(); }, pattern);
  assert.equal(result, undefined, 'failure must not return plaintext or a Blob');
}

test('V3-E0 writer matches fixed complete bytes, hash and recovery code', async () => {
  const random = e0Random();
  const result = await encryptV3(new File([], 'x'), E0_PASS, await device(), { random });
  random.finished();
  assert.deepEqual(await fileBytes(result.blob), E0);
  assert.equal(await sha(E0), E0_HASH);
  assert.equal(result.hash, SHA_EMPTY);
  assert.deepEqual(result.recoveryKey, fromHex(E0_RECOVERY));
  assert.deepEqual(result.recoveryId, fromHex('910791ad622202f5'));
  assert.equal(result.recoveryCode, E0_CODE);
  assert.equal(await encodeV3RecoveryKey(fromHex(E0_RECOVERY)), E0_CODE);
});

test('V3-E0 parser returns exact offsets and authenticated-field slices', () => {
  const parsed = parseV3(E0);
  assert.deepEqual(parsed.offsets, { S: 39, R: 164, T: 232, C: 260 });
  assert.equal(parsed.name, 'x');
  assert.equal(parsed.nameLength, 1);
  assert.equal(parsed.iterations, 600000);
  for (const [field, start, end] of [
    ['core', 0, 39], ['normalMeta', 39, 100], ['outerEnvelope', 100, 164],
    ['recoveryMeta', 164, 184], ['recoveryEnvelope', 184, 232],
    ['headerNonce', 232, 244], ['headerTag', 244, 260], ['dataCiphertext', 260, 276]
  ]) assert.deepEqual(parsed[field], E0.slice(start, end), field);
});

test('V3-E0 normal and recovery paths return authenticated empty plaintext', async () => {
  const normal = await decryptV3Normal(asFile(E0), E0_PASS, await device());
  const recovery = await decryptV3Recovery(asFile(E0), E0_CODE);
  for (const result of [normal, recovery]) {
    assert.equal(result.name, 'x');
    assert.equal(result.hash, SHA_EMPTY);
    assert.equal(result.blob.size, 0);
  }
});

test('V3-R1 rewrap matches fixed bytes; old profile fails while new and recovery paths work', async () => {
  const random = r1Random();
  const next = await rewrapV3(asFile(E0), { recoveryCode: E0_CODE }, R1_PASS,
    await device(NEW_KEY, NEW_ID, NEW_NONCE), { random });
  random.finished();
  const actual = await fileBytes(next.blob);
  assert.deepEqual(actual, R1);
  assert.equal(await sha(actual), R1_HASH);
  assert.deepEqual(actual.slice(0, 39), E0.slice(0, 39));
  assert.deepEqual(actual.slice(164, 232), E0.slice(164, 232));
  assert.deepEqual(actual.slice(260), E0.slice(260));
  assert.equal((await decryptV3Normal(asFile(E0), E0_PASS, await device())).blob.size, 0);
  assert.equal((await decryptV3Normal(asFile(R1), R1_PASS,
    await device(NEW_KEY, NEW_ID, NEW_NONCE))).blob.size, 0);
  assert.equal((await decryptV3Recovery(asFile(R1), E0_CODE)).blob.size, 0);
  const old = await device();
  await rejectsWithoutResult(() => decryptV3Normal(asFile(R1), E0_PASS, old), /original browser-profile key/);
});

test('V3-B1 matches fixed nonempty bytes and both paths; body tamper yields no plaintext', async () => {
  const random = b1Random();
  const result = await encryptV3(new File([fromHex('41')], 'b'), E0_PASS,
    await device(OLD_KEY, OLD_ID, B1_NONCE), { random });
  random.finished();
  assert.deepEqual(await fileBytes(result.blob), B1);
  assert.equal(await sha(B1), B1_HASH);
  assert.equal(result.hash, await sha(fromHex('41')));
  assert.equal(B1[260], 0xb6);
  const recoveryCode = await encodeV3RecoveryKey(fromHex(B1_RECOVERY));
  for (const opened of [
    await decryptV3Normal(asFile(B1), E0_PASS, await device()),
    await decryptV3Recovery(asFile(B1), recoveryCode)
  ]) {
    assert.equal(opened.name, 'b');
    assert.deepEqual(await fileBytes(opened.blob), fromHex('41'));
  }
  const changed = B1.slice(); changed[260] ^= 1;
  const oldDevice = await device();
  await rejectsWithoutResult(() => decryptV3Normal(asFile(changed), E0_PASS, oldDevice), /authentication failed/);
  await rejectsWithoutResult(() => decryptV3Recovery(asFile(changed), recoveryCode), /authentication failed/);
});

test('published malformed V3 vectors reject before PBKDF2', async () => {
  const cases = [];
  const changed = (offset, value) => { const copy = E0.slice(); copy[offset] = value; return copy; };
  cases.push(changed(0, 0), changed(4, 1), changed(4, 2), changed(4, 0xff),
    changed(5, 2), changed(6, 1), changed(7, 1), changed(38, 0xff), changed(38, 0x2f),
    changed(39, 2));
  for (const [high, low] of [[0, 0], [1, 0]]) {
    const copy = E0.slice(); copy[36] = high; copy[37] = low; cases.push(copy);
  }
  for (const iterations of [599999, 1200001]) {
    const copy = E0.slice(); new DataView(copy.buffer).setUint32(40, iterations, false); cases.push(copy);
  }
  const bom = new Uint8Array(E0.length + 3);
  bom.set(E0.subarray(0, 38));
  bom.set([0xef, 0xbb, 0xbf, 0x78], 38);
  bom.set(E0.subarray(39), 42);
  new DataView(bom.buffer).setUint16(36, 4, false);
  cases.push(bom); // TextDecoder may strip a BOM; parser must not silently rename the file.
  for (const length of [38, 39, 100, 164, 184, 232, 244, 260, 275]) cases.push(E0.slice(0, length));
  const subtle = crypto.subtle, original = subtle.deriveKey;
  const originalDevice = await device();
  let calls = 0;
  subtle.deriveKey = function (...args) { calls++; return original.apply(this, args); };
  try {
    for (const data of cases) {
      assert.throws(() => parseV3(data), /Invalid GestCrypt v3|Unsupported GestCrypt|Not a GestCrypt/);
      await rejectsWithoutResult(() => decryptV3Normal(asFile(data), E0_PASS, originalDevice),
        /Invalid GestCrypt v3|Unsupported GestCrypt|Not a GestCrypt/);
    }
    assert.equal(calls, 0, 'malformed input must not invoke PBKDF2');
  } finally { delete subtle.deriveKey; }
});

test('V3 exact maximum size and 255-byte filename parse, plus one rejects before reading', async () => {
  const maximum = V3_LIMITS.MAX_PLAINTEXT_BYTES + 530;
  const data = new Uint8Array(maximum + 1);
  data.set(new TextEncoder().encode('GCRY'));
  data[4] = 3; data[5] = 1;
  new DataView(data.buffer).setUint16(36, 255, false);
  data.fill(0x61, 38, 293);
  data[293] = 1;
  new DataView(data.buffer).setUint32(294, 600000, false);
  const parsed = parseV3(data.subarray(0, maximum));
  assert.equal(parsed.name, 'a'.repeat(255));
  assert.deepEqual(parsed.offsets, { S: 293, R: 418, T: 486, C: 514 });
  assert.equal(parsed.dataCiphertext.length, V3_LIMITS.MAX_PLAINTEXT_BYTES + 16);
  assert.throws(() => parseV3(data), /file length is outside supported bounds/);
  let reads = 0;
  await rejectsWithoutResult(() => decryptV3Recovery({ size: maximum + 1,
    arrayBuffer() { reads++; throw new Error('must not read'); } }, E0_CODE), /file length/);
  assert.equal(reads, 0);
});

test('wrong credentials and every published authenticated-field mutation return no plaintext', async () => {
  const original = await device();
  const wrongKey = await device('00'.repeat(32));
  const wrongRecovery = await encodeV3RecoveryKey(new Uint8Array(32));
  await rejectsWithoutResult(() => decryptV3Normal(asFile(E0), 'incorrect passphrase', original), /authentication failed/);
  await rejectsWithoutResult(() => decryptV3Normal(asFile(E0), E0_PASS, wrongKey), /authentication failed/);
  await rejectsWithoutResult(() => decryptV3Recovery(asFile(E0), wrongRecovery), /authentication failed/);
  await rejectsWithoutResult(() => decryptV3Recovery(asFile(E0), E0_CODE.slice(0, -1) + '0'), /checksum/);
  for (const offset of [8, 24, 38, 44, 60, 72, 88, 100, 148, 164, 172, 184, 216, 232, 244, 260]) {
    const copy = E0.slice(); copy[offset] ^= 1;
    await rejectsWithoutResult(() => decryptV3Normal(asFile(copy), E0_PASS, original),
      /authentication failed|original browser-profile key/);
    await rejectsWithoutResult(() => decryptV3Recovery(asFile(copy), E0_CODE), /authentication failed/);
  }
  const iterations = E0.slice(); new DataView(iterations.buffer).setUint32(40, 600001, false);
  await rejectsWithoutResult(() => decryptV3Normal(asFile(iterations), E0_PASS, original), /authentication failed/);
  await rejectsWithoutResult(() => decryptV3Recovery(asFile(iterations), E0_CODE), /authentication failed/);
});

test('rewrap authenticates old file and never returns a replacement after tampering', async () => {
  const newDevice = await device(NEW_KEY, NEW_ID, NEW_NONCE);
  const copy = B1.slice(); copy[260] ^= 1;
  const b1Code = await encodeV3RecoveryKey(fromHex(B1_RECOVERY));
  await rejectsWithoutResult(() => rewrapV3(asFile(copy), { recoveryCode: b1Code },
    R1_PASS, newDevice), /authentication failed/);
  const oldDevice = await device();
  await rejectsWithoutResult(() => rewrapV3(asFile(E0), { passphrase: 'wrong', device: oldDevice },
    R1_PASS, newDevice), /authentication failed/);
  await rejectsWithoutResult(() => rewrapV3(asFile(E0), { recoveryCode: E0_CODE, passphrase: E0_PASS },
    R1_PASS, newDevice), /exactly one/);
});

test('authenticated rewrap retains nonempty ciphertext and data tag byte-for-byte', async () => {
  const code = await encodeV3RecoveryKey(fromHex(B1_RECOVERY));
  const random = randomSequence([
    '909192939495969798999a9b9c9d9e9f', 'a0a1a2a3a4a5a6a7a8a9aaab',
    'b0b1b2b3b4b5b6b7b8b9babb'
  ]);
  const newDevice = await device(NEW_KEY, NEW_ID, '202122230000000000000002');
  const output = await rewrapV3(asFile(B1), { passphrase: E0_PASS, device: await device() },
    R1_PASS, newDevice, { random });
  random.finished();
  const after = await fileBytes(output.blob);
  assert.deepEqual(after.slice(0, 39), B1.slice(0, 39));
  assert.deepEqual(after.slice(164, 232), B1.slice(164, 232));
  assert.deepEqual(after.slice(260), B1.slice(260));
  assert.deepEqual(await fileBytes((await decryptV3Normal(asFile(after), R1_PASS, newDevice)).blob), fromHex('41'));
  assert.deepEqual(await fileBytes((await decryptV3Recovery(asFile(after), code)).blob), fromHex('41'));
});

test('missing, failed and invalid device nonce reservations fail closed before reading', async () => {
  const valid = await device();
  let reads = 0;
  const input = { size: 0, name: 'x', arrayBuffer() { reads++; return new ArrayBuffer(0); } };
  const { reserveNonce: _unused, ...missing } = valid;
  await rejectsWithoutResult(() => encryptV3(input, E0_PASS, missing), /reservation is required/);
  await rejectsWithoutResult(() => encryptV3(input, E0_PASS,
    { ...valid, reserveNonce() { throw new Error('storage blocked'); } }), /storage blocked/);
  await rejectsWithoutResult(() => encryptV3(input, E0_PASS,
    { ...valid, reserveNonce() { return new Uint8Array(12); } }), /reservation failed/);
  await rejectsWithoutResult(() => encryptV3(input, 'short', valid), /at least 12 characters/);
  assert.equal(reads, 0);
  const extractable = { ...valid,
    key: await crypto.subtle.importKey('raw', fromHex(OLD_KEY), 'AES-GCM', true, ['encrypt', 'decrypt']) };
  await rejectsWithoutResult(() => encryptV3(input, E0_PASS, extractable), /non-extractable/);
});

test('invalid entropy and repeated header/data nonce fail without encrypted output', async () => {
  const valid = await device();
  await rejectsWithoutResult(() => encryptV3(new File([], 'x'), E0_PASS, valid,
    { random: length => new Uint8Array(length - 1) }), /Secure random bytes/);
  await rejectsWithoutResult(() => encryptV3(new File([], 'x'), E0_PASS, valid,
    { random: length => new Uint8Array(length) }), /distinct V3 nonce/);
  const failedNonce = { ...valid, reserveNonce() { throw new Error('counter unavailable'); } };
  await rejectsWithoutResult(() => rewrapV3(asFile(E0), { recoveryCode: E0_CODE },
    R1_PASS, failedNonce), /counter unavailable/);
});

test('production entry point draws fresh per-file material with the browser CSPRNG', async () => {
  const first = await encryptV3(new File([], 'x'), E0_PASS, await device());
  const second = await encryptV3(new File([], 'x'), E0_PASS,
    await device(OLD_KEY, OLD_ID, '909192930000000000000002'));
  const a = parseV3(await fileBytes(first.blob));
  const b = parseV3(await fileBytes(second.blob));
  assert.notDeepEqual(a.fileId, b.fileId);
  assert.notDeepEqual(a.salt, b.salt);
  assert.notDeepEqual(first.recoveryKey, second.recoveryKey);
  assert.notDeepEqual(a.dataCiphertext, b.dataCiphertext);
  first.recoveryKey.fill(0); second.recoveryKey.fill(0);
});
