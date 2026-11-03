// Presentation of the already validated exploratory pilot. No study or vault state is read here.
export const PILOT_ID = 'STUDY-1873C987';
export const PILOT_CONFIGS = Object.freeze({
  loose: { label: 'Loose', margins: '0.02 ratio / 1°' },
  baseline: { label: 'Baseline', margins: '0.04 ratio / 2°' },
  strict: { label: 'Strict', margins: '0.06 ratio / 3°' }
});
export const PILOT_POSES = Object.freeze([
  ['fist', 'Fist'], ['open_palm', 'Open palm'],
  ['three_finger', 'Three-finger'], ['swag', 'SWAG']
]);
const CONFIG_IDS = Object.keys(PILOT_CONFIGS);
const RATE_IDS = ['signature_acceptance', 'rejection', 'conditional_match',
  'end_to_end_match', 'reference_acceptance'];
const OUTCOME_IDS = ['match', 'mismatch', 'rejected', 'rejected_no_reference', 'accepted_no_reference'];
const requireValue = (condition, label) => { if (!condition) throw new Error(`Pilot analysis is inconsistent: ${label}.`); };
const count = (value, label) => {
  requireValue(Number.isSafeInteger(value) && value >= 0, label);
  return value;
};
const sum = values => values.reduce((total, value) => total + value, 0);

function checkedRate(rate, label) {
  requireValue(rate && typeof rate === 'object', label);
  const numerator = count(rate.numerator, `${label} numerator`);
  const denominator = count(rate.denominator, `${label} denominator`);
  requireValue(numerator <= denominator, `${label} fraction`);
  const expected = denominator ? numerator / denominator : null;
  requireValue(rate.value === expected, `${label} value`);
  return { numerator, denominator, value: expected };
}

function outcomesFor(source, label) {
  requireValue(source && typeof source === 'object', label);
  const outcomes = Object.fromEntries(OUTCOME_IDS.map(key => [key, count(source[key] ?? 0, `${label} ${key}`)]));
  return outcomes;
}

export function modelFromPilotAnalysis(analysis) {
  requireValue(analysis?.study_id === PILOT_ID && analysis?.source_schema_version === 1, 'study identity');
  requireValue(analysis?.recorded?.pilot === 31 && analysis?.recorded?.heldout === 0, 'split counts');
  const split = analysis?.splits?.pilot;
  requireValue(split?.study_id === PILOT_ID && split?.split === 'pilot' && split?.physical_attempts === 31,
    'pilot split');
  requireValue(!analysis?.splits?.heldout, 'held-out split must not appear in the pilot dashboard');
  const configs = {};
  for (const id of CONFIG_IDS) {
    const source = split?.configs?.[id];
    requireValue(source && source.valid_genuine_trials === 24, `${id} trial denominator`);
    const outcomes = outcomesFor(source.outcomes, `${id} outcomes`);
    const rejected = outcomes.rejected + outcomes.rejected_no_reference;
    const unavailableReference = outcomes.rejected_no_reference + outcomes.accepted_no_reference;
    requireValue(sum(Object.values(outcomes)) === 24, `${id} outcome partition`);
    const rates = Object.fromEntries(RATE_IDS.map(key => [key, checkedRate(source[key], `${id} ${key}`)]));
    requireValue(rates.signature_acceptance.numerator === 24 - rejected &&
      rates.signature_acceptance.denominator === 24, `${id} acceptance`);
    requireValue(rates.rejection.numerator === rejected && rates.rejection.denominator === 24,
      `${id} rejection`);
    requireValue(rates.conditional_match.numerator === outcomes.match &&
      rates.conditional_match.denominator === outcomes.match + outcomes.mismatch,
      `${id} conditional match`);
    requireValue(rates.end_to_end_match.numerator === outcomes.match &&
      rates.end_to_end_match.denominator === 24 - unavailableReference,
      `${id} end-to-end match`);
    requireValue(rates.reference_acceptance.denominator === 7, `${id} references`);
    const poses = {};
    for (const [pose] of PILOT_POSES) {
      const entry = source.per_pose?.[pose];
      const n = count(entry?.valid_trials, `${id} ${pose} trial count`);
      const outcome = outcomesFor(entry?.outcomes, `${id} ${pose} outcomes`);
      requireValue(sum(Object.values(outcome)) === n, `${id} ${pose} outcome partition`);
      poses[pose] = { count: n, outcomes: outcome };
    }
    requireValue(sum(Object.values(poses).map(pose => pose.count)) === 24, `${id} pose total`);
    configs[id] = { id, ...PILOT_CONFIGS[id], trials: 24, outcomes,
      rejected, unavailableReference, rates, poses };
  }
  return { studyId: PILOT_ID, split: 'pilot', physicalAttempts: 31,
    referenceAttempts: 7, genuineTrials: 24, configs };
}

export function createPilotSelection(model, initial = 'loose', onChange = () => {}) {
  requireValue(model?.studyId === PILOT_ID, 'selection model');
  let current = null;
  return {
    get current() { return current; },
    select(id) {
      requireValue(Object.hasOwn(model.configs, id), 'configuration selection');
      current = id;
      onChange(model.configs[id]);
      return model.configs[id];
    },
    initialize() { return this.select(initial); }
  };
}

export function percent(rate) {
  return rate.value === null ? 'N/A' : `${(rate.value * 100).toFixed(1)}%`;
}

const elt = (doc, tag, className, text) => {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const fraction = rate => `${rate.numerator}/${rate.denominator}`;
const SEGMENTS = [
  ['match', 'Match', 'match'], ['mismatch', 'Mismatch', 'mismatch'],
  ['rejected', 'Rejected', 'rejected'], ['accepted_no_reference', 'Accepted without reference', 'unavailable']
];
export const segmentDescription = (config, label, value) =>
  `${config.label}: ${label} — ${value}/${config.trials} genuine trials (${(value / config.trials * 100).toFixed(1)}%)`;

function stackedBar(doc, config, selected) {
  const row = elt(doc, 'div', 'pilot-outcome-row' + (selected ? ' selected' : ''));
  const header = elt(doc, 'div', 'pilot-outcome-header');
  header.append(elt(doc, 'strong', '', config.label),
    elt(doc, 'span', '', `${config.trials} genuine trials · ${config.margins}`));
  const bar = elt(doc, 'div', 'pilot-stacked');
  const tooltip = elt(doc, 'div', 'pilot-tooltip');
  tooltip.id = `pilot-tooltip-${config.id}`;
  tooltip.setAttribute('role', 'tooltip');
  tooltip.hidden = true;
  bar.setAttribute('aria-label', `${config.label}: ${config.outcomes.match} matches, ${config.outcomes.mismatch} mismatches, ${config.rejected} rejected, ${config.outcomes.accepted_no_reference} accepted without reference, out of ${config.trials} genuine trials.`);
  for (const [key, label, color] of SEGMENTS) {
    const value = key === 'rejected' ? config.rejected : config.outcomes[key];
    if (!value) continue;
    const segment = elt(doc, 'span', `pilot-segment pilot-${color}`);
    segment.tabIndex = 0;
    segment.setAttribute('role', 'img');
    segment.style.setProperty('--segment-width', `${value / config.trials * 100}%`);
    const description = segmentDescription(config, label, value);
    segment.setAttribute('aria-label', description);
    segment.setAttribute('aria-describedby', tooltip.id);
    let hovered = false, focused = false;
    const updateTooltip = () => {
      if (hovered || focused) tooltip.textContent = description;
      tooltip.hidden = !(hovered || focused);
    };
    segment.addEventListener('mouseenter', () => { hovered = true; updateTooltip(); });
    segment.addEventListener('mouseleave', () => { hovered = false; updateTooltip(); });
    segment.addEventListener('focus', () => { focused = true; updateTooltip(); });
    segment.addEventListener('blur', () => { focused = false; updateTooltip(); });
    bar.append(segment);
  }
  row.append(header, bar, tooltip);
  return row;
}

function metricCard(doc, title, rate, note, color) {
  const card = elt(doc, 'div', `pilot-metric pilot-accent-${color}`);
  card.append(elt(doc, 'p', 'pilot-metric-label', title),
    elt(doc, 'strong', 'pilot-metric-value', percent(rate)),
    elt(doc, 'p', 'pilot-metric-fraction', `${fraction(rate)} · ${note}`));
  return card;
}

function rateRow(doc, label, rate, color, definition) {
  const row = elt(doc, 'div', 'pilot-rate-row');
  const heading = elt(doc, 'div', 'pilot-rate-heading');
  heading.append(elt(doc, 'strong', '', label),
    elt(doc, 'span', '', `${fraction(rate)} · ${percent(rate)}`));
  const track = elt(doc, 'div', 'pilot-rate-track');
  const fill = elt(doc, 'div', `pilot-rate-fill pilot-${color}`);
  fill.style.setProperty('--rate-width', `${(rate.value ?? 0) * 100}%`);
  track.append(fill);
  row.append(heading, track, elt(doc, 'p', 'pilot-rate-definition', definition));
  return row;
}

export function renderPilotDashboard(root, model, selected) {
  const doc = root.ownerDocument;
  const config = model.configs[selected];
  requireValue(config, 'render configuration');
  const outcomes = root.querySelector('#pilotOutcomes');
  outcomes.replaceChildren(...CONFIG_IDS.map(id => stackedBar(doc, model.configs[id], id === selected)));
  const metrics = root.querySelector('#pilotMetrics');
  metrics.replaceChildren(
    metricCard(doc, 'Signature acceptance', config.rates.signature_acceptance, 'valid genuine trials', 'cyan'),
    metricCard(doc, 'Capture rejection', config.rates.rejection, 'valid genuine trials', 'magenta'),
    metricCard(doc, 'Reference acceptance', config.rates.reference_acceptance, 'reference attempts', 'violet'));
  root.querySelector('#pilotRates').replaceChildren(
    rateRow(doc, 'Signature acceptance', config.rates.signature_acceptance, 'cyan', 'Accepted signature / valid genuine trials'),
    rateRow(doc, 'Conditional exact match', config.rates.conditional_match, 'teal', 'Match / accepted trials with an available reference'),
    rateRow(doc, 'End-to-end exact match', config.rates.end_to_end_match, 'violet', 'Match / valid trials with an available reference'));
  const poseRows = PILOT_POSES.map(([id, label]) => {
    const pose = config.poses[id];
    const row = elt(doc, 'div', 'pilot-pose-row');
    row.append(elt(doc, 'strong', '', label),
      elt(doc, 'span', '', `${pose.outcomes.match} match · ${pose.outcomes.mismatch} mismatch · ${pose.outcomes.rejected + pose.outcomes.rejected_no_reference} rejected · ${pose.outcomes.accepted_no_reference} accepted without reference · n=${pose.count}`));
    return row;
  });
  root.querySelector('#pilotPoses').replaceChildren(...poseRows);
  root.querySelector('#pilotSelectionStatus').textContent =
    `${config.label} configuration selected: ${config.margins}. Exploratory pilot only.`;
}

export async function initPilotDashboard(root, url, { fetchSource = globalThis.fetch,
  IntersectionObserverClass = globalThis.IntersectionObserver } = {}) {
  const response = await fetchSource(url);
  if (!response.ok) throw new Error('The validated pilot analysis could not be loaded.');
  const model = modelFromPilotAnalysis(await response.json());
  const selector = root.querySelector('#pilotConfig');
  const selection = createPilotSelection(model, 'loose', config => renderPilotDashboard(root, model, config.id));
  selector.addEventListener('change', () => selection.select(selector.value));
  selector.value = 'loose';
  selection.initialize();
  if (IntersectionObserverClass) {
    const observer = new IntersectionObserverClass(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        root.classList.add('is-visible');
        observer.disconnect();
      }
    }, { threshold: 0.08 });
    observer.observe(root);
  } else root.classList.add('is-visible');
  return selection;
}
