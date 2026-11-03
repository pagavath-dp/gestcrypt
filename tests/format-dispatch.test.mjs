import test from 'node:test';
import assert from 'node:assert/strict';
import { detectFormat, decryptByVersion } from '../format-dispatch.mjs';
import { encryptFile, parseEncrypted } from '../crypto.mjs';
import { encryptV2, parseV2 } from '../vault-v2.mjs';

const source = new File(['dispatch content'], 'dispatch.txt');
const passphrase = 'correct horse battery staple';

test('v1 dispatch obtains legacy credentials and retains legacy decryption', async () => {
  const encrypted = await encryptFile(source, 'GC1:T2-I2-M2-R0-P0-a0-bx-cx', '1234');
  const file = new File([encrypted.blob], 'legacy.gcry');
  assert.equal(await detectFormat(file), 1);
  let calls = 0;
  const opened = await decryptByVersion(file, { getLegacyCredentials: async () => {
    calls++; return { sig: 'GC1:T2-I2-M2-R0-P0-a0-bx-cx', pin: '1234' };
  } });
  assert.equal(calls, 1);
  assert.equal(await opened.blob.text(), 'dispatch content');
  assert.equal(opened.name, 'dispatch.txt');
});

test('v2 dispatch needs no camera or legacy credentials', async () => {
  const encrypted = await encryptV2(source, passphrase);
  const file = new File([encrypted.blob], 'current.gcry');
  assert.equal(await detectFormat(file), 2);
  const opened = await decryptByVersion(file, { passphrase });
  assert.equal(await opened.blob.text(), 'dispatch content');
});

test('v2 authentication failure never invokes the legacy path', async () => {
  const encrypted = await encryptV2(source, passphrase);
  const data = new Uint8Array(await encrypted.blob.arrayBuffer());
  data[data.length - 1] ^= 1;
  let calls = 0;
  await assert.rejects(decryptByVersion(new File([data], 'tampered.gcry'), {
    passphrase, getLegacyCredentials: async () => { calls++; return { sig: 'x' }; }
  }), /Decryption failed/);
  assert.equal(calls, 0);
});

test('invalid magic, truncated prefix, and unsupported versions do not fall back', async () => {
  for (const data of [new Uint8Array(0), new Uint8Array([71, 67, 82, 89]),
    new Uint8Array([0, 67, 82, 89, 1]), new Uint8Array([71, 67, 82, 89, 3])]) {
    let calls = 0;
    await assert.rejects(decryptByVersion(new File([data], 'bad.gcry'), {
      passphrase, getLegacyCredentials: async () => { calls++; return { sig: 'x' }; }
    }));
    assert.equal(calls, 0);
  }
});

test('rewriting only v2 version byte to v1 selects legacy credentials but returns no plaintext', async () => {
  const encrypted = await encryptV2(source, passphrase);
  const changed = new Uint8Array(await encrypted.blob.arrayBuffer());
  changed[4] = 1;
  const legacyParserAccepts = (() => { try { parseEncrypted(changed); return true; } catch { return false; } })();
  const subtle = crypto.subtle, originalDeriveKey = subtle.deriveKey;
  let callbackCalls = 0, kdfCalls = 0, opened;
  subtle.deriveKey = function (...args) { kdfCalls++; return originalDeriveKey.apply(this, args); };
  try {
    await assert.rejects(async () => {
      opened = await decryptByVersion(new File([changed], 'version-flipped.gcry'), {
        passphrase, getLegacyCredentials: async () => {
          callbackCalls++; return { sig: 'GC1:T2-I2-M2-R0-P0-a0-bx-cx', pin: '' };
        }
      });
    }, /Invalid GestCrypt file|Decryption failed/);
    assert.equal(callbackCalls, 1, 'version dispatch requests legacy credentials before v1 parsing');
    assert.equal(kdfCalls, Number(legacyParserAccepts), 'v1 PBKDF2 runs only if rewritten bytes pass the v1 parser');
    assert.equal(opened, undefined);
  } finally { delete subtle.deriveKey; }
});

test('rewriting only v1 version byte to v2 never requests legacy credentials or returns plaintext', async () => {
  const encrypted = await encryptFile(source, 'GC1:T2-I2-M2-R0-P0-a0-bx-cx', '1234');
  const changed = new Uint8Array(await encrypted.blob.arrayBuffer());
  changed[4] = 2;
  const v2ParserAccepts = (() => { try { parseV2(changed); return true; } catch { return false; } })();
  const subtle = crypto.subtle, originalDeriveKey = subtle.deriveKey;
  let callbackCalls = 0, kdfCalls = 0, opened;
  subtle.deriveKey = function (...args) { kdfCalls++; return originalDeriveKey.apply(this, args); };
  try {
    await assert.rejects(async () => {
      opened = await decryptByVersion(new File([changed], 'version-flipped.gcry'), {
        passphrase, getLegacyCredentials: async () => {
          callbackCalls++; return { sig: 'GC1:T2-I2-M2-R0-P0-a0-bx-cx', pin: '1234' };
        }
      });
    }, /Invalid GestCrypt v2 file|Decryption failed/);
    assert.equal(callbackCalls, 0);
    assert.equal(kdfCalls, Number(v2ParserAccepts));
    assert.equal(opened, undefined);
  } finally { delete subtle.deriveKey; }
});

test('unsupported version bytes on complete files reject before credentials or PBKDF2', async () => {
  const encrypted = await encryptV2(source, passphrase);
  const original = new Uint8Array(await encrypted.blob.arrayBuffer());
  const subtle = crypto.subtle, originalDeriveKey = subtle.deriveKey;
  let callbackCalls = 0, kdfCalls = 0;
  subtle.deriveKey = function (...args) { kdfCalls++; return originalDeriveKey.apply(this, args); };
  try {
    for (const version of [0, 3, 255]) {
      const changed = original.slice(); changed[4] = version;
      let opened;
      await assert.rejects(async () => {
        opened = await decryptByVersion(new File([changed], 'unsupported.gcry'), {
          passphrase, getLegacyCredentials: async () => { callbackCalls++; return { sig: 'unused' }; }
        });
      }, /Unsupported GestCrypt file version/);
      assert.equal(opened, undefined);
    }
    assert.equal(callbackCalls, 0);
    assert.equal(kdfCalls, 0);
  } finally { delete subtle.deriveKey; }
});
