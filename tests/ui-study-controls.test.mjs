import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the actual inline control and recovery handlers without a browser or storage.
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
function section(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `Missing inline section: ${startMarker}`);
  return html.slice(start, end);
}
const controls = section('const studyButtons =', 'const busy =');
const resume = section('$("btnResumeStudy").onclick =', '$("btnEndStudy").onclick =');
const endStudy = section('$("btnEndStudy").onclick =', 'function studyMeta(');

function harness(overrides = {}) {
  const elements = Object.fromEntries([
    'btnRef', 'btnTrial', 'btnPlan', 'btnFreeze', 'btnExclude', 'btnClear',
    'btnEndStudy', 'btnResumeStudy', 'btnCsv', 'btnJson', 'studyRecovery', 'studyPlanned',
    'studySplit', 'studyPilotSource', 'studyFreezeConfig', 'studyParticipant',
    'studySession', 'navStatus', 'tabMain', 'tabTest', 'tabLab', 'tabResults'
  ].map(id => [id, { disabled: true, value: '', textContent: '', classList: { add() {} } }]));
  const context = vm.createContext({
    $: id => elements[id],
    study: { studyId: 'STUDY-OLD', planned: { pilot: 0, heldout: 32 },
      frozenConfigId: 'loose', pilotSourceStudyId: 'STUDY-PILOT', attempts: [] },
    store: { revision: 1 }, studyLocked: false, studyBusy: false,
    sectionNames: ['Main', 'Test', 'Lab', 'Results'], activeSection: 'Test',
    recoveryPending: false, storageError: null,
    studyStatus() {}, renderLog() {},
    ...overrides
  });
  vm.runInContext(controls, context);
  const update = () => vm.runInContext('updateStudyControls()', context);
  const exportsDisabled = () => [elements.btnCsv.disabled, elements.btnJson.disabled];
  return { context, elements, update, exportsDisabled };
}

test('new study exports enable only after its snapshot is saved', () => {
  const ui = harness({ store: { revision: null }, studyLocked: true });
  ui.update();
  assert.deepEqual(ui.exportsDisabled(), [true, true]);
  ui.context.store.revision = 1;
  ui.update();
  assert.deepEqual(ui.exportsDisabled(), [true, true]);
  ui.context.studyLocked = false;
  ui.update();
  assert.deepEqual(ui.exportsDisabled(), [false, false]);
});

test('persistence failure disables both exports even with a visible study', () => {
  const ui = harness({ storageError: new Error('Storage unavailable') });
  ui.update();
  assert.deepEqual(ui.exportsDisabled(), [true, true]);
  ui.context.storageError = null;
  ui.context.store.revision = null;
  ui.update();
  assert.deepEqual(ui.exportsDisabled(), [true, true]);
});

test('pending recovery keeps exports disabled until confirmation and save', () => {
  const ui = harness({ recoveryPending: true, studyLocked: true });
  ui.update();
  assert.deepEqual(ui.exportsDisabled(), [true, true]);
  ui.context.persistStudy = () => {
    assert.deepEqual(ui.exportsDisabled(), [true, true]);
    ui.context.store.revision++;
  };
  vm.runInContext(resume, ui.context);
  ui.elements.btnResumeStudy.onclick();
  assert.deepEqual(ui.exportsDisabled(), [false, false]);
  assert.equal(ui.context.recoveryPending, false);
});

test('ending a restored study re-enables exports only after the new snapshot succeeds', () => {
  const ui = harness({ recoveryPending: true, studyLocked: true });
  ui.update();
  const calls = [];
  ui.context.store.clear = () => { calls.push('clear'); ui.context.store.revision = null; };
  ui.context.store.save = () => {
    assert.deepEqual(ui.exportsDisabled(), [true, true]);
    calls.push('save');
    ui.context.store.revision = 1;
  };
  ui.context.StudyRecorder = class { constructor() { this.studyId = 'STUDY-NEW'; } };
  ui.context.window = { sessionStorage: { setItem() {} } };
  ui.context.STUDY_TAB_MARKER = 'test-tab-marker';
  ui.context.confirm = () => true;
  ui.context.lockStudy = error => { throw error; };
  vm.runInContext(endStudy, ui.context);
  ui.elements.btnEndStudy.onclick();
  assert.deepEqual(calls, ['clear', 'save']);
  assert.deepEqual(ui.exportsDisabled(), [false, false]);
  assert.equal(ui.context.study.studyId, 'STUDY-NEW');
});
