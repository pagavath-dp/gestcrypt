import test from 'node:test';
import assert from 'node:assert/strict';
import { beginReference, csvCell, trialsCsv } from '../evaluation.mjs';

test('a new reference starts a fresh trial group', () => {
  const oldRows = [{ label: 'old', sig: 'secret', result: 'MATCH' }];
  const rows = beginReference('new', 'new signature');
  assert.deepEqual(rows, [{ label: 'new', sig: 'new signature', result: 'REFERENCE' }]);
  assert.notDeepEqual(rows, oldRows);
});

test('CSV doubles quotes and preserves commas and newlines', () => {
  assert.equal(csvCell('A,"B"\nC'), '"A,""B""\nC"');
  assert.equal(trialsCsv([{ label: 'A,"B"\nC', sig: 'raw-secret', result: 'MATCH' }]),
    'trial,label,result\r\n"1","A,""B""\nC","MATCH"\r\n');
});

test('CSV neutralizes formula-prefixed user fields', () => {
  for (const value of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', ' \t=1+1', '\n=1+1']) {
    assert.equal(csvCell(value), '"\'' + value + '"');
  }
});

test('CSV omits raw signatures and PIN fields', () => {
  const csv = trialsCsv([{ label: 'trial 1', sig: 'GC1:T0-I0', pin: '1234', result: 'MISMATCH' }]);
  assert.equal(csv.includes('GC1:'), false);
  assert.equal(csv.includes('1234'), false);
  assert.equal(csv.includes('trial 1'), true);
});
