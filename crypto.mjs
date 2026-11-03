import { CFG } from './gesture.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });
const TAG_BYTES = 16;
const FIXED_HEADER_BYTES = 35;

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256 = async buf => hex(await crypto.subtle.digest('SHA-256', buf));

async function deriveKey(sig, pin, salt) {
  const material = await crypto.subtle.importKey('raw', enc.encode(sig + '|' + pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: CFG.KDF_ITER, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// Version 1: GCRY | version | salt(16) | IV(12) | name length(2) | name | ciphertext + GCM tag.
export function parseEncrypted(data) {
  if (!(data instanceof Uint8Array) || data.length < FIXED_HEADER_BYTES + TAG_BYTES) throw new Error('Invalid GestCrypt file: truncated header or authentication tag.');
  if (enc.encode('GCRY').some((byte, i) => data[i] !== byte)) throw new Error('Not a GestCrypt file.');
  if (data[4] !== 1) throw new Error('Unsupported GestCrypt file version.');
  const nameLength = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(33);
  const headerLength = FIXED_HEADER_BYTES + nameLength;
  if (headerLength > data.length - TAG_BYTES) throw new Error('Invalid GestCrypt file: filename or ciphertext is truncated.');
  let name;
  try { name = dec.decode(data.subarray(FIXED_HEADER_BYTES, headerLength)); }
  catch { throw new Error('Invalid GestCrypt file: filename is not UTF-8.'); }
  return {
    salt: data.slice(5, 21), iv: data.slice(21, 33),
    header: data.slice(0, headerLength), ciphertext: data.slice(headerLength), name
  };
}

export async function encryptFile(file, sig, pin) {
  const name = enc.encode(file.name);
  if (name.length > 65535) throw new Error('Filename is too long for GestCrypt version 1.');
  const plain = await file.arrayBuffer();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const header = new Uint8Array(FIXED_HEADER_BYTES + name.length);
  header.set(enc.encode('GCRY'), 0); header[4] = 1;
  header.set(salt, 5); header.set(iv, 21);
  new DataView(header.buffer).setUint16(33, name.length);
  header.set(name, FIXED_HEADER_BYTES);
  const t0 = performance.now();
  const key = await deriveKey(sig, pin, salt);
  const t1 = performance.now();
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: header }, key, plain));
  const t2 = performance.now();
  const out = new Uint8Array(header.length + ct.length);
  out.set(header); out.set(ct, header.length);
  return { blob: new Blob([out]), hash: await sha256(plain), kdfMs: t1 - t0, aesMs: t2 - t1 };
}

export async function decryptFile(file, sig, pin) {
  const data = new Uint8Array(await file.arrayBuffer());
  const { salt, iv, header, ciphertext, name } = parseEncrypted(data);
  const t0 = performance.now();
  const key = await deriveKey(sig, pin, salt);
  const t1 = performance.now();
  let plain;
  try { plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: header }, key, ciphertext); }
  catch { throw new Error('Decryption failed: wrong gesture or PIN, or the file was modified.'); }
  const t2 = performance.now();
  return { blob: new Blob([plain]), name, hash: await sha256(plain), kdfMs: t1 - t0, aesMs: t2 - t1 };
}
