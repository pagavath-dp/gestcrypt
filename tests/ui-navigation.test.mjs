import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const start = html.indexOf('function tab(which) {');
const end = html.indexOf('</script>', start);
assert.ok(start >= 0 && end > start, 'inline navigation handler must exist');
const navigation = html.slice(start, end);
const names = ['Main', 'Test', 'Lab', 'Results'];

test('all four sections have matching navigation controls and active state', async () => {
  const elements = { workspace: { resultsView: false, labView: false, classList: {
    toggle(token, enabled) {
      assert.ok(['results-view', 'lab-view'].includes(token));
      elements.workspace[token === 'results-view' ? 'resultsView' : 'labView'] = enabled;
    }
  } }, primaryNav: { addEventListener(type, handler) { assert.equal(type, 'keydown'); this.onkeydown = handler; } } };
  let cameraStarts = 0;
  for (const name of names) {
    elements['pane' + name] = { hidden: name !== 'Main', classList: {
      toggle(token, enabled) { assert.equal(token, 'hidden'); elements['pane' + name].hidden = enabled; }
    } };
    elements['tab' + name] = { current: name === 'Main', disabled: false, focused: false,
      setAttribute(key, value) { assert.equal(key, 'aria-current'); assert.equal(value, 'page'); this.current = true; },
      removeAttribute(key) { assert.equal(key, 'aria-current'); this.current = false; },
      focus() { this.focused = true; } };
    assert.match(html, new RegExp(`id="tab${name}"[^>]*aria-controls="pane${name}"`));
    assert.match(html, new RegExp(`id="pane${name}"`));
  }
  const context = vm.createContext({ $: id => elements[id],
    ensureCamera: () => { cameraStarts++; return Promise.resolve(); }, status() {},
    sectionNames: names, activeSection: 'Main', studyBusy: false });
  vm.runInContext(navigation, context);
  for (const [name, expectedCameraStarts] of [['Results', 0], ['Lab', 0], ['Test', 1], ['Main', 1]]) {
    elements['tab' + name].onclick();
    assert.deepEqual(names.filter(item => !elements['pane' + item].hidden), [name]);
    assert.deepEqual(names.filter(item => elements['tab' + item].current), [name]);
    assert.equal(cameraStarts, expectedCameraStarts);
    assert.equal(elements.workspace.resultsView, name === 'Results');
    assert.equal(elements.workspace.labView, name === 'Lab');
  }
  context.studyBusy = true;
  elements.tabResults.onclick();
  assert.equal(elements.tabMain.current, true, 'pending work keeps the current section visible');
  assert.equal(elements.tabResults.current, false);
  context.studyBusy = false;
  let prevented = false;
  elements.primaryNav.onkeydown({ key: 'ArrowRight', target: elements.tabMain, preventDefault() { prevented = true; } });
  assert.ok(prevented);
  assert.ok(elements.tabTest.focused, 'arrow key moves keyboard focus to the next section');
});

test('pending operation disables other section controls and announces why', () => {
  const start = html.indexOf('function updateStudyControls() {');
  const end = html.indexOf('const busy =', start);
  const update = html.slice(start, end);
  const elements = Object.fromEntries(['btnRef', 'btnTrial', 'btnPlan', 'btnFreeze', 'btnExclude', 'btnClear',
    'btnEndStudy', 'btnCsv', 'btnJson', 'navStatus', ...names.map(name => 'tab' + name)]
    .map(id => [id, { disabled: false, textContent: '' }]));
  const context = vm.createContext({ $: id => elements[id], sectionNames: names, activeSection: 'Test',
    studyLocked: false, studyBusy: true, storageError: null, recoveryPending: false,
    study: {}, store: { revision: 1 },
    studyButtons: ['btnRef', 'btnTrial', 'btnPlan', 'btnFreeze', 'btnExclude', 'btnClear'] });
  vm.runInContext(update, context);
  context.updateStudyControls();
  assert.equal(elements.tabTest.disabled, false);
  for (const name of ['Main', 'Lab', 'Results']) assert.equal(elements['tab' + name].disabled, true);
  assert.match(elements.navStatus.textContent, /Finish the current operation/);
  context.studyBusy = false;
  context.updateStudyControls();
  for (const name of names) assert.equal(elements['tab' + name].disabled, false);
  assert.equal(elements.navStatus.textContent, '');
});

test('results pane links only existing validated exploratory pilot figures and report', () => {
  const pane = html.slice(html.indexOf('<div id="paneResults"'), html.indexOf('\n    </section>', html.indexOf('<div id="paneResults"')));
  assert.match(pane, /Exploratory pilot · STUDY-1873C987/);
  assert.match(pane, /31 physical attempts: 7 reference attempts and 24 genuine trials/);
  assert.match(pane, /No held-out data is shown here/);
  const base = './analysis-output/pilot-STUDY-1873C987/';
  const paths = [...pane.matchAll(/(?:src|href)="(\.\/analysis-output\/pilot-STUDY-1873C987\/[^\"]+)"/g)].map(match => match[1]);
  const figures = [...pane.matchAll(/src="(\.\/analysis-output\/pilot-STUDY-1873C987\/pilot\/[^\"]+\.svg)"/g)].map(match => match[1]);
  assert.equal(figures.length, 6);
  for (const path of figures) assert.ok(paths.filter(item => item === path).length >= 2, `Missing full-size link: ${path}`);
  assert.ok(paths.includes(base + 'report.md'));
  assert.ok(paths.includes(base + 'aggregate_metrics.csv'));
  for (const path of paths) assert.ok(existsSync(new URL('../' + path, import.meta.url)), `Missing pilot artifact: ${path}`);
  assert.match(pane, /Latency · 31 physical attempts/);
  assert.match(pane, /Reference acceptance · 7 reference attempts per configuration/);
  assert.match(pane, /Rejection reasons · 24 genuine trials per configuration/);
});

test('stacked camera and result tables remain keyboard reachable', () => {
  assert.match(html, /#cameraPreview \{ width: 100%; max-width: 32rem; \}/);
  assert.match(html, /#workspace\.results-view \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.equal([...html.matchAll(/tabindex="0" role="region" aria-label="[^"]+table[^" ]*/g)].length, 2);
  assert.match(html, /\[tabindex="0"\]:focus-visible/);
});

test('displayed pilot numerators and denominators match validated analysis', () => {
  const analysis = JSON.parse(readFileSync(new URL('../analysis-output/pilot-STUDY-1873C987/analysis.json', import.meta.url), 'utf8'));
  assert.equal(analysis.study_id, 'STUDY-1873C987');
  assert.equal(analysis.recorded.pilot, 31);
  assert.match(html, /Latency uses all 31 attempts, and reference acceptance uses 7 references per configuration/);
  assert.match(html, /match rates show their eligible denominators/);
  for (const id of ['loose', 'baseline', 'strict']) {
    const row = html.match(new RegExp(`<tr><th scope="row"[^>]*>${id[0].toUpperCase() + id.slice(1)}[^<]*<\\/th>(.*?)<\\/tr>`, 's'))?.[1];
    assert.ok(row, `Missing ${id} results row`);
    const config = analysis.splits.pilot.configs[id];
    for (const metric of ['signature_acceptance', 'rejection', 'end_to_end_match', 'reference_acceptance']) {
      const { numerator, denominator } = config[metric];
      assert.ok(row.includes(`${numerator}/${denominator}`), `${id} ${metric} denominator differs from validated analysis`);
    }
  }
});
