const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const MAGIC = encoder.encode('GCRY');
const CONTEXT = Object.freeze({
  pass: encoder.encode('GestCrypt-v3-pass'),
  device: encoder.encode('GestCrypt-v3-device'),
  recovery: encoder.encode('GestCrypt-v3-recovery'),
  header: encoder.encode('GestCrypt-v3-header'),
  data: encoder.encode('GestCrypt-v3-data'),
  recoveryId: encoder.encode('GestCrypt-v3-recovery-id'),
  recoveryCheck: encoder.encode('GestCrypt-v3-recovery-check')
});

export const V3_LIMITS = Object.freeze({
  VERSION: 3, SUITE_ID: 1, KDF_ID: 1,
  WRITE_ITERATIONS: 600000, MIN_ITERATIONS: 600000, MAX_ITERATIONS: 1200000,
  CORE_FIXED_BYTES: 38, NORMAL_BYTES: 125, RECOVERY_BYTES: 68, HEADER_FINAL_BYTES: 28,
  DEK_BYTES: 32, RECOVERY_KEY_BYTES: 32, DEVICE_ID_BYTES: 16,
  NONCE_BYTES: 12, TAG_BYTES: 16, INNER_BYTES: 48, OUTER_BYTES: 64,
  MAX_FILENAME_BYTES: 255, MAX_PLAINTEXT_BYTES: 32 * 1024 * 1024,
  MAX_PASSPHRASE_BYTES: 1024
});
const minFileBytes = V3_LIMITS.CORE_FIXED_BYTES + 1 + V3_LIMITS.NORMAL_BYTES +
  V3_LIMITS.RECOVERY_BYTES + V3_LIMITS.HEADER_FINAL_BYTES + V3_LIMITS.TAG_BYTES;
const maxFileBytes = V3_LIMITS.CORE_FIXED_BYTES + V3_LIMITS.MAX_FILENAME_BYTES +
  V3_LIMITS.NORMAL_BYTES + V3_LIMITS.RECOVERY_BYTES + V3_LIMITS.HEADER_FINAL_BYTES +
  V3_LIMITS.MAX_PLAINTEXT_BYTES + V3_LIMITS.TAG_BYTES;

const invalid = message => { throw new Error('Invalid GestCrypt v3 file: ' + message); };
const authenticationFailed = () => new Error('V3 authentication failed: wrong credentials or modified file.');
const bytesEqual = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
const join = (...parts) => {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};
const aad = (context, ...parts) => join(context, new Uint8Array(1), ...parts);
const digest = bytes => crypto.subtle.digest('SHA-256', bytes).then(buffer => new Uint8Array(buffer));
const hex = bytes => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

function filenameBytes(name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\x00-\x1f\x7f/\\]/u.test(name)) {
    throw new Error('Invalid filename for GestCrypt v3.');
  }
  const bytes = encoder.encode(name);
  if (bytes.length < 1 || bytes.length > V3_LIMITS.MAX_FILENAME_BYTES || decoder.decode(bytes) !== name) {
    throw new Error('Filename exceeds the 255-byte GestCrypt v3 limit or is invalid Unicode.');
  }
  return bytes;
}

function passphraseBytes(passphrase, creating) {
  if (typeof passphrase !== 'string') throw new Error('A passphrase is required.');
  const bytes = encoder.encode(passphrase);
  if (!bytes.length || bytes.length > V3_LIMITS.MAX_PASSPHRASE_BYTES) {
    throw new Error('Passphrase must be 1–1024 UTF-8 bytes.');
  }
  if (creating && (Array.from(passphrase).length < 12 || !passphrase.trim())) {
    bytes.fill(0);
    throw new Error('Use a nonblank passphrase of at least 12 characters for new files.');
  }
  return bytes;
}

async function deriveKek(passphrase, salt, iterations, creating = false) {
  const bytes = passphraseBytes(passphrase, creating);
  try {
    const material = await crypto.subtle.importKey('raw', bytes, 'PBKDF2', false, ['deriveKey']);
    return await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  } finally { bytes.fill(0); }
}

async function keyFor(bytes, usage) {
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, [usage]);
}

function checkDevice(device, usage) {
  const key = device?.key, id = device?.id;
  if (!key || key.type !== 'secret' || key.algorithm?.name !== 'AES-GCM' ||
      key.algorithm.length !== 256 || key.extractable !== false || !Array.isArray(key.usages) ||
      !key.usages.includes(usage) ||
      !(id instanceof Uint8Array) || id.length !== V3_LIMITS.DEVICE_ID_BYTES) {
    throw new Error('A valid non-extractable V3 device key and 16-byte ID are required.');
  }
  return { key, id: id.slice() };
}

async function reserveDeviceNonce(device) {
  if (typeof device?.reserveNonce !== 'function') throw new Error('A persistent V3 device-nonce reservation is required.');
  const nonce = await device.reserveNonce(); // Caller must commit its counter before returning.
  if (!(nonce instanceof Uint8Array) || nonce.length !== V3_LIMITS.NONCE_BYTES ||
      !nonce.subarray(4).some(byte => byte !== 0)) {
    throw new Error('The V3 device-nonce reservation failed.');
  }
  return nonce.slice();
}

function randomBytes(length, source) {
  const bytes = source(length);
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) throw new Error('Secure random bytes are unavailable.');
  return bytes.slice();
}
const secureRandom = length => crypto.getRandomValues(new Uint8Array(length));
function distinctNonce(source, excluded) {
  for (let attempt = 0; attempt < 16; attempt++) {
    const nonce = randomBytes(V3_LIMITS.NONCE_BYTES, source);
    if (excluded.every(other => !bytesEqual(nonce, other))) return nonce;
  }
  throw new Error('Could not allocate a distinct V3 nonce.');
}

function recoveryId(key) {
  return digest(aad(CONTEXT.recoveryId, key)).then(bytes => bytes.slice(0, 8));
}
async function recoveryCheck(key) {
  return (await digest(aad(CONTEXT.recoveryCheck, key))).slice(0, 4);
}
async function freshRecoveryKey(source, previousId) {
  for (let attempt = 0; attempt < 16; attempt++) {
    const candidate = randomBytes(V3_LIMITS.RECOVERY_KEY_BYTES, source);
    if (!bytesEqual(await recoveryId(candidate), previousId)) return candidate;
    candidate.fill(0);
  }
  throw new Error('Could not allocate a distinct V3 recovery key.');
}
export async function encodeV3RecoveryKey(key) {
  if (!(key instanceof Uint8Array) || key.length !== V3_LIMITS.RECOVERY_KEY_BYTES) throw new Error('Recovery key must be 32 bytes.');
  const all = (hex(key) + hex(await recoveryCheck(key))).toUpperCase();
  return all.match(/.{8}/g).join('-');
}
async function decodeRecoveryKey(value) {
  if (typeof value !== 'string' || !/^[0-9a-fA-F\s-]+$/.test(value)) throw new Error('Invalid V3 recovery key.');
  const compact = value.replace(/[\s-]/g, '');
  if (!/^[0-9a-fA-F]{72}$/.test(compact)) throw new Error('Invalid V3 recovery key.');
  const key = Uint8Array.from(compact.slice(0, 64).match(/../g), pair => parseInt(pair, 16));
  const checksum = Uint8Array.from(compact.slice(64).match(/../g), pair => parseInt(pair, 16));
  if (!bytesEqual(checksum, await recoveryCheck(key))) { key.fill(0); throw new Error('Invalid V3 recovery-key checksum.'); }
  return key;
}

function makeCore(name, fileId, dataNonce) {
  const core = new Uint8Array(V3_LIMITS.CORE_FIXED_BYTES + name.length);
  core.set(MAGIC); core[4] = V3_LIMITS.VERSION; core[5] = V3_LIMITS.SUITE_ID;
  core.set(fileId, 8); core.set(dataNonce, 24);
  new DataView(core.buffer).setUint16(36, name.length, false);
  core.set(name, V3_LIMITS.CORE_FIXED_BYTES);
  return core;
}

function makeNormalMeta(iterations, salt, passNonce, deviceId, deviceNonce) {
  const meta = new Uint8Array(61);
  meta[0] = V3_LIMITS.KDF_ID;
  new DataView(meta.buffer).setUint32(1, iterations, false);
  meta.set(salt, 5); meta.set(passNonce, 21); meta.set(deviceId, 33); meta.set(deviceNonce, 49);
  return meta;
}

async function seal(key, nonce, additionalData, plain) {
  return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce,
    additionalData, tagLength: 128 }, key, plain));
}
async function open(key, nonce, additionalData, ciphertext) {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce,
    additionalData, tagLength: 128 }, key, ciphertext));
}

async function makeNormalEnvelope(core, dekBytes, passphrase, device, deviceNonce, source) {
  const salt = randomBytes(16, source);
  const passNonce = randomBytes(V3_LIMITS.NONCE_BYTES, source);
  const meta = makeNormalMeta(V3_LIMITS.WRITE_ITERATIONS, salt, passNonce, device.id, deviceNonce);
  const kek = await deriveKek(passphrase, salt, V3_LIMITS.WRITE_ITERATIONS, true);
  const inner = await seal(kek, passNonce, aad(CONTEXT.pass, core, meta.subarray(0, 33)), dekBytes);
  if (inner.length !== V3_LIMITS.INNER_BYTES) throw new Error('Could not wrap V3 data key.');
  try {
    const outer = await seal(device.key, deviceNonce, aad(CONTEXT.device, core, meta), inner);
    if (outer.length !== V3_LIMITS.OUTER_BYTES) throw new Error('Could not protect V3 passphrase envelope.');
    return join(meta, outer);
  } finally { inner.fill(0); }
}

async function makeRecoveryEnvelope(core, dekBytes, recoveryKey, source) {
  const nonce = randomBytes(V3_LIMITS.NONCE_BYTES, source);
  const meta = join(await recoveryId(recoveryKey), nonce);
  const key = await keyFor(recoveryKey, 'encrypt');
  const wrapped = await seal(key, nonce, aad(CONTEXT.recovery, core, meta), dekBytes);
  if (wrapped.length !== V3_LIMITS.INNER_BYTES) throw new Error('Could not create V3 recovery envelope.');
  return join(meta, wrapped);
}

async function makeHeader(core, normal, recovery, dek, dataNonce, previousNonce, source) {
  const nonce = distinctNonce(source, previousNonce ? [dataNonce, previousNonce] : [dataNonce]);
  const prefix = join(core, normal, recovery, nonce);
  const tag = await seal(dek, nonce, aad(CONTEXT.header, prefix), new Uint8Array());
  if (tag.length !== V3_LIMITS.TAG_BYTES) throw new Error('Could not authenticate V3 header.');
  return join(prefix, tag);
}

export function parseV3(data) {
  if (!(data instanceof Uint8Array)) invalid('expected bytes.');
  if (data.length < minFileBytes || data.length > maxFileBytes) invalid('file length is outside supported bounds.');
  if (MAGIC.some((byte, index) => data[index] !== byte)) throw new Error('Not a GestCrypt file.');
  if (data[4] !== V3_LIMITS.VERSION) throw new Error('Unsupported GestCrypt file version.');
  if (data[5] !== V3_LIMITS.SUITE_ID || data[6] !== 0 || data[7] !== 0) invalid('unsupported suite, flags, or reserved value.');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const nameLength = view.getUint16(36, false);
  if (nameLength < 1 || nameLength > V3_LIMITS.MAX_FILENAME_BYTES) invalid('filename length is outside supported bounds.');
  const S = V3_LIMITS.CORE_FIXED_BYTES + nameLength;
  const R = S + V3_LIMITS.NORMAL_BYTES;
  const T = R + V3_LIMITS.RECOVERY_BYTES;
  const C = T + V3_LIMITS.HEADER_FINAL_BYTES;
  if (data.length < C + V3_LIMITS.TAG_BYTES || data.length - C - V3_LIMITS.TAG_BYTES > V3_LIMITS.MAX_PLAINTEXT_BYTES) {
    invalid('header or ciphertext length is outside supported bounds.');
  }
  if (data[S] !== V3_LIMITS.KDF_ID) invalid('unsupported KDF identifier.');
  const iterations = view.getUint32(S + 1, false);
  if (iterations < V3_LIMITS.MIN_ITERATIONS || iterations > V3_LIMITS.MAX_ITERATIONS) invalid('PBKDF2 iteration count is outside supported bounds.');
  let name;
  const nameBytes = data.subarray(V3_LIMITS.CORE_FIXED_BYTES, S);
  try {
    name = decoder.decode(nameBytes);
    filenameBytes(name);
    if (!bytesEqual(encoder.encode(name), nameBytes)) invalid('filename encoding is not canonical.');
  }
  catch { invalid('filename is not valid UTF-8 or is unsafe.'); }
  return {
    name, nameLength, iterations, core: data.slice(0, S), normalMeta: data.slice(S, S + 61),
    outerEnvelope: data.slice(S + 61, R), recoveryMeta: data.slice(R, R + 20),
    recoveryEnvelope: data.slice(R + 20, T), headerNonce: data.slice(T, T + 12),
    headerTag: data.slice(T + 12, C), headerBeforeTag: data.slice(0, T + 12),
    dataCiphertext: data.slice(C),
    fileId: data.slice(8, 24), dataNonce: data.slice(24, 36),
    salt: data.slice(S + 5, S + 21), passNonce: data.slice(S + 21, S + 33),
    deviceId: data.slice(S + 33, S + 49), deviceNonce: data.slice(S + 49, S + 61),
    recoveryId: data.slice(R, R + 8), recoveryNonce: data.slice(R + 8, R + 20),
    offsets: { S, R, T, C }
  };
}

async function readV3(file) {
  if (!Number.isSafeInteger(file?.size) || file.size < minFileBytes || file.size > maxFileBytes ||
      typeof file.arrayBuffer !== 'function') invalid('file length is outside supported bounds.');
  const data = new Uint8Array(await file.arrayBuffer());
  if (data.length !== file.size) invalid('file size changed while reading.');
  return { data, parsed: parseV3(data) };
}

async function unlockNormal(parsed, passphrase, device) {
  const checked = checkDevice(device, 'decrypt');
  if (!bytesEqual(checked.id, parsed.deviceId)) throw new Error('This V3 file needs its original browser-profile key.');
  let inner;
  try {
    inner = await open(checked.key, parsed.deviceNonce,
      aad(CONTEXT.device, parsed.core, parsed.normalMeta), parsed.outerEnvelope);
    if (inner.length !== V3_LIMITS.INNER_BYTES) throw authenticationFailed();
    const kek = await deriveKek(passphrase, parsed.salt, parsed.iterations);
    const dek = await open(kek, parsed.passNonce,
      aad(CONTEXT.pass, parsed.core, parsed.normalMeta.subarray(0, 33)), inner);
    if (dek.length !== V3_LIMITS.DEK_BYTES) { dek.fill(0); throw authenticationFailed(); }
    return dek;
  } catch { throw authenticationFailed(); }
  finally { inner?.fill(0); }
}

async function unlockRecovery(parsed, code) {
  const keyBytes = await decodeRecoveryKey(code);
  try {
    if (!bytesEqual(await recoveryId(keyBytes), parsed.recoveryId)) throw new Error('Recovery key does not match this V3 file.');
    const key = await keyFor(keyBytes, 'decrypt');
    const dek = await open(key, parsed.recoveryNonce,
      aad(CONTEXT.recovery, parsed.core, parsed.recoveryMeta), parsed.recoveryEnvelope);
    if (dek.length !== V3_LIMITS.DEK_BYTES) { dek.fill(0); throw authenticationFailed(); }
    return dek;
  } catch { throw authenticationFailed(); }
  finally { keyBytes.fill(0); }
}

async function authenticatedPlain(parsed, dekBytes) {
  const key = await crypto.subtle.importKey('raw', dekBytes, 'AES-GCM', false, ['decrypt']);
  const empty = await open(key, parsed.headerNonce,
    aad(CONTEXT.header, parsed.headerBeforeTag), parsed.headerTag);
  if (empty.length !== 0) throw authenticationFailed();
  return open(key, parsed.dataNonce, aad(CONTEXT.data, parsed.core), parsed.dataCiphertext);
}

async function finishDecrypt(parsed, dekBytes) {
  let plain;
  try {
    plain = await authenticatedPlain(parsed, dekBytes);
    const result = { blob: new Blob([plain]), name: parsed.name, hash: hex(await digest(plain)) };
    return result;
  } catch { throw authenticationFailed(); }
  finally { dekBytes.fill(0); plain?.fill(0); }
}

export async function decryptV3Normal(file, passphrase, device) {
  const { parsed } = await readV3(file);
  return finishDecrypt(parsed, await unlockNormal(parsed, passphrase, device));
}

export async function decryptV3Recovery(file, recoveryCode) {
  const { parsed } = await readV3(file);
  return finishDecrypt(parsed, await unlockRecovery(parsed, recoveryCode));
}

export async function encryptV3(file, passphrase, device, { random = secureRandom } = {}) {
  if (!Number.isSafeInteger(file?.size) || file.size < 0 || file.size > V3_LIMITS.MAX_PLAINTEXT_BYTES ||
      typeof file.arrayBuffer !== 'function') throw new Error('File exceeds the 32 MiB GestCrypt v3 plaintext limit.');
  const name = filenameBytes(file.name);
  const checked = checkDevice(device, 'encrypt');
  const passBytes = passphraseBytes(passphrase, true); passBytes.fill(0);
  const deviceNonce = await reserveDeviceNonce(device);
  const plain = new Uint8Array(await file.arrayBuffer());
  if (plain.length !== file.size || plain.length > V3_LIMITS.MAX_PLAINTEXT_BYTES) {
    plain.fill(0); throw new Error('File size changed while reading.');
  }
  let dekBytes, recoveryKey;
  try {
    dekBytes = randomBytes(V3_LIMITS.DEK_BYTES, random);
    recoveryKey = randomBytes(V3_LIMITS.RECOVERY_KEY_BYTES, random);
    const fileId = randomBytes(16, random);
    const dataNonce = randomBytes(V3_LIMITS.NONCE_BYTES, random);
    const core = makeCore(name, fileId, dataNonce);
    const normal = await makeNormalEnvelope(core, dekBytes, passphrase, checked, deviceNonce, random);
    const recovery = await makeRecoveryEnvelope(core, dekBytes, recoveryKey, random);
    const dek = await crypto.subtle.importKey('raw', dekBytes, 'AES-GCM', false, ['encrypt']);
    const header = await makeHeader(core, normal, recovery, dek, dataNonce, null, random);
    const ciphertext = await seal(dek, dataNonce, aad(CONTEXT.data, core), plain);
    const out = join(header, ciphertext);
    return { blob: new Blob([out]), recoveryKey: recoveryKey.slice(),
      recoveryCode: await encodeV3RecoveryKey(recoveryKey), recoveryId: await recoveryId(recoveryKey),
      hash: hex(await digest(plain)) };
  } finally { plain.fill(0); dekBytes?.fill(0); recoveryKey?.fill(0); }
}

export async function rewrapV3(file, unlock, newPassphrase, newDevice,
  { random = secureRandom, rotateRecoveryKey = false } = {}) {
  const { parsed } = await readV3(file);
  if (!unlock || (typeof unlock.recoveryCode === 'string') === (typeof unlock.passphrase === 'string')) {
    throw new Error('Choose exactly one V3 unlock path for rewrapping.');
  }
  const checked = checkDevice(newDevice, 'encrypt');
  const passBytes = passphraseBytes(newPassphrase, true); passBytes.fill(0);
  const deviceNonce = await reserveDeviceNonce(newDevice);
  const dekBytes = typeof unlock.recoveryCode === 'string'
    ? await unlockRecovery(parsed, unlock.recoveryCode)
    : await unlockNormal(parsed, unlock.passphrase, unlock.device);
  let plain, newRecoveryKey;
  try {
    try { plain = await authenticatedPlain(parsed, dekBytes); }
    catch { throw authenticationFailed(); }
    plain.fill(0); plain = null;
    const normal = await makeNormalEnvelope(parsed.core, dekBytes, newPassphrase, checked, deviceNonce, random);
    if (rotateRecoveryKey) newRecoveryKey = await freshRecoveryKey(random, parsed.recoveryId);
    const recovery = rotateRecoveryKey
      ? await makeRecoveryEnvelope(parsed.core, dekBytes, newRecoveryKey, random)
      : join(parsed.recoveryMeta, parsed.recoveryEnvelope);
    const dek = await crypto.subtle.importKey('raw', dekBytes, 'AES-GCM', false, ['encrypt']);
    const header = await makeHeader(parsed.core, normal, recovery, dek,
      parsed.dataNonce, parsed.headerNonce, random);
    const output = { blob: new Blob([join(header, parsed.dataCiphertext)]), name: parsed.name };
    if (rotateRecoveryKey) {
      const recoveryCode = await encodeV3RecoveryKey(newRecoveryKey);
      const id = await recoveryId(newRecoveryKey);
      output.recoveryKey = newRecoveryKey.slice();
      output.recoveryCode = recoveryCode;
      output.recoveryId = id;
    }
    return output;
  } finally { dekBytes.fill(0); plain?.fill(0); newRecoveryKey?.fill(0); }
}
