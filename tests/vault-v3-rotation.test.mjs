import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptV3, decryptV3Normal, decryptV3Recovery, rewrapV3,
  parseV3, encodeV3RecoveryKey } from '../vault-v3.mjs';

const source = new TextEncoder().encode('separate recovery keys for rebound files');
const oldPassphrase = 'old-profile-passphrase';
const newPassphrase = 'new-profile-passphrase';
const bytes = async blob => new Uint8Array(await blob.arrayBuffer());
const file = blob => new File([blob], 'vault.gcry');
const hex = value => Buffer.from(value).toString('hex');

async function device(counter) {
  return { key: await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false,
      ['encrypt', 'decrypt']),
    id: crypto.getRandomValues(new Uint8Array(16)),
    reserveNonce: async () => {
      const nonce = new Uint8Array(12);
      new DataView(nonce.buffer).setBigUint64(4, BigInt(counter), false);
      return nonce;
    } };
}

function rotationRandom(parsed, newRecoveryKey) {
  const headerNonce = parsed.headerNonce.slice();
  headerNonce[0] ^= 0xff;
  if (hex(headerNonce) === hex(parsed.dataNonce)) headerNonce[1] ^= 0xff;
  const values = [new Uint8Array(16).fill(0x11), new Uint8Array(12).fill(0x22),
    newRecoveryKey, new Uint8Array(12).fill(0x44), headerNonce];
  return length => {
    const next = values.shift();
    assert.ok(next);
    assert.equal(next.length, length);
    return next;
  };
}

async function rejectsWithoutPlaintext(operation) {
  let output;
  await assert.rejects(async () => { output = await operation(); }, /authentication failed|original browser-profile key/);
  assert.equal(output, undefined);
}

test('opt-in rebind rotates recovery key while preserving original file and immutable ciphertext', async () => {
  const profileA = await device(1), profileB = await device(2);
  const original = await encryptV3(new File([source], 'notes.txt'), oldPassphrase, profileA);
  const originalBytes = await bytes(original.blob);
  const before = parseV3(originalBytes);
  const newRecoveryKey = original.recoveryKey.map(value => value ^ 0xff);
  const rebound = await rewrapV3(file(original.blob), { recoveryCode: original.recoveryCode },
    newPassphrase, profileB, { rotateRecoveryKey: true,
      random: rotationRandom(before, newRecoveryKey) });
  const reboundBytes = await bytes(rebound.blob);
  const after = parseV3(reboundBytes);
  assert.deepEqual(await bytes(original.blob), originalBytes, 'source file remains unchanged');
  assert.deepEqual(after.core, before.core);
  assert.deepEqual(after.dataCiphertext, before.dataCiphertext);
  assert.notDeepEqual(after.recoveryMeta, before.recoveryMeta);
  assert.notDeepEqual(after.recoveryEnvelope, before.recoveryEnvelope);
  assert.deepEqual(rebound.recoveryKey, newRecoveryKey);
  assert.equal(rebound.recoveryCode, await encodeV3RecoveryKey(newRecoveryKey));
  assert.notEqual(rebound.recoveryCode, original.recoveryCode);
  assert.deepEqual(await bytes((await decryptV3Recovery(file(original.blob), original.recoveryCode)).blob), source);
  assert.deepEqual(await bytes((await decryptV3Recovery(file(rebound.blob), rebound.recoveryCode)).blob), source);
  assert.deepEqual(await bytes((await decryptV3Normal(file(rebound.blob), newPassphrase, profileB)).blob), source);
  await rejectsWithoutPlaintext(() => decryptV3Recovery(file(rebound.blob), original.recoveryCode));
  await rejectsWithoutPlaintext(() => decryptV3Recovery(file(original.blob), rebound.recoveryCode));
  await rejectsWithoutPlaintext(() => decryptV3Normal(file(rebound.blob), oldPassphrase, profileA));
  original.recoveryKey.fill(0);
  rebound.recoveryKey.fill(0);
});

test('tampered input cannot produce a rotated file, recovery code, or plaintext', async () => {
  const profileA = await device(1), profileB = await device(2);
  const original = await encryptV3(new File([source], 'notes.txt'), oldPassphrase, profileA);
  const tampered = await bytes(original.blob);
  tampered[tampered.length - 17] ^= 1;
  let output;
  await assert.rejects(async () => {
    output = await rewrapV3(file(tampered), { recoveryCode: original.recoveryCode },
      newPassphrase, profileB, { rotateRecoveryKey: true });
  }, /authentication failed/);
  assert.equal(output, undefined);
  original.recoveryKey.fill(0);
});

test('rotation fails closed if the random source repeats the old recovery key', async () => {
  const profileA = await device(1), profileB = await device(2);
  const original = await encryptV3(new File([source], 'notes.txt'), oldPassphrase, profileA);
  let output;
  await assert.rejects(async () => {
    output = await rewrapV3(file(original.blob), { recoveryCode: original.recoveryCode },
      newPassphrase, profileB, { rotateRecoveryKey: true,
        random: length => length === 32 ? original.recoveryKey : new Uint8Array(length).fill(1) });
  }, /distinct V3 recovery key/);
  assert.equal(output, undefined);
  original.recoveryKey.fill(0);
});
