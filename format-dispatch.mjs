import { decryptFile } from './crypto.mjs';
import { decryptV2 } from './vault-v2.mjs';

const MAGIC = new TextEncoder().encode('GCRY');

export async function detectFormat(file) {
  if (!file || file.size < 5 || typeof file.slice !== 'function') throw new Error('Invalid GestCrypt file: truncated header.');
  const prefix = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  if (prefix.length !== 5) throw new Error('Invalid GestCrypt file: truncated header.');
  if (MAGIC.some((byte, index) => prefix[index] !== byte)) throw new Error('Not a GestCrypt file.');
  if (prefix[4] !== 1 && prefix[4] !== 2) throw new Error('Unsupported GestCrypt file version.');
  return prefix[4];
}

export async function decryptByVersion(file, { passphrase, getLegacyCredentials } = {}) {
  const version = await detectFormat(file);
  if (version === 2) return decryptV2(file, passphrase);
  if (typeof getLegacyCredentials !== 'function') throw new Error('Version 1 requires a gesture and optional PIN.');
  const { sig, pin = '' } = await getLegacyCredentials();
  return decryptFile(file, sig, pin);
}
