import test from 'node:test';
import assert from 'node:assert/strict';
import { StudyRecorder } from '../study.mjs';
import { StudyStore, STUDY_STORAGE_KEY } from '../study-persistence.mjs';
import { StudyRecorder as UiStudyRecorder, StudyStore as UiStudyStore } from '../study-persistence.mjs?study-snapshot-v1';

const summary = () => ({ med: { thumb: 1, index: 1, middle: 1, ring: 1, pinky: 1,
  sp_im: 0, sp_mr: 0, sp_rp: 0 }, sd: { thumb: 0, index: 0, middle: 0, ring: 0,
    pinky: 0, sp_im: 0, sp_mr: 0, sp_rp: 0 } });
const meta = (changes = {}) => ({ participantId: 'P01', sessionId: 'S02', split: 'heldout',
  role: 'reference', poseId: 'fist', relation: 'reference', sceneCondition: 'single',
  observedHands: 'one', browserCode: 'chrome_current', cameraCode: 'built_in',
  lightingCode: 'normal', ...changes });
function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key) };
}
test('versioned UI module and store use the same snapshot-capable recorder', () => {
  const store = new UiStudyStore(memoryStorage());
  const study = new UiStudyRecorder({ studyId: 'STUDY-MODULE01' });
  store.save(study);
  const restored = new UiStudyStore(store.storage).read();
  assert.ok(restored instanceof UiStudyRecorder);
  assert.equal(typeof restored.snapshot, 'function');
});
const finish = (study, metadata, result = { summary: summary() }) => {
  const attemptId = study.begin(meta(metadata), 100);
  study.finish(attemptId, { ...result, now: 200 });
  return attemptId;
};

test('reload restores study, accepted references, freeze, plan and next attempt ID', () => {
  const storage = memoryStorage();
  const first = new StudyStore(storage);
  const study = new StudyRecorder({ studyId: 'STUDY-PERSIST01' });
  study.setPlanned('heldout', 32);
  study.freeze('loose', 'STUDY-PILOT01');
  const reference = finish(study, {});
  finish(study, { role: 'trial', relation: 'genuine' });
  first.save(study);
  const restored = new StudyStore(storage).read();
  assert.equal(restored.studyId, study.studyId);
  assert.equal(restored.frozenConfigId, 'loose');
  assert.equal(restored.pilotSourceStudyId, 'STUDY-PILOT01');
  assert.equal(restored.planned.heldout, 32);
  assert.equal(restored.activeReferences.get('loose').id, reference);
  assert.equal(restored.rows().find(r => r.attempt_id === 'A0002' && r.config_id === 'loose').match, 1);
  const trial = finish(restored, { role: 'trial', relation: 'genuine' });
  assert.equal(trial, 'A0003');
  assert.equal(restored.rows().find(r => r.attempt_id === trial && r.config_id === 'loose').reference_id, reference);
});

test('reference retry and exclusion survive reload without merging groups', () => {
  const storage = memoryStorage();
  const firstStore = new StudyStore(storage);
  const study = new StudyRecorder({ studyId: 'STUDY-PERSIST02' });
  study.freeze('loose', 'STUDY-PILOT01');
  const first = finish(study, {}, { captureCode: 'not_ready' });
  const retry = finish(study, { retry: true });
  study.excludeLast();
  firstStore.save(study);
  const restored = new StudyStore(storage).read();
  assert.equal(restored.rows().find(r => r.attempt_id === retry).retry_of_attempt_id, first);
  assert.equal(restored.rows().find(r => r.attempt_id === retry).reference_group_id, first);
  assert.equal(restored.activeReferences.size, 0);
  const next = finish(restored, { role: 'reference', relation: 'reference', poseId: 'swag' });
  assert.equal(next, 'A0003');
  assert.equal(restored.rows().find(r => r.attempt_id === next).reference_group_id, next);
  assert.equal(restored.summary().exclusions, 1);
});

test('unfinished capture becomes an explicit non-match interruption after restoration', () => {
  const storage = memoryStorage();
  const first = new StudyStore(storage);
  const study = new StudyRecorder({ studyId: 'STUDY-PERSIST03' });
  study.freeze('loose', 'STUDY-PILOT01');
  finish(study, {});
  study.begin(meta({ role: 'trial', relation: 'genuine' }), 100);
  first.save(study);
  const second = new StudyStore(storage);
  const restored = second.read();
  assert.equal(restored.interruptPending(), true);
  second.save(restored);
  const row = restored.rows().find(r => r.attempt_id === 'A0002' && r.config_id === 'loose');
  assert.equal(row.capture_outcome, 'state_reject');
  assert.equal(row.rejection_code, 'interrupted');
  assert.equal(row.quantization_outcome, 'not_run');
  assert.equal(row.match, null);
  assert.equal(row.signature_produced, 0);
  assert.equal(restored.interruptPending(), false);
  assert.equal(new StudyStore(storage).read().begin(meta({ role: 'trial', relation: 'genuine' })), 'A0003');
});

test('corrupt and unsupported snapshots remain in storage and block recovery', () => {
  const storage = memoryStorage();
  storage.setItem(STUDY_STORAGE_KEY, '{bad json');
  assert.throws(() => new StudyStore(storage).read(), /corrupt/);
  assert.equal(storage.getItem(STUDY_STORAGE_KEY), '{bad json');
  const unsupported = JSON.stringify({ envelope_version: 99, revision: 1 });
  storage.setItem(STUDY_STORAGE_KEY, unsupported);
  assert.throws(() => new StudyStore(storage).read(), /unsupported/);
  assert.equal(storage.getItem(STUDY_STORAGE_KEY), unsupported);
});

test('invalid IDs, reference links and retry indices reject snapshot without repair', () => {
  const study = new StudyRecorder({ studyId: 'STUDY-PERSIST04' });
  study.freeze('loose', 'STUDY-PILOT01');
  finish(study, {});
  const original = study.snapshot();
  for (const mutate of [s => { s.attempts[0].attempt_id = 'A0002'; },
    s => { s.attempts[0].reference_group_id = 'A9999'; },
    s => { s.attempts[0].retry_index = 2; },
    s => { delete s.active_references.loose; },
    s => { s.active_references.loose.id = 'A9999'; }]) {
    const copy = structuredClone(original); mutate(copy);
    assert.throws(() => StudyRecorder.fromSnapshot(copy), /snapshot/);
  }
});

test('recovery snapshots retain only required derived references, never injected secrets or summaries', () => {
  const study = new StudyRecorder({ studyId: 'STUDY-PERSIST07' });
  study.freeze('loose', 'STUDY-PILOT01');
  finish(study, {});
  study.attempts[0].passphrase = 'private-passphrase';
  study.attempts[0].plaintext = 'private-file';
  study.attempts[0].summary = summary();
  const serialized = JSON.stringify(study.snapshot());
  assert.doesNotMatch(serialized, /private-passphrase|private-file|"med"|"sd"/);
  assert.match(serialized, /GC1:/);
  assert.doesNotMatch(study.csv() + study.json(), /GC1:/);
});

test('explicit deletion removes one study and stale tabs cannot overwrite or merge it', () => {
  const storage = memoryStorage();
  const first = new StudyStore(storage);
  const study = new StudyRecorder({ studyId: 'STUDY-PERSIST05' });
  first.save(study);
  const stale = new StudyStore(storage);
  stale.read();
  study.setPlanned('heldout', 32);
  first.save(study);
  assert.throws(() => stale.save(study), /another tab/);
  assert.throws(() => stale.clear(study.studyId), /another tab/);
  first.clear(study.studyId);
  assert.equal(storage.getItem(STUDY_STORAGE_KEY), null);
  const next = new StudyRecorder({ studyId: 'STUDY-PERSIST06' });
  first.save(next);
  assert.throws(() => first.save(study), /another tab/);
  assert.equal(new StudyStore(storage).read().studyId, next.studyId);
});
