import test from 'node:test';
import assert from 'node:assert/strict';
import { StudyRecorder } from '../study.mjs';

const sample = changes => ({ med: { thumb: 1, index: 1, middle: 1, ring: 1, pinky: 1,
  sp_im: 0, sp_mr: 0, sp_rp: 0, ...changes }, sd: { thumb: 0, index: 0,
    middle: 0, ring: 0, pinky: 0, sp_im: 0, sp_mr: 0, sp_rp: 0 } });
const meta = changes => ({ participantId: 'P01', sessionId: 'S01', split: 'pilot', role: 'trial',
  poseId: 'fist', relation: 'genuine', sceneCondition: 'single', observedHands: 'one',
  retryIndex: 1, browserCode: 'chrome_current', cameraCode: 'built_in', lightingCode: 'normal', ...changes });
const record = (study, changes, result) => {
  const id = study.begin(meta(changes), 100);
  study.finish(id, { ...result, now: 250 });
  return id;
};

test('reference rejection is recorded per configuration and never counted as a mismatch', () => {
  const study = new StudyRecorder({ studyId: 'STUDY-TEST' });
  const refId = record(study, { role: 'reference', relation: 'reference' }, { summary: sample({ index: 1.325 }) });
  const trialId = record(study, {}, { summary: sample({ index: 1.325 }) });
  const rows = study.rows().filter(row => row.attempt_id === trialId);
  const loose = rows.find(row => row.config_id === 'loose');
  const baseline = rows.find(row => row.config_id === 'baseline');
  assert.equal(loose.reference_id, refId);
  assert.equal(loose.match, 1);
  assert.equal(baseline.quantization_outcome, 'rejected');
  assert.equal(baseline.comparison_status, 'no_reference_for_config');
  assert.equal(baseline.match, null);
  assert.equal(baseline.reference_available, 0);
  assert.equal(study.summary().metrics.pilot.baseline.genuine.end_to_end_match.denominator, 0);
});

test('a successful trial with a rejected candidate reference says no_reference_for_config', () => {
  const study = new StudyRecorder({ studyId: 'STUDY-TEST' });
  record(study, { role: 'reference', relation: 'reference' }, { summary: sample({ index: 1.325 }) });
  const id = record(study, {}, { summary: sample({ index: 1 }) });
  const baseline = study.rows().find(row => row.attempt_id === id && row.config_id === 'baseline');
  assert.equal(baseline.quantization_outcome, 'accepted');
  assert.equal(baseline.comparison_status, 'no_reference_for_config');
  assert.equal(baseline.rejection_code, '');
  assert.equal(baseline.signature_produced, 1);
  assert.equal(baseline.match, null);
});

test('earlier reference groups and rejected attempts remain in the study history', () => {
  const study = new StudyRecorder({ studyId: 'STUDY-TEST' });
  const firstRef = record(study, { role: 'reference', relation: 'reference' }, { summary: sample() });
  const rejected = record(study, {}, { captureCode: 'multi_hand', captureMs: 30 });
  const secondRef = record(study, { role: 'reference', relation: 'reference', poseId: 'open_palm' }, { summary: sample({ index: 2 }) });
  const secondTrial = record(study, { poseId: 'open_palm' }, { summary: sample({ index: 2 }) });
  const rows = study.rows();
  assert.equal(study.attempts.length, 4);
  assert.equal(rows.length, 12);
  assert.equal(rows.find(row => row.attempt_id === rejected && row.config_id === 'baseline').reference_id, firstRef);
  assert.equal(rows.find(row => row.attempt_id === rejected && row.config_id === 'baseline').capture_outcome, 'state_reject');
  assert.equal(rows.find(row => row.attempt_id === rejected && row.config_id === 'baseline').match, null);
  assert.equal(rows.find(row => row.attempt_id === secondTrial && row.config_id === 'baseline').reference_id, secondRef);
});

test('missing observations and zero denominators are explicit, with planned counts', () => {
  const study = new StudyRecorder({ studyId: 'STUDY-TEST' });
  study.setPlanned('pilot', 3);
  record(study, {}, { captureCode: 'not_ready', captureMs: 0 });
  record(study, {}, { captureCode: 'missing', protocolStatus: 'missing' });
  const summary = study.summary();
  assert.equal(summary.planned.pilot, 3);
  assert.equal(summary.recorded.pilot, 2);
  assert.equal(summary.uninitiated.pilot, 1);
  assert.equal(summary.exclusions, 1);
  assert.throws(() => study.setPlanned('pilot', 4), /cannot change/);
  assert.deepEqual(summary.metrics.pilot.baseline.genuine.signature_acceptance,
    { numerator: 0, denominator: 1, value: 0 });
  assert.deepEqual(summary.metrics.heldout.baseline.impostor.end_to_end_match,
    { numerator: 0, denominator: 0, value: null });
});

test('routine exports exclude signatures, feature summaries, and secrets', () => {
  const study = new StudyRecorder({ studyId: 'STUDY-TEST' });
  const sensitive = sample(); sensitive.pin = 'secret-pin'; sensitive.rawLandmarks = 'private-landmarks';
  record(study, { role: 'reference', relation: 'reference' }, { summary: sensitive });
  record(study, {}, { summary: sample() });
  const exported = study.csv() + study.json();
  for (const secret of ['GC1:', 'secret-pin', 'private-landmarks', 'passphrase', 'plaintext']) {
    assert.equal(exported.includes(secret), false);
  }
  assert.match(study.csv(), /reference_available/);
  assert.match(study.json(), /"frozen_config_id": null/);
});

test('pilot must be recorded and frozen before held-out attempts', () => {
  const study = new StudyRecorder({ studyId: 'STUDY-TEST' });
  assert.throws(() => study.begin(meta({ split: 'heldout' })), /Freeze/);
  assert.throws(() => study.freeze('baseline'), /pilot/);
  record(study, {}, { captureCode: 'not_ready' });
  study.freeze('baseline');
  assert.equal(study.frozenConfigId, 'baseline');
  assert.throws(() => study.begin(meta({ split: 'pilot' })), /closed/);
  const id = record(study, { split: 'heldout' }, { captureCode: 'not_ready' });
  assert.equal(study.rows().find(row => row.attempt_id === id).split, 'heldout');
  assert.throws(() => study.freeze('strict'), /already frozen/);
});

test('unexpected protocol deviation can exclude the latest attempt without deleting it', () => {
  const study = new StudyRecorder({ studyId: 'STUDY-TEST' });
  record(study, { role: 'reference', relation: 'reference' }, { summary: sample() });
  study.excludeLast();
  const ref = study.rows().find(row => row.config_id === 'baseline');
  assert.equal(ref.protocol_status, 'protocol_invalid');
  assert.equal(ref.signature_produced, 0);
  assert.equal(study.attempts.length, 1);
  const trial = record(study, {}, { summary: sample() });
  const row = study.rows().find(item => item.attempt_id === trial && item.config_id === 'baseline');
  assert.equal(row.comparison_status, 'no_reference_for_config');
  assert.equal(row.match, null);
  assert.equal(study.summary().exclusions, 1);
});

test('end-to-end and conditional match denominators treat rejection separately', () => {
  const study = new StudyRecorder({ studyId: 'STUDY-TEST' });
  record(study, { role: 'reference', relation: 'reference' }, { summary: sample() });
  record(study, {}, { summary: sample() });
  record(study, {}, { captureCode: 'multi_hand', captureMs: 20 });
  record(study, {}, { summary: sample({ index: 2 }) });
  const metrics = study.summary().metrics.pilot.baseline.genuine;
  assert.deepEqual(metrics.signature_acceptance, { numerator: 2, denominator: 3, value: 2 / 3 });
  assert.deepEqual(metrics.end_to_end_match, { numerator: 1, denominator: 3, value: 1 / 3 });
  assert.deepEqual(metrics.conditional_match, { numerator: 1, denominator: 2, value: 1 / 2 });
  assert.equal(metrics.rejection_codes.multi_hand, 1);
});

test('reference retries retain a group, replace the candidate, and preserve earlier rows', () => {
  const study = new StudyRecorder({ studyId: 'STUDY-TEST' });
  const first = record(study, { role: 'reference', relation: 'reference' }, { summary: sample({ index: 1.3 }) });
  const retry = record(study, { role: 'reference', relation: 'reference', retry: true }, { summary: sample() });
  const trial = record(study, {}, { summary: sample() });
  const next = record(study, { role: 'reference', relation: 'reference', poseId: 'open_palm' }, { summary: sample() });
  const firstRow = study.rows().find(row => row.attempt_id === first && row.config_id === 'baseline');
  const retryRow = study.rows().find(row => row.attempt_id === retry && row.config_id === 'baseline');
  const trialRow = study.rows().find(row => row.attempt_id === trial && row.config_id === 'baseline');
  const nextRow = study.rows().find(row => row.attempt_id === next && row.config_id === 'baseline');
  assert.equal(firstRow.quantization_outcome, 'rejected');
  assert.equal(firstRow.reference_group_id, first);
  assert.equal(retryRow.retry_index, 2);
  assert.equal(retryRow.retry_of_attempt_id, first);
  assert.equal(retryRow.reference_group_id, first);
  assert.equal(trialRow.reference_id, retry);
  assert.equal(trialRow.reference_group_id, first);
  assert.equal(trialRow.comparison_status, 'match');
  assert.equal(nextRow.retry_index, 1);
  assert.equal(nextRow.reference_group_id, next);
  assert.equal(study.attempts.length, 4);
});

test('trial retries increment only with explicit intent and compatible predecessor', () => {
  const study = new StudyRecorder({ studyId: 'STUDY-TEST' });
  record(study, { role: 'reference', relation: 'reference' }, { summary: sample() });
  const first = record(study, {}, { captureCode: 'not_ready' });
  const second = record(study, { retry: true }, { summary: sample() });
  const third = record(study, { retry: true }, { summary: sample() });
  const fresh = record(study, {}, { summary: sample() });
  assert.deepEqual([first, second, third, fresh].map(id => study.rows().find(row => row.attempt_id === id && row.config_id === 'baseline').retry_index), [1, 2, 3, 1]);
  assert.equal(study.rows().find(row => row.attempt_id === third).retry_of_attempt_id, second);
  assert.throws(() => study.begin(meta({ retry: true, sceneCondition: 'two_start' })), /Retry must immediately follow/);
  assert.equal(study.attempts.length, 5);
});

test('planned count and exports use physical attempts and preserve safe columns', () => {
  const study = new StudyRecorder({ studyId: 'STUDY-TEST' });
  study.setPlanned('pilot', 2);
  record(study, { role: 'reference', relation: 'reference' }, { summary: sample() });
  record(study, {}, { captureCode: 'not_ready' });
  record(study, { retry: true }, { summary: sample() });
  const summary = JSON.parse(study.json());
  assert.equal(summary.schema_version, 2);
  assert.equal(summary.planned_unit, 'physical_attempts');
  assert.equal(summary.recorded.pilot, 3);
  assert.equal(summary.overrun.pilot, 1);
  assert.equal(study.rows().length, 9);
  const lines = study.csv().trim().split('\r\n');
  assert.equal(lines.length, 10);
  assert.match(lines[0], /reference_group_id,retry_of_attempt_id/);
  assert.doesNotMatch(study.csv() + study.json(), /GC1:|rawLandmarks|"med"|"sd"/);
});

test('reviewed external pilot can be frozen for a fresh session without inheriting references', () => {
  const study = new StudyRecorder({ studyId: 'STUDY-HELDOUT' });
  assert.throws(() => study.freeze('baseline', 'STUDY-HELDOUT'), /distinct/);
  study.freeze('baseline', 'STUDY-PILOT');
  assert.equal(study.summary().pilot_source_study_id, 'STUDY-PILOT');
  record(study, { split: 'heldout', sessionId: 'S02', role: 'reference', relation: 'reference' }, { summary: sample() });
  record(study, { split: 'heldout', sessionId: 'S02' }, { summary: sample() });
  assert.throws(() => study.begin(meta({ split: 'heldout', sessionId: 'S03' })), /reference in this split and session/);
});

test('an unfinished attempt cannot be replaced by another reference', () => {
  const study = new StudyRecorder({ studyId: 'STUDY-TEST' });
  study.begin(meta({ role: 'reference', relation: 'reference' }), 100);
  assert.throws(() => study.begin(meta({ role: 'reference', relation: 'reference' }), 120), /Finish the current/);
  assert.equal(study.attempts.length, 1);
});
