import test from 'node:test';
import assert from 'node:assert/strict';
import { runSecurityAttackLab, summarizeAttackLab } from '../security-lab.mjs';

test('attack lab runs every declared synthetic scenario and reports evidence without secrets', async () => {
  const observed = [];
  const results = await runSecurityAttackLab(result => observed.push(result.id));
  assert.deepEqual(observed, [
    'wrong_passphrase', 'v1_body', 'v2_body', 'wrap_tag', 'metadata', 'nonce',
    'truncated', 'unsupported', 'version_rewrite', 'valid_recovery'
  ]);
  assert.deepEqual(summarizeAttackLab(results),
    { total: 10, resisted: 8, controls: 1, failed: 0, limitations: 1, notTested: 0 });
  for (const result of results) {
    assert.equal(result.tested, true);
    for (const field of ['name', 'explanation', 'expected', 'observed', 'principle']) {
      assert.ok(result[field].length > 0, `${result.id} needs ${field}`);
    }
  }
  assert.match(results.find(result => result.id === 'version_rewrite').observed,
    /Passphrase-to-gesture format redirection requested gesture credentials 1 time\(s\).*Both returned no plaintext/);
  for (const result of results) {
    for (const field of ['name', 'explanation', 'expected', 'observed', 'principle']) {
      assert.doesNotMatch(result[field], /\bV[123]\b|\bversion[- ](?:byte|[123])\b/i);
    }
  }
  assert.equal(results.find(result => result.id === 'version_rewrite').status, 'LIMITATION');
  assert.equal(results.find(result => result.id === 'valid_recovery').kind, 'control');
  assert.equal(results.find(result => result.id === 'valid_recovery').status, 'PASS');
  assert.equal(results.filter(result => result.kind === 'attack' && result.status === 'PASS').length, 8);
  assert.match(results.find(result => result.id === 'valid_recovery').observed, /exact bytes, filename, and matching hashes/);
  const display = JSON.stringify(results);
  for (const secret of ['synthetic-pin', 'synthetic attack lab passphrase', 'GC1:', 'private data']) {
    assert.equal(display.includes(secret), false);
  }
});

test('summary keeps untested scenarios separate from attempted failures and limitations', () => {
  assert.deepEqual(summarizeAttackLab([
    { kind: 'attack', status: 'PASS', tested: true }, { kind: 'control', status: 'PASS', tested: true },
    { kind: 'attack', status: 'FAIL', tested: true }, { kind: 'attack', status: 'LIMITATION', tested: true },
    { kind: 'control', status: 'LIMITATION', tested: false }
  ]), { total: 5, resisted: 1, controls: 1, failed: 1, limitations: 1, notTested: 1 });
});
