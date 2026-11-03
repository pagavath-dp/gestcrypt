import { csvCell } from './evaluation.mjs';
import { EVALUATION_CONFIGS, quantizeForEvaluation } from './evaluation-quantizer.mjs';
import { CFG } from './gesture.mjs';
import { CAPTURE_CONFIG } from './capture.mjs';

export const STUDY_VERSION = 'gestcrypt-m3-eval-2';
export const STUDY_SNAPSHOT_VERSION = 1;

const POSES = ['fist', 'open_palm', 'three_finger', 'swag'];
const RELATIONS = ['reference', 'genuine', 'different_pose', 'impostor', 'ambiguous'];
const SCENES = ['single', 'two_start', 'enter_early', 'enter_mid', 'enter_late', 'disappear', 'replace'];
const HANDS = ['zero', 'one', 'two_plus', 'unknown'];
const LIGHTING = ['normal', 'low', 'backlit'];
const CAMERAS = ['built_in', 'external'];
const CAPTURE_CODES = ['complete', 'not_ready', 'stale', 'no_hand', 'multi_hand', 'invalid',
  'continuity', 'timeout', 'camera_error', 'camera_start_error', 'unknown', 'missing', 'protocol_invalid', 'interrupted'];
const CSV_FIELDS = ['study_id', 'app_version', 'attempt_id', 'participant_id', 'session_id', 'split', 'role', 'pose_id',
  'reference_id', 'reference_group_id', 'retry_of_attempt_id', 'relation', 'scene_condition', 'observed_hands', 'config_id', 'capture_outcome',
  'quantization_outcome', 'comparison_status', 'rejection_code', 'reference_available', 'signature_produced', 'match', 'attempt_ms', 'capture_ms',
  'retry_index', 'browser_code', 'camera_code', 'lighting_code', 'protocol_status'];

function member(value, choices, field) {
  if (!choices.includes(value)) throw new Error(`Invalid ${field}.`);
  return value;
}
function id(value, prefix) {
  if (typeof value !== 'string' || !new RegExp(`^${prefix}[0-9]{2,3}$`).test(value)) throw new Error(`Use an anonymous ${prefix}00-style identifier.`);
  return value;
}
const roundMs = value => Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
const fraction = (numerator, denominator) => ({ numerator, denominator, value: denominator ? numerator / denominator : null });
function latency(values) {
  const sorted = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = !sorted.length ? null : sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return { count: sorted.length, median_ms: median,
    min_ms: sorted.length ? sorted[0] : null, max_ms: sorted.length ? sorted.at(-1) : null };
}

export class StudyRecorder {
  constructor({ studyId } = {}) {
    const random = crypto.getRandomValues(new Uint8Array(8));
    this.studyId = studyId ?? 'STUDY-' + [...random].map(byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
    if (!/^STUDY-[A-Z0-9]{4,16}$/.test(this.studyId)) throw new Error('Invalid anonymous study ID.');
    this.attempts = [];
    this.activeReferences = new Map();
    this.currentReferenceId = null;
    this.planned = { pilot: 0, heldout: 0 };
    this.frozenConfigId = null;
    this.pilotSourceStudyId = null;
  }

  snapshot() {
    const fields = ['attempt_id', 'participant_id', 'session_id', 'split', 'role', 'pose_id',
      'relation', 'scene_condition', 'observed_hands', 'retry_index', 'retry_of_attempt_id',
      'browser_code', 'camera_code', 'lighting_code', 'reference_id', 'reference_group_id',
      'finished', 'attempt_ms', 'capture_ms', 'protocol_status', 'capture_outcome'];
    return {
      snapshot_version: STUDY_SNAPSHOT_VERSION, app_version: STUDY_VERSION, study_id: this.studyId,
      planned: { ...this.planned }, frozen_config_id: this.frozenConfigId,
      pilot_source_study_id: this.pilotSourceStudyId, current_reference_id: this.currentReferenceId,
      active_references: Object.fromEntries(this.activeReferences),
      attempts: this.attempts.map(attempt => ({
        ...Object.fromEntries(fields.map(field => [field, attempt[field] ?? null])),
        results: attempt.results ? Object.fromEntries(attempt.results) : null }))
    };
  }

  static fromSnapshot(value) {
    const fail = () => { throw new Error('Invalid or incompatible study snapshot; it was not replaced.'); };
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        value.snapshot_version !== STUDY_SNAPSHOT_VERSION || value.app_version !== STUDY_VERSION ||
        !Array.isArray(value.attempts) || value.attempts.length > 10000 ||
        !value.planned || typeof value.planned !== 'object' ||
        !value.active_references || typeof value.active_references !== 'object') fail();
    let study;
    try { study = new StudyRecorder({ studyId: value.study_id }); } catch { fail(); }
    for (const split of ['pilot', 'heldout']) {
      const count = value.planned[split];
      if (!Number.isSafeInteger(count) || count < 0) fail();
    }
    if (value.frozen_config_id !== null && !EVALUATION_CONFIGS.some(c => c.id === value.frozen_config_id)) fail();
    if (value.pilot_source_study_id !== null &&
        (typeof value.pilot_source_study_id !== 'string' ||
         !/^STUDY-[A-Z0-9]{4,16}$/.test(value.pilot_source_study_id) ||
         value.pilot_source_study_id === value.study_id)) fail();
    if (value.frozen_config_id && !value.pilot_source_study_id &&
        !value.attempts.some(a => a?.split === 'pilot' && a.finished && a.protocol_status === 'valid')) fail();
    const configs = EVALUATION_CONFIGS.map(c => c.id);
    const seen = new Map();
    let latestReference = null;
    for (const [index, raw] of value.attempts.entries()) {
      if (!raw || typeof raw !== 'object' || raw.attempt_id !== `A${String(index + 1).padStart(4, '0')}` ||
          typeof raw.finished !== 'boolean' || (index < value.attempts.length - 1 && !raw.finished) ||
          !Number.isSafeInteger(raw.retry_index) || raw.retry_index < 1) fail();
      try {
        id(raw.participant_id, 'P'); id(raw.session_id, 'S');
        member(raw.split, ['pilot', 'heldout'], 'split'); member(raw.role, ['reference', 'trial'], 'role');
        member(raw.pose_id, POSES, 'pose'); member(raw.relation, RELATIONS, 'relation');
        member(raw.scene_condition, SCENES, 'scene'); member(raw.observed_hands, HANDS, 'observed hands');
        member(raw.browser_code, ['chrome_current', 'other'], 'browser');
        member(raw.camera_code, CAMERAS, 'camera'); member(raw.lighting_code, LIGHTING, 'lighting');
      } catch { fail(); }
      if ((raw.role === 'reference') !== (raw.relation === 'reference') ||
          (raw.split === 'heldout' && !value.frozen_config_id) ||
          (raw.split === 'pilot' && value.frozen_config_id && value.pilot_source_study_id) ||
          (raw.role === 'reference' && raw.reference_id !== raw.attempt_id) ||
          (raw.role === 'trial' && raw.reference_id !== null && seen.get(raw.reference_id)?.role !== 'reference') ||
          (raw.role === 'trial' && raw.reference_id !== null && !seen.has(raw.reference_id)) ||
          (raw.role === 'reference' && raw.reference_group_id !==
            (raw.retry_of_attempt_id ? seen.get(raw.retry_of_attempt_id)?.reference_group_id : raw.attempt_id))) fail();
      const previous = index ? value.attempts[index - 1] : null;
      if (raw.role === 'trial' &&
          (raw.reference_id !== (latestReference?.attempt_id ?? null) ||
           raw.reference_group_id !== (latestReference?.reference_group_id ?? null))) fail();
      if (raw.retry_of_attempt_id === null) {
        if (raw.retry_index !== 1) fail();
      } else if (!previous || raw.retry_of_attempt_id !== previous.attempt_id ||
                 raw.retry_index !== previous.retry_index + 1 || raw.role !== previous.role ||
                 raw.split !== previous.split || raw.participant_id !== previous.participant_id ||
                 raw.session_id !== previous.session_id || raw.pose_id !== previous.pose_id ||
                 raw.relation !== previous.relation || raw.scene_condition !== previous.scene_condition ||
                 raw.camera_code !== previous.camera_code || raw.lighting_code !== previous.lighting_code ||
                 (raw.role === 'trial' && raw.reference_id !== previous.reference_id)) fail();
      if (!raw.finished) {
        if (raw.results !== null) fail();
      } else {
        if (!raw.results || Object.keys(raw.results).sort().join(',') !== [...configs].sort().join(',') ||
            !['valid', 'missing', 'protocol_invalid'].includes(raw.protocol_status) ||
            !['complete', 'state_reject', 'missing'].includes(raw.capture_outcome)) fail();
        for (const config of configs) {
          const r = raw.results[config];
          if (!r || !['accepted', 'rejected', 'not_run'].includes(r.quantization_outcome) ||
              !['reference', 'match', 'mismatch', 'not_evaluated', 'no_reference_for_config'].includes(r.comparison_status) ||
              ![null, 0, 1].includes(r.match) || ![0, 1].includes(r.signature_produced) ||
              ![null, 0, 1].includes(r.reference_available) || typeof r.rejection_code !== 'string' ||
              (r.quantization_outcome === 'accepted' && r.signature_produced !== 1) ||
              (r.quantization_outcome !== 'accepted' && r.signature_produced !== 0) ||
              (r.match !== null && (r.signature_produced !== 1 ||
                !['match', 'mismatch'].includes(r.comparison_status) ||
                r.reference_available !== 1 || r.match !== Number(r.comparison_status === 'match'))) ||
              (raw.capture_outcome !== 'complete' && (r.match !== null || r.signature_produced !== 0))) fail();
        }
      }
      seen.set(raw.attempt_id, raw);
      if (raw.role === 'reference') latestReference = raw;
      study.attempts.push({ ...raw, startedAt: null,
        results: raw.results === null ? null : new Map(configs.map(config => [config, { ...raw.results[config] }])) });
    }
    if (value.current_reference_id !== null &&
        (!seen.has(value.current_reference_id) || seen.get(value.current_reference_id).role !== 'reference' ||
         value.current_reference_id !== [...value.attempts].reverse().find(a => a.role === 'reference')?.attempt_id)) fail();
    if (value.current_reference_id === null && value.attempts.some(a => a.role === 'reference')) fail();
    const referenceEntries = Object.entries(value.active_references);
    const currentReference = seen.get(value.current_reference_id);
    const expectedActiveConfigs = currentReference?.finished && currentReference.protocol_status === 'valid'
      ? configs.filter(config => currentReference.results[config].quantization_outcome === 'accepted') : [];
    if (referenceEntries.map(([config]) => config).sort().join(',') !== expectedActiveConfigs.sort().join(',')) fail();
    if (referenceEntries.length > configs.length ||
        referenceEntries.some(([config, ref]) => !configs.includes(config) || !ref ||
          ref.id !== value.current_reference_id || typeof ref.sig !== 'string' ||
          !/^GC1:[A-Za-z0-9-]+$/.test(ref.sig) ||
          seen.get(ref.id)?.results?.[config]?.quantization_outcome !== 'accepted' ||
          seen.get(ref.id)?.protocol_status !== 'valid')) fail();
    study.planned = { pilot: value.planned.pilot, heldout: value.planned.heldout };
    study.frozenConfigId = value.frozen_config_id;
    study.pilotSourceStudyId = value.pilot_source_study_id;
    study.currentReferenceId = value.current_reference_id;
    study.activeReferences = new Map(referenceEntries.map(([config, ref]) => [config, { id: ref.id, sig: ref.sig }]));
    return study;
  }

  interruptPending() {
    const last = this.attempts.at(-1);
    if (!last || last.finished) return false;
    this.finish(last.attempt_id, { captureCode: 'interrupted', now: Number.NaN });
    return true;
  }

  setPlanned(split, count) {
    member(split, ['pilot', 'heldout'], 'split');
    if (this.attempts.some(attempt => attempt.split === split) && count !== this.planned[split]) {
      throw new Error('Planned count cannot change after attempts begin in this split.');
    }
    if (!Number.isSafeInteger(count) || count < 0 || count < this.attempts.filter(attempt => attempt.split === split).length) {
      throw new Error('Planned count must be at least the number of initiated attempts.');
    }
    this.planned[split] = count;
  }

  freeze(configId, pilotSourceStudyId = null) {
    if (this.frozenConfigId || this.attempts.some(attempt => attempt.split === 'heldout')) throw new Error('Configuration is already frozen or held-out work has started.');
    member(configId, EVALUATION_CONFIGS.map(config => config.id), 'configuration');
    if (pilotSourceStudyId !== null) {
      if (!/^STUDY-[A-Z0-9]{4,16}$/.test(pilotSourceStudyId) || pilotSourceStudyId === this.studyId ||
          this.attempts.some(attempt => attempt.split === 'pilot')) throw new Error('Use a distinct, reviewed pilot study ID before held-out collection.');
      this.pilotSourceStudyId = pilotSourceStudyId;
    } else if (!this.attempts.some(attempt => attempt.split === 'pilot' && attempt.finished && attempt.protocol_status === 'valid')) {
      throw new Error('Record valid pilot attempts or enter a reviewed pilot study ID before freezing.');
    }
    this.frozenConfigId = configId;
  }

  begin(meta, now = performance.now()) {
    const split = member(meta.split, ['pilot', 'heldout'], 'split');
    if (split === 'heldout' && !this.frozenConfigId) throw new Error('Freeze a pilot-selected configuration before held-out trials.');
    if (split === 'pilot' && this.frozenConfigId) throw new Error('Pilot collection is closed after freezing.');
    const role = member(meta.role, ['reference', 'trial'], 'role');
    const relation = member(meta.relation, RELATIONS, 'relation');
    if ((role === 'reference') !== (relation === 'reference')) throw new Error('Reference role and relation must agree.');
    const previous = this.attempts.at(-1);
    if (previous && !previous.finished) throw new Error('Finish the current attempt before starting another.');
    const currentReference = this.attempts.find(item => item.attempt_id === this.currentReferenceId);
    if (role === 'trial' && currentReference &&
        (currentReference.split !== split || currentReference.session_id !== meta.sessionId)) {
      throw new Error('Start a reference in this split and session before running trials.');
    }
    if (role === 'trial' && currentReference) {
      const samePerson = meta.participantId === currentReference.participant_id;
      const samePose = meta.poseId === currentReference.pose_id;
      if ((relation === 'genuine' && (!samePerson || !samePose)) ||
          (relation === 'different_pose' && (!samePerson || samePose)) ||
          (relation === 'impostor' && (samePerson || !samePose))) throw new Error('Trial relation does not match its reference.');
    }
    if (meta.retry !== undefined && typeof meta.retry !== 'boolean') throw new Error('Retry intent must be explicit.');
    const retry = meta.retry === true;
    if (retry && (!previous?.finished || previous.role !== role || previous.split !== split ||
        previous.participant_id !== meta.participantId || previous.session_id !== meta.sessionId ||
        previous.pose_id !== meta.poseId || previous.relation !== relation ||
        previous.scene_condition !== meta.sceneCondition || previous.camera_code !== meta.cameraCode ||
        previous.lighting_code !== meta.lightingCode ||
        (role === 'trial' && previous.reference_id !== this.currentReferenceId))) {
      throw new Error('Retry must immediately follow a completed attempt with the same role, person, session, pose, relation, scene, camera, lighting, and reference group.');
    }
    const retryIndex = retry ? previous.retry_index + 1 : 1;
    if (!Number.isSafeInteger(retryIndex)) throw new Error('Retry index overflow.');
    const attempt = {
      attempt_id: `A${String(this.attempts.length + 1).padStart(4, '0')}`,
      participant_id: id(meta.participantId, 'P'), session_id: id(meta.sessionId, 'S'),
      split, role, pose_id: member(meta.poseId, POSES, 'pose'), relation,
      scene_condition: member(meta.sceneCondition, SCENES, 'scene'),
      observed_hands: member(meta.observedHands, HANDS, 'observed hands'),
      retry_index: retryIndex, retry_of_attempt_id: retry ? previous.attempt_id : null,
      browser_code: member(meta.browserCode, ['chrome_current', 'other'], 'browser'),
      camera_code: member(meta.cameraCode, CAMERAS, 'camera'),
      lighting_code: member(meta.lightingCode, LIGHTING, 'lighting'),
      startedAt: now, finished: false, results: null
    };
    attempt.reference_group_id = role === 'reference'
      ? (retry ? previous.reference_group_id : attempt.attempt_id)
      : (currentReference?.reference_group_id ?? null);
    if (role === 'reference') {
      this.currentReferenceId = attempt.attempt_id;
      this.activeReferences.clear();
    }
    attempt.reference_id = this.currentReferenceId;
    this.attempts.push(attempt);
    return attempt.attempt_id;
  }

  finish(attemptId, { summary = null, captureCode = 'complete', captureMs = null,
    protocolStatus = 'valid', now = performance.now() } = {}) {
    const attempt = this.attempts.find(item => item.attempt_id === attemptId);
    if (!attempt || attempt.finished) throw new Error('Unknown or already completed attempt.');
    member(captureCode, CAPTURE_CODES, 'capture code');
    member(protocolStatus, ['valid', 'missing', 'protocol_invalid'], 'protocol status');
    if (captureCode === 'complete' && !summary) throw new Error('Completed capture requires its derived summary.');
    attempt.attempt_ms = roundMs(now - attempt.startedAt);
    attempt.capture_ms = roundMs(captureMs);
    attempt.protocol_status = protocolStatus;
    attempt.capture_outcome = captureCode === 'complete' ? 'complete' : captureCode === 'missing' ? 'missing' : 'state_reject';
    attempt.results = new Map();
    for (const config of EVALUATION_CONFIGS) {
      let result;
      const reference = attempt.role === 'trial' ? this.activeReferences.get(config.id) : null;
      const referenceAvailable = attempt.role === 'trial' ? Number(!!reference) : null;
      const comparisonWhenUnmatched = attempt.role === 'reference' ? 'reference' : reference ? 'not_evaluated' : 'no_reference_for_config';
      if (attempt.capture_outcome !== 'complete' || protocolStatus !== 'valid') {
        result = { quantization_outcome: 'not_run', rejection_code: protocolStatus === 'valid' ? captureCode : protocolStatus,
          comparison_status: comparisonWhenUnmatched, reference_available: referenceAvailable,
          signature_produced: 0, match: null };
      } else {
        const quantized = quantizeForEvaluation(summary, config);
        if (!quantized.ok) result = { quantization_outcome: 'rejected', rejection_code: quantized.code,
          comparison_status: comparisonWhenUnmatched, reference_available: referenceAvailable,
          signature_produced: 0, match: null };
        else if (attempt.role === 'reference') {
          this.activeReferences.set(config.id, { id: attempt.attempt_id, sig: quantized.sig });
          result = { quantization_outcome: 'accepted', comparison_status: 'reference',
            rejection_code: '', reference_available: null, signature_produced: 1, match: null };
        } else {
          const matches = reference ? quantized.sig === reference.sig : null;
          result = { quantization_outcome: 'accepted', comparison_status: reference ? matches ? 'match' : 'mismatch' : 'no_reference_for_config',
            rejection_code: '', reference_available: referenceAvailable, signature_produced: 1,
            match: matches === null ? null : Number(matches) };
        }
      }
      attempt.results.set(config.id, result);
    }
    attempt.finished = true;
    return attempt.results.get('baseline');
  }

  excludeLast() {
    const attempt = this.attempts.at(-1);
    if (!attempt?.finished || attempt.protocol_status !== 'valid' ||
        (this.frozenConfigId && attempt.split === 'pilot')) throw new Error('Only the latest valid attempt can be excluded; pilot data is locked after freeze.');
    attempt.protocol_status = 'protocol_invalid';
    for (const result of attempt.results.values()) {
      result.quantization_outcome = 'not_run';
      result.comparison_status = 'not_evaluated';
      result.rejection_code = 'protocol_invalid';
      result.signature_produced = 0;
      result.match = null;
    }
    if (attempt.role === 'reference') this.activeReferences.clear();
  }

  rows() {
    return this.attempts.flatMap(attempt => EVALUATION_CONFIGS.map(config => {
      const result = attempt.results?.get(config.id) ?? { quantization_outcome: 'not_run',
        comparison_status: 'not_evaluated', rejection_code: 'missing', reference_available: null,
        signature_produced: 0, match: null };
      return {
        study_id: this.studyId, app_version: STUDY_VERSION, attempt_id: attempt.attempt_id, participant_id: attempt.participant_id,
        session_id: attempt.session_id, split: attempt.split, role: attempt.role, pose_id: attempt.pose_id,
        reference_id: attempt.reference_id, reference_group_id: attempt.reference_group_id,
        retry_of_attempt_id: attempt.retry_of_attempt_id, relation: attempt.relation, scene_condition: attempt.scene_condition,
        observed_hands: attempt.observed_hands, config_id: config.id,
        capture_outcome: attempt.finished ? attempt.capture_outcome : 'missing',
        ...result, attempt_ms: attempt.attempt_ms ?? null, capture_ms: attempt.capture_ms ?? null,
        retry_index: attempt.retry_index, browser_code: attempt.browser_code,
        camera_code: attempt.camera_code, lighting_code: attempt.lighting_code,
        protocol_status: attempt.finished ? attempt.protocol_status : 'missing'
      };
    }));
  }

  csv() {
    return [CSV_FIELDS.join(','), ...this.rows().map(row => CSV_FIELDS.map(field => csvCell(row[field] ?? '')).join(','))].join('\r\n') + '\r\n';
  }

  summary() {
    const rows = this.rows();
    const metrics = {};
    for (const split of ['pilot', 'heldout']) {
      metrics[split] = {};
      for (const config of EVALUATION_CONFIGS) {
        metrics[split][config.id] = {};
        for (const relation of RELATIONS) {
          const group = rows.filter(row => row.split === split && row.config_id === config.id && row.relation === relation);
          const valid = group.filter(row => row.protocol_status === 'valid');
          const signed = valid.filter(row => row.signature_produced === 1);
          const comparable = valid.filter(row => row.match !== null);
          const matches = comparable.filter(row => row.match === 1).length;
          const withReference = valid.filter(row => row.reference_available === 1);
          const reasonCounts = {};
          for (const row of valid) if (row.rejection_code) reasonCounts[row.rejection_code] = (reasonCounts[row.rejection_code] ?? 0) + 1;
          metrics[split][config.id][relation] = {
            recorded: group.length, excluded: group.length - valid.length,
            signature_acceptance: fraction(signed.length, valid.length),
            rejection: fraction(valid.length - signed.length, valid.length),
            no_reference_for_config: valid.filter(row => row.comparison_status === 'no_reference_for_config').length,
            end_to_end_match: fraction(matches, withReference.length),
            conditional_match: fraction(matches, withReference.filter(row => row.signature_produced === 1).length),
            rejection_codes: reasonCounts, attempt_latency: latency(valid.map(row => row.attempt_ms)),
            capture_latency: latency(valid.map(row => row.capture_ms))
          };
        }
      }
    }
    const recorded = Object.fromEntries(['pilot', 'heldout'].map(split => [split,
      this.attempts.filter(attempt => attempt.split === split).length]));
    return {
      schema_version: 2, app_version: STUDY_VERSION, study_id: this.studyId,
      pilot_source_study_id: this.pilotSourceStudyId, planned_unit: 'physical_attempts',
      planned: { ...this.planned }, recorded,
      uninitiated: Object.fromEntries(['pilot', 'heldout'].map(split => [split, Math.max(0, this.planned[split] - recorded[split])])),
      overrun: Object.fromEntries(['pilot', 'heldout'].map(split => [split, Math.max(0, recorded[split] - this.planned[split])])),
      frozen_config_id: this.frozenConfigId,
      configs: EVALUATION_CONFIGS.map(config => ({ ...config })),
      gesture_config: { finger_thresholds: [...CFG.FINGER_T], thumb_thresholds: [...CFG.THUMB_T],
        spread_threshold_degrees: CFG.SPREAD_T, max_ratio_sd: CFG.MAX_STD_R, max_angle_sd: CFG.MAX_STD_A,
        capture_frames: CFG.FRAMES },
      capture_config: { ...CAPTURE_CONFIG },
      exclusions: this.attempts.filter(attempt => !attempt.finished || attempt.protocol_status !== 'valid').length,
      exclusions_by_status: Object.fromEntries(['pilot', 'heldout'].map(split => [split,
        Object.fromEntries(['missing', 'protocol_invalid'].map(status => [status,
          this.attempts.filter(attempt => attempt.split === split &&
            (!attempt.finished ? status === 'missing' : attempt.protocol_status === status)).length]))])),
      metrics
    };
  }

  json() { return JSON.stringify(this.summary(), null, 2) + '\n'; }
}
