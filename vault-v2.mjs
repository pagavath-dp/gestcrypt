const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const MAGIC = encoder.encode('GCRY');
const WRAP_CONTEXT = encoder.encode('GestCrypt-v2-wrap');
const DATA_CONTEXT = encoder.encode('GestCrypt-v2-data');

export const V2_LIMITS = Object.freeze({
  VERSION: 2,
  KDF_ID: 1, // PBKDF2-HMAC-SHA-256
  WRITE_ITERATIONS: 600000,
  MIN_ITERATIONS: 600000,
  MAX_ITERATIONS: 1200000,
  SALT_BYTES: 16,
  NONCE_BYTES: 12,
  DEK_BYTES: 32,
  TAG_BYTES: 16,
  WRAPPED_DEK_BYTES: 48,
  PREFIX_BYTES: 52,
  MAX_FILENAME_BYTES: 255,
  MAX_PLAINTEXT_BYTES: 32 * 1024 * 1024,
  MAX_PASSPHRASE_BYTES: 1024
});

const headerBytes = nameLength => V2_LIMITS.PREFIX_BYTES + nameLength + V2_LIMITS.WRAPPED_DEK_BYTES;
const maxFileBytes = V2_LIMITS.MAX_PLAINTEXT_BYTES + headerBytes(V2_LIMITS.MAX_FILENAME_BYTES) + V2_LIMITS.TAG_BYTES;

function invalid(message) { throw new Error('Invalid GestCrypt v2 file: ' + message); }
function aad(context, bytes) {
  const out = new Uint8Array(context.length + 1 + bytes.length);
  out.set(context);
  out.set(bytes, context.length + 1);
  return out;
}
function checkName(name) {
  if (!name || name === '.' || name === '..' || /[\x00-\x1f\x7f/\\]/u.test(name)) {
    throw new Error('Invalid filename for GestCrypt v2.');
  }
}
function passphraseBytes(passphrase, { creating = false } = {}) {
  if (typeof passphrase !== 'string') throw new Error('A passphrase is required.');
  const bytes = encoder.encode(passphrase);
  if (!bytes.length || bytes.length > V2_LIMITS.MAX_PASSPHRASE_BYTES) throw new Error('Passphrase must be 1–1024 UTF-8 bytes.');
  if (creating && (Array.from(passphrase).length < 12 || !passphrase.trim())) {
    throw new Error('Use a nonblank passphrase of at least 12 characters for new files.');
  }
  return bytes;
}
async function deriveKek(passphrase, salt, iterations, options) {
  const bytes = passphraseBytes(passphrase, options);
  let material;
  try { material = await crypto.subtle.importKey('raw', bytes, 'PBKDF2', false, ['deriveKey']); }
  finally { bytes.fill(0); }
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
  .map(byte => byte.toString(16).padStart(2, '0')).join('');

export function parseV2(data) {
  if (!(data instanceof Uint8Array)) invalid('expected bytes.');
  if (data.length < headerBytes(1) + V2_LIMITS.TAG_BYTES || data.length > maxFileBytes) invalid('file length is outside supported bounds.');
  if (MAGIC.some((byte, index) => data[index] !== byte)) throw new Error('Not a GestCrypt file.');
  if (data[4] !== V2_LIMITS.VERSION) throw new Error('Unsupported GestCrypt file version.');
  if (data[5] !== V2_LIMITS.KDF_ID) invalid('unsupported KDF identifier.');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const iterations = view.getUint32(6, false);
  if (iterations < V2_LIMITS.MIN_ITERATIONS || iterations > V2_LIMITS.MAX_ITERATIONS) invalid('PBKDF2 iteration count is outside supported bounds.');
  const nameLength = view.getUint16(50, false);
  if (nameLength < 1 || nameLength > V2_LIMITS.MAX_FILENAME_BYTES) invalid('filename length is outside supported bounds.');
  const prefixEnd = V2_LIMITS.PREFIX_BYTES + nameLength;
  const headerEnd = headerBytes(nameLength);
  if (data.length < headerEnd + V2_LIMITS.TAG_BYTES || data.length - headerEnd - V2_LIMITS.TAG_BYTES > V2_LIMITS.MAX_PLAINTEXT_BYTES) {
    invalid('header, wrapped key, or ciphertext length is invalid.');
  }
  let name;
  try { name = decoder.decode(data.subarray(V2_LIMITS.PREFIX_BYTES, prefixEnd)); checkName(name); }
  catch { invalid('filename is not valid UTF-8 or is unsafe.'); }
  return {
    iterations,
    salt: data.slice(10, 26),
    wrapIv: data.slice(26, 38),
    dataIv: data.slice(38, 50),
    prefix: data.slice(0, prefixEnd),
    header: data.slice(0, headerEnd),
    wrappedDek: data.slice(prefixEnd, headerEnd),
    ciphertext: data.slice(headerEnd),
    name
  };
}

export async function encryptV2(file, passphrase) {
  if (!Number.isSafeInteger(file?.size) || file.size < 0 || file.size > V2_LIMITS.MAX_PLAINTEXT_BYTES) {
    throw new Error('File exceeds the 32 MiB GestCrypt v2 plaintext limit.');
  }
  checkName(file.name);
  const name = encoder.encode(file.name);
  if (name.length > V2_LIMITS.MAX_FILENAME_BYTES) throw new Error('Filename exceeds the 255-byte GestCrypt v2 limit.');
  const plain = new Uint8Array(await file.arrayBuffer());
  if (plain.length > V2_LIMITS.MAX_PLAINTEXT_BYTES) throw new Error('File exceeds the 32 MiB GestCrypt v2 plaintext limit.');
  const salt = crypto.getRandomValues(new Uint8Array(V2_LIMITS.SALT_BYTES));
  const wrapIv = crypto.getRandomValues(new Uint8Array(V2_LIMITS.NONCE_BYTES));
  const dataIv = crypto.getRandomValues(new Uint8Array(V2_LIMITS.NONCE_BYTES));
  const dekBytes = crypto.getRandomValues(new Uint8Array(V2_LIMITS.DEK_BYTES));
  try {
    const prefix = new Uint8Array(V2_LIMITS.PREFIX_BYTES + name.length);
    prefix.set(MAGIC); prefix[4] = V2_LIMITS.VERSION; prefix[5] = V2_LIMITS.KDF_ID;
    const view = new DataView(prefix.buffer);
    view.setUint32(6, V2_LIMITS.WRITE_ITERATIONS, false);
    prefix.set(salt, 10); prefix.set(wrapIv, 26); prefix.set(dataIv, 38);
    view.setUint16(50, name.length, false); prefix.set(name, V2_LIMITS.PREFIX_BYTES);
    const t0 = performance.now();
    const kek = await deriveKek(passphrase, salt, V2_LIMITS.WRITE_ITERATIONS, { creating: true });
    const t1 = performance.now();
    const wrappedDek = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: wrapIv,
      additionalData: aad(WRAP_CONTEXT, prefix), tagLength: 128 }, kek, dekBytes));
    if (wrappedDek.length !== V2_LIMITS.WRAPPED_DEK_BYTES) throw new Error('Could not wrap the data key.');
    const dek = await crypto.subtle.importKey('raw', dekBytes, 'AES-GCM', false, ['encrypt']);
    const header = new Uint8Array(prefix.length + wrappedDek.length);
    header.set(prefix); header.set(wrappedDek, prefix.length);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: dataIv,
      additionalData: aad(DATA_CONTEXT, header), tagLength: 128 }, dek, plain));
    const t2 = performance.now();
    const out = new Uint8Array(header.length + ciphertext.length);
    out.set(header); out.set(ciphertext, header.length);
    return { blob: new Blob([out]), hash: await hash(plain), kdfMs: t1 - t0, aesMs: t2 - t1 };
  } finally { dekBytes.fill(0); }
}

export async function decryptV2(file, passphrase) {
  if (!Number.isSafeInteger(file?.size) || file.size < 0 || file.size > maxFileBytes) invalid('file length is outside supported bounds.');
  const parsed = parseV2(new Uint8Array(await file.arrayBuffer()));
  const t0 = performance.now();
  const kek = await deriveKek(passphrase, parsed.salt, parsed.iterations);
  const t1 = performance.now();
  let dekBytes;
  try {
    dekBytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: parsed.wrapIv,
      additionalData: aad(WRAP_CONTEXT, parsed.prefix), tagLength: 128 }, kek, parsed.wrappedDek));
    if (dekBytes.length !== V2_LIMITS.DEK_BYTES) throw new Error('Invalid data key.');
    const dek = await crypto.subtle.importKey('raw', dekBytes, 'AES-GCM', false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: parsed.dataIv,
      additionalData: aad(DATA_CONTEXT, parsed.header), tagLength: 128 }, dek, parsed.ciphertext);
    const t2 = performance.now();
    return { blob: new Blob([plain]), name: parsed.name, hash: await hash(plain), kdfMs: t1 - t0, aesMs: t2 - t1 };
  } catch { throw new Error('Decryption failed: wrong passphrase or the file was modified.'); }
  finally { dekBytes?.fill(0); }
}
