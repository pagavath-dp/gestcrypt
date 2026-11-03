import { encryptFile, decryptFile, parseEncrypted } from './crypto.mjs';
import { encryptV2, decryptV2, parseV2 } from './vault-v2.mjs';
import { decryptByVersion } from './format-dispatch.mjs';

const PASSPHRASE = 'synthetic attack lab passphrase';
const SIGNATURE = 'GC1:T0-I2-M2-R0-P0-a0-bx-cx';
const PIN = 'synthetic-pin';
const CONTENT = new Uint8Array([0, 1, 2, 42, 127, 128, 254, 255]);
const NAME = 'attack-lab.bin';
const asFile = bytes => new File([bytes], 'synthetic.gcry');
const bytesOf = async blob => new Uint8Array(await blob.arrayBuffer());
const changed = (source, offset, value) => {
  const copy = source.slice();
  copy[offset] = value ?? (copy[offset] ^ 1);
  return copy;
};

async function rejected(operation, expectedError) {
  let result;
  try { result = await operation(); }
  catch (error) {
    return { safe: result === undefined && expectedError.test(error.message),
      observed: expectedError.test(error.message) ? 'Rejected; no plaintext result.' : 'Unexpected decryption error; no plaintext result.' };
  }
  return { safe: false, observed: `Decryption returned ${result?.blob ? 'a plaintext blob' : 'without the expected rejection'}.` };
}
const allSafe = async checks => {
  const outcomes = [];
  for (const check of checks) outcomes.push(await check());
  return { safe: outcomes.every(outcome => outcome.safe),
    observed: outcomes.every(outcome => outcome.safe)
      ? `${outcomes.length} modified file${outcomes.length === 1 ? '' : 's'} rejected; no plaintext result.`
      : outcomes.filter(outcome => !outcome.safe).map(outcome => outcome.observed).join(' ') };
};

export function summarizeAttackLab(results) {
  return {
    total: results.length,
    resisted: results.filter(result => result.kind === 'attack' && result.status === 'PASS').length,
    controls: results.filter(result => result.kind === 'control' && result.status === 'PASS').length,
    failed: results.filter(result => result.status === 'FAIL').length,
    limitations: results.filter(result => result.status === 'LIMITATION' && result.tested).length,
    notTested: results.filter(result => !result.tested).length
  };
}

// The lab creates all inputs here. It never reads the user's selected file or form credentials.
export async function runSecurityAttackLab(onResult = () => {}) {
  const definitions = [
    ['wrong_passphrase', 'Wrong passphrase', 'Try to open a synthetic passphrase-protected file using an incorrect passphrase.',
      'Reject key unwrapping and return no plaintext.', 'Passphrase-derived key protection'],
    ['v1_body', 'Ciphertext tampering (gesture-protected file)', 'Flip a byte inside the gesture-protected file ciphertext, outside its tag.',
      'Reject the modified ciphertext and return no plaintext.', 'AES-GCM integrity'],
    ['v2_body', 'Ciphertext tampering (passphrase-protected file)', 'Flip a byte inside the passphrase-protected file ciphertext, outside its tag.',
      'Reject the modified ciphertext and return no plaintext.', 'AES-GCM integrity'],
    ['wrap_tag', 'Wrapped-key tag tampering', 'Flip a byte in the authentication tag protecting the wrapped data key.',
      'Reject key unwrapping and return no plaintext.', 'Authenticated key wrapping'],
    ['metadata', 'Header and metadata tampering', 'Alter the visible filename in both synthetic file headers.',
      'Reject both files; authenticated metadata cannot be silently changed.', 'Authenticated additional data'],
    ['nonce', 'Nonce modification', 'Alter the gesture-protected file IV and both passphrase-protected file nonces independently.',
      'Reject each modified file and return no plaintext.', 'Nonce-bound AES-GCM authentication'],
    ['truncated', 'Truncated vault file', 'Remove bytes so each format has less than a complete file authentication tag.',
      'Reject malformed lengths before key derivation.', 'Fail-closed parsing'],
    ['unsupported', 'Unsupported file format', 'Replace the file-format marker with an unsupported value.',
      'Reject before asking for gesture credentials.', 'Format validation before authentication'],
    ['version_rewrite', 'File-format marker modification', 'Redirect each synthetic file toward the other format by changing only its format marker.',
      'Return no plaintext; note that a changed marker can request gesture credentials before authentication.',
      'Untrusted pre-authentication dispatch'],
    ['valid_recovery', 'Valid recovery and integrity', 'Decrypt fresh synthetic files in both test formats.',
      'Recover the exact filename and bytes; encryption and decryption hashes agree.', 'Authenticated recovery']
  ];
  const results = [];
  let v1, v2, v1HeaderEnd, v2HeaderEnd, v2PrefixEnd, v1Hash, v2Hash;
  try {
    const source = new File([CONTENT], NAME);
    const first = await encryptFile(source, SIGNATURE, PIN);
    const second = await encryptV2(source, PASSPHRASE);
    v1 = await bytesOf(first.blob); v2 = await bytesOf(second.blob);
    v1HeaderEnd = parseEncrypted(v1).header.length;
    const parsed = parseV2(v2);
    v2HeaderEnd = parsed.header.length; v2PrefixEnd = parsed.prefix.length;
    v1Hash = first.hash; v2Hash = second.hash;
  } catch {
    for (const [id, name, explanation, expected, principle] of definitions) {
      const result = { id, kind: id === 'valid_recovery' ? 'control' : 'attack', name, explanation, expected, observed: 'Not tested: synthetic setup failed.',
        status: 'LIMITATION', principle, tested: false };
      results.push(result); onResult(result);
    }
    return results;
  }
  const authV1 = /Decryption failed: wrong gesture or PIN, or the file was modified/;
  const authV2 = /Decryption failed: wrong passphrase or the file was modified/;
  const actions = [
    () => rejected(() => decryptV2(asFile(v2), 'incorrect synthetic passphrase'), authV2),
    () => rejected(() => decryptFile(asFile(changed(v1, v1HeaderEnd)), SIGNATURE, PIN), authV1),
    () => rejected(() => decryptV2(asFile(changed(v2, v2HeaderEnd)), PASSPHRASE), authV2),
    () => rejected(() => decryptV2(asFile(changed(v2, v2PrefixEnd + 32)), PASSPHRASE), authV2),
    () => allSafe([
      () => rejected(() => decryptFile(asFile(changed(v1, 35)), SIGNATURE, PIN), authV1),
      () => rejected(() => decryptV2(asFile(changed(v2, 52)), PASSPHRASE), authV2)
    ]),
    () => allSafe([
      () => rejected(() => decryptFile(asFile(changed(v1, 21)), SIGNATURE, PIN), authV1),
      () => rejected(() => decryptV2(asFile(changed(v2, 26)), PASSPHRASE), authV2),
      () => rejected(() => decryptV2(asFile(changed(v2, 38)), PASSPHRASE), authV2)
    ]),
    () => allSafe([
      () => rejected(() => decryptFile(asFile(v1.slice(0, v1HeaderEnd + 15)), SIGNATURE, PIN), /Invalid GestCrypt file/),
      () => rejected(() => decryptV2(asFile(v2.slice(0, v2HeaderEnd + 15)), PASSPHRASE), /Invalid GestCrypt v2 file/)
    ]),
    async () => {
      let calls = 0;
      const outcome = await rejected(() => decryptByVersion(asFile(changed(v2, 4, 3)), {
        passphrase: PASSPHRASE, getLegacyCredentials: async () => { calls++; return { sig: SIGNATURE, pin: PIN }; }
      }), /Unsupported GestCrypt file version/);
      return { safe: outcome.safe && calls === 0,
        observed: outcome.safe && calls === 0 ? 'Unsupported format rejected; gesture credentials not requested.' : outcome.observed };
    },
    async () => {
      let v2ToV1Calls = 0, v1ToV2Calls = 0;
      const first = await rejected(() => decryptByVersion(asFile(changed(v2, 4, 1)), {
        passphrase: PASSPHRASE, getLegacyCredentials: async () => { v2ToV1Calls++; return { sig: SIGNATURE, pin: PIN }; }
      }), /Invalid GestCrypt file|Decryption failed/);
      const second = await rejected(() => decryptByVersion(asFile(changed(v1, 4, 2)), {
        passphrase: PASSPHRASE, getLegacyCredentials: async () => { v1ToV2Calls++; return { sig: SIGNATURE, pin: PIN }; }
      }), /Invalid GestCrypt v2 file|Decryption failed/);
      const safe = first.safe && second.safe && v2ToV1Calls === 1 && v1ToV2Calls === 0;
      return { safe, observed: `Passphrase-to-gesture format redirection requested gesture credentials ${v2ToV1Calls} time(s); reverse redirection requested them ${v1ToV2Calls} time(s). ${first.safe && second.safe ? 'Both returned no plaintext.' : 'Unexpected recovery outcome.'}` };
    },
    async () => {
      const first = await decryptFile(asFile(v1), SIGNATURE, PIN);
      const second = await decryptV2(asFile(v2), PASSPHRASE);
      const recovered = [await bytesOf(first.blob), await bytesOf(second.blob)];
      const safe = [first, second].every((result, index) => result.name === NAME &&
        result.hash === [v1Hash, v2Hash][index] &&
        recovered[index].length === CONTENT.length && recovered[index].every((byte, offset) => byte === CONTENT[offset]));
      return { safe, observed: safe ? 'Both synthetic files recovered exact bytes, filename, and matching hashes.' : 'Recovered data, name, or hash differed.' };
    }
  ];
  for (let index = 0; index < definitions.length; index++) {
    const [id, name, explanation, expected, principle] = definitions[index];
    let outcome, tested = true;
    try { outcome = await actions[index](); }
    catch { tested = false; outcome = { safe: false, observed: 'Not tested: scenario execution failed.' }; }
    const status = !tested ? 'LIMITATION' : outcome.safe ? id === 'version_rewrite' ? 'LIMITATION' : 'PASS' : 'FAIL';
    const result = { id, kind: id === 'valid_recovery' ? 'control' : 'attack', name, explanation, expected, observed: outcome.observed, status, principle, tested };
    results.push(result); onResult(result);
  }
  return results;
}
