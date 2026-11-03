import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { modelFromPilotAnalysis, createPilotSelection, renderPilotDashboard, percent, segmentDescription, PILOT_ID } from '../pilot-dashboard.mjs';

const analysis = JSON.parse(readFileSync(new URL('../analysis-output/pilot-STUDY-1873C987/analysis.json', import.meta.url)));
const model = modelFromPilotAnalysis(analysis);

test('dashboard uses the validated pilot and preserves each configuration outcome partition', () => {
  assert.equal(model.studyId, PILOT_ID);
  assert.equal(model.split, 'pilot');
  assert.equal(model.physicalAttempts, 31);
  assert.equal(model.referenceAttempts, 7);
  assert.equal(model.genuineTrials, 24);
  for (const id of ['loose', 'baseline', 'strict']) {
    const source = analysis.splits.pilot.configs[id];
    const shown = model.configs[id];
    assert.equal(shown.trials, 24);
    assert.equal(shown.outcomes.match, source.outcomes.match ?? 0);
    assert.equal(shown.outcomes.mismatch, source.outcomes.mismatch ?? 0);
    assert.equal(shown.rejected, source.rejection.numerator);
    assert.equal(shown.unavailableReference,
      (source.outcomes.rejected_no_reference ?? 0) + (source.outcomes.accepted_no_reference ?? 0));
    assert.equal(Object.values(shown.outcomes).reduce((a, b) => a + b), 24);
    for (const metric of ['signature_acceptance', 'rejection', 'conditional_match',
      'end_to_end_match', 'reference_acceptance']) {
      assert.deepEqual(shown.rates[metric], source[metric]);
    }
  }
  assert.deepEqual(model.configs.strict.outcomes,
    { match: 3, mismatch: 0, rejected: 2, rejected_no_reference: 17, accepted_no_reference: 2 });
  assert.equal(model.configs.strict.rejected, 19);
  assert.equal(model.configs.strict.unavailableReference, 19);
  assert.equal(percent(model.configs.strict.rates.conditional_match), '100.0%');
  assert.equal(model.configs.strict.rates.conditional_match.denominator, 3);
  assert.equal(model.configs.strict.rates.end_to_end_match.denominator, 5);
});

test('configuration selection updates the same validated model without changing source data', () => {
  const seen = [];
  const selection = createPilotSelection(model, 'loose', config => seen.push(config.id));
  assert.equal(selection.initialize().rates.signature_acceptance.numerator, 21);
  assert.equal(selection.select('baseline').rates.signature_acceptance.numerator, 14);
  assert.equal(selection.select('strict').rates.signature_acceptance.numerator, 5);
  assert.deepEqual(seen, ['loose', 'baseline', 'strict']);
  assert.equal(selection.current, 'strict');
  assert.throws(() => selection.select('heldout'), /configuration selection/);
  assert.equal(selection.current, 'strict');
});

test('stacked segments expose exact percentage and a visible hover or focus tooltip', () => {
  const element = () => ({
    children: [], attributes: {}, listeners: {}, style: { setProperty() {} }, hidden: false,
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; },
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(type, callback) { this.listeners[type] = callback; }
  });
  const nodes = Object.fromEntries(['pilotOutcomes', 'pilotMetrics', 'pilotRates',
    'pilotPoses', 'pilotSelectionStatus'].map(id => [id, element()]));
  const root = { ownerDocument: { createElement: element },
    querySelector: selector => nodes[selector.slice(1)] };
  renderPilotDashboard(root, model, 'strict');
  const strict = nodes.pilotOutcomes.children[2];
  const bar = strict.children[1];
  const tooltip = strict.children[2];
  const match = bar.children[0];
  assert.equal(segmentDescription(model.configs.strict, 'Match', 3),
    'Strict: Match — 3/24 genuine trials (12.5%)');
  assert.equal(match.attributes['aria-label'], 'Strict: Match — 3/24 genuine trials (12.5%)');
  assert.equal(match.attributes['aria-describedby'], tooltip.id);
  assert.equal(tooltip.hidden, true);
  match.listeners.focus();
  assert.equal(tooltip.hidden, false);
  assert.equal(tooltip.textContent, 'Strict: Match — 3/24 genuine trials (12.5%)');
  match.listeners.blur();
  assert.equal(tooltip.hidden, true);
  match.listeners.mouseenter();
  assert.equal(tooltip.hidden, false);
  match.listeners.focus();
  match.listeners.mouseleave();
  assert.equal(tooltip.hidden, false);
  match.listeners.blur();
  assert.equal(tooltip.hidden, true);
});

test('dashboard rejects split substitution, inconsistent denominators, and overlapping outcome totals', () => {
  const copy = () => structuredClone(analysis);
  const heldout = copy(); heldout.splits.heldout = { study_id: 'OTHER' };
  assert.throws(() => modelFromPilotAnalysis(heldout), /held-out split/);
  const wrongRate = copy(); wrongRate.splits.pilot.configs.loose.conditional_match.denominator = 24;
  assert.throws(() => modelFromPilotAnalysis(wrongRate), /conditional_match/);
  const wrongPartition = copy(); wrongPartition.splits.pilot.configs.strict.outcomes.rejected_no_reference++;
  assert.throws(() => modelFromPilotAnalysis(wrongPartition), /outcome partition/);
});

test('dashboard is wired to the pilot only and respects reduced motion', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const pane = html.slice(html.indexOf('<div id="paneResults"'), html.indexOf('</section>\n  </div>\n</main>'));
  assert.match(pane, /id="pilotConfig"/);
  assert.match(pane, /id="pilotOutcomes"/);
  assert.match(pane, /id="pilotRates"/);
  assert.match(pane, /id="pilotMetrics"/);
  assert.match(html, /analysis-output\/pilot-STUDY-1873C987\/analysis\.json/);
  assert.match(html, /prefers-reduced-motion: reduce/);
  assert.match(pane, /How this pilot was counted/);
  assert.match(pane, /31 physical attempts in one session: 7 reference attempts and 24 genuine trials/);
  assert.match(html, /pilot-refresh/);
});
