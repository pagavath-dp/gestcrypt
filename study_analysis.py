"""Offline, dependency-free analysis of paired GestCrypt study exports.

Usage: python3 study_analysis.py study.csv study_summary.json --out NEW_DIRECTORY
The output directory must not already exist; input exports are read only.
"""

import argparse
import csv
import hashlib
import html
import json
import math
from collections import Counter, defaultdict
from pathlib import Path
from statistics import median


CONFIGS = ('loose', 'baseline', 'strict')
CONFIG_PARAMETERS = ((0.02, 1), (0.04, 2), (0.06, 3))
SPLITS = ('pilot', 'heldout')
RELATIONS = ('reference', 'genuine', 'different_pose', 'impostor', 'ambiguous')
POSES = ('fist', 'open_palm', 'three_finger', 'swag')
BASE_FIELDS = ('study_id', 'app_version', 'attempt_id', 'participant_id', 'session_id', 'split',
               'role', 'pose_id', 'reference_id', 'relation', 'scene_condition', 'observed_hands',
               'config_id', 'capture_outcome', 'quantization_outcome', 'comparison_status',
               'rejection_code', 'reference_available', 'signature_produced', 'match',
               'attempt_ms', 'capture_ms', 'retry_index', 'browser_code', 'camera_code',
               'lighting_code', 'protocol_status')
V2_EXTRA = ('reference_group_id', 'retry_of_attempt_id')
V2_FIELDS = BASE_FIELDS[:9] + V2_EXTRA + BASE_FIELDS[9:]
COLORS = {'match': '#17806d', 'mismatch': '#c46d42', 'rejected': '#ad4770',
          'rejected_no_reference': '#7852a2', 'accepted_no_reference': '#a98135',
          'acceptance': '#216b9a', 'conditional': '#17806d', 'end_to_end': '#8a5b9c'}


class StudyDataError(ValueError):
    """A study export is malformed or inconsistent with its paired summary."""


def require(condition, message):
    if not condition:
        raise StudyDataError(message)


def number(value, field, *, nullable=False, integer=False):
    if value == '' and nullable:
        return None
    try:
        result = int(value) if integer else float(value)
    except (ValueError, TypeError):
        raise StudyDataError(f'{field}: expected a nonnegative number') from None
    require(math.isfinite(result) and result >= 0, f'{field}: expected a nonnegative number')
    return result


def fraction(num, den):
    return {'numerator': num, 'denominator': den, 'value': num / den if den else None}


def latency(rows, field):
    values = sorted(number(row[field], field, nullable=True) for row in rows if row[field] != '')
    return {'count': len(values), 'median_ms': median(values) if values else None,
            'min_ms': values[0] if values else None, 'max_ms': values[-1] if values else None}


def source_summary(rows, schema):
    """Recompute fields emitted by both study recorder schema versions."""
    metrics = {}
    for split in SPLITS:
        metrics[split] = {}
        for config in CONFIGS:
            metrics[split][config] = {}
            for relation in RELATIONS:
                group = [r for r in rows if (r['split'], r['config_id'], r['relation']) ==
                         (split, config, relation)]
                valid = [r for r in group if r['protocol_status'] == 'valid']
                signed = [r for r in valid if r['signature_produced'] == '1']
                with_ref = [r for r in valid if r['reference_available'] == '1']
                matches = sum(r['match'] == '1' for r in valid)
                metrics[split][config][relation] = {
                    'recorded': len(group), 'excluded': len(group) - len(valid),
                    'signature_acceptance': fraction(len(signed), len(valid)),
                    'rejection': fraction(len(valid) - len(signed), len(valid)),
                    'no_reference_for_config': sum(r['comparison_status'] == 'no_reference_for_config' for r in valid),
                    'end_to_end_match': fraction(matches, len(with_ref)),
                    'conditional_match': fraction(matches, sum(r['signature_produced'] == '1' for r in with_ref)),
                    'rejection_codes': dict(Counter(r['rejection_code'] for r in valid if r['rejection_code'])),
                    'attempt_latency': latency(valid, 'attempt_ms'),
                    'capture_latency': latency(valid, 'capture_ms')
                }
    physical = [r for r in rows if r['config_id'] == 'baseline']
    recorded = {s: sum(r['split'] == s for r in physical) for s in SPLITS}
    exclusions_by_status = {s: {p: sum(r['split'] == s and r['protocol_status'] == p for r in physical)
                                for p in ('missing', 'protocol_invalid')} for s in SPLITS}
    return {'recorded': recorded, 'exclusions': sum(r['protocol_status'] != 'valid' for r in physical),
            'exclusions_by_status': exclusions_by_status, 'metrics': metrics}


def compare(actual, expected, path='summary'):
    if isinstance(expected, dict):
        require(isinstance(actual, dict), f'{path}: expected object')
        for key, value in expected.items():
            require(key in actual, f'{path}.{key}: missing from JSON')
            compare(actual[key], value, f'{path}.{key}')
    elif isinstance(expected, float):
        require(isinstance(actual, (int, float)) and math.isfinite(actual) and
                math.isclose(actual, expected, rel_tol=1e-12, abs_tol=1e-12),
                f'{path}: CSV/JSON mismatch (CSV {expected}, JSON {actual})')
    else:
        require(actual == expected, f'{path}: CSV/JSON mismatch (CSV {expected}, JSON {actual})')


def load_study(csv_path, json_path):
    try:
        with open(json_path, encoding='utf-8') as stream:
            doc = json.load(stream)
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise StudyDataError(f'JSON could not be read: {error}') from error
    require(isinstance(doc, dict) and type(doc.get('schema_version')) is int and
            doc['schema_version'] in (1, 2), 'JSON schema_version must be 1 or 2')
    schema = doc['schema_version']
    expected_fields = BASE_FIELDS if schema == 1 else V2_FIELDS
    require(doc.get('app_version') == f'gestcrypt-m3-eval-{schema}', 'JSON app_version does not match schema')
    require(isinstance(doc.get('study_id'), str) and doc['study_id'].startswith('STUDY-'), 'JSON study_id is invalid')
    require(isinstance(doc.get('configs'), list) and
            [c.get('id') for c in doc['configs'] if isinstance(c, dict)] == list(CONFIGS),
            'JSON configuration list must be loose, baseline, strict')
    require(all(isinstance(item.get('ratioMargin'), (int, float)) and
                isinstance(item.get('angleMargin'), (int, float)) and
                (item['ratioMargin'], item['angleMargin']) == expected
                for item, expected in zip(doc['configs'], CONFIG_PARAMETERS)),
            'JSON configuration margins do not match supported study settings')
    for field in ('planned', 'recorded', 'uninitiated', 'overrun', 'metrics', 'exclusions_by_status'):
        require(isinstance(doc.get(field), dict), f'JSON {field} must be an object')
    try:
        with open(csv_path, newline='', encoding='utf-8-sig') as stream:
            reader = csv.DictReader(stream, strict=True)
            require(reader.fieldnames == list(expected_fields), f'CSV fields do not match schema v{schema}')
            rows = list(reader)
    except (OSError, UnicodeError, csv.Error) as error:
        raise StudyDataError(f'CSV could not be read: {error}') from error
    require(rows, 'CSV contains no attempt rows')
    keys = set()
    by_attempt = defaultdict(list)
    for index, row in enumerate(rows, 2):
        require(None not in row and all(value is not None for value in row.values()),
                f'CSV row {index}: wrong column count')
        require(row['study_id'] == doc['study_id'] and row['app_version'] == doc['app_version'],
                f'CSV row {index}: study_id or app_version does not match JSON')
        for field, choices in (('split', SPLITS), ('config_id', CONFIGS), ('role', ('reference', 'trial')),
                               ('relation', RELATIONS), ('pose_id', POSES),
                               ('protocol_status', ('valid', 'missing', 'protocol_invalid')),
                               ('capture_outcome', ('complete', 'state_reject', 'missing')),
                               ('quantization_outcome', ('accepted', 'rejected', 'not_run')),
                               ('comparison_status', ('reference', 'match', 'mismatch',
                                                      'not_evaluated', 'no_reference_for_config'))):
            require(row[field] in choices, f'CSV row {index}: invalid {field}: {row[field]}')
        require(row['attempt_id'] and row['participant_id'] and row['session_id'],
                f'CSV row {index}: missing attempt, participant, or session ID')
        require((row['role'] == 'reference') == (row['relation'] == 'reference'),
                f'CSV row {index}: reference role/relation mismatch')
        key = (row['study_id'], row['attempt_id'], row['config_id'])
        require(key not in keys, f'CSV row {index}: duplicate study/attempt/configuration {key}')
        keys.add(key)
        by_attempt[row['attempt_id']].append(row)
        for field in ('attempt_ms', 'capture_ms'):
            number(row[field], f'CSV row {index} {field}', nullable=True)
        require(number(row['retry_index'], f'CSV row {index} retry_index', integer=True) >= 1,
                f'CSV row {index}: retry_index must be at least 1')
        require(row['reference_available'] in ('', '0', '1') and row['signature_produced'] in ('0', '1') and
                row['match'] in ('', '0', '1'), f'CSV row {index}: invalid boolean outcome')
        require((row['quantization_outcome'] == 'accepted') == (row['signature_produced'] == '1'),
                f'CSV row {index}: signature/quantization inconsistency')
        if row['match'] != '':
            require(row['comparison_status'] == ('match' if row['match'] == '1' else 'mismatch') and
                    row['signature_produced'] == '1' and row['reference_available'] == '1' and
                    row['role'] == 'trial' and row['protocol_status'] == 'valid',
                    f'CSV row {index}: invalid match or mismatch')
        if row['comparison_status'] in ('match', 'mismatch'):
            require(row['match'] != '', f'CSV row {index}: comparison missing match value')
        if row['role'] == 'reference':
            reference_status_ok = (row['comparison_status'] == 'reference' or
                                   (row['protocol_status'] != 'valid' and
                                    row['comparison_status'] == 'not_evaluated'))
            require(reference_status_ok and row['reference_available'] == '' and
                    row['reference_id'] == row['attempt_id'],
                    f'CSV row {index}: invalid reference outcome or link')
        else:
            require(row['comparison_status'] != 'reference', f'CSV row {index}: trial marked as reference')
            require(row['reference_available'] in ('0', '1'),
                    f'CSV row {index}: trial reference availability is missing')
            require(row['reference_available'] != '1' or bool(row['reference_id']),
                    f'CSV row {index}: available reference has no reference_id')
            if row['comparison_status'] == 'no_reference_for_config':
                require(row['reference_available'] == '0' and row['match'] == '',
                        f'CSV row {index}: no-reference outcome is inconsistent')
        if row['protocol_status'] != 'valid':
            require(row['match'] == '' and row['signature_produced'] == '0',
                    f'CSV row {index}: excluded attempt has a performance outcome')
        if schema == 2:
            require(bool(row['retry_of_attempt_id']) == (int(row['retry_index']) > 1),
                    f'CSV row {index}: retry link/index inconsistency')
            if row['role'] == 'reference':
                require(bool(row['reference_group_id']), f'CSV row {index}: reference group is missing')
    shared = tuple(field for field in expected_fields if field not in
                   ('config_id', 'quantization_outcome', 'comparison_status', 'rejection_code',
                    'reference_available', 'signature_produced', 'match'))
    for attempt_id, group in by_attempt.items():
        require(len(group) == 3 and {r['config_id'] for r in group} == set(CONFIGS),
                f'{attempt_id}: expected exactly one row for each configuration')
        for row in group[1:]:
            require(all(row[field] == group[0][field] for field in shared),
                    f'{attempt_id}: physical-attempt fields differ across configurations')
    physical = [r for r in rows if r['config_id'] == 'baseline']
    by_id = {r['attempt_id']: r for r in physical}
    attempt_positions = {r['attempt_id']: index for index, r in enumerate(physical)}
    for index, row in enumerate(physical):
        if row['role'] == 'trial' and row['reference_id']:
            reference = by_id.get(row['reference_id'])
            require(reference is not None and reference['role'] == 'reference' and
                    reference['split'] == row['split'] and reference['session_id'] == row['session_id'] and
                    attempt_positions[row['reference_id']] < index,
                    f"{row['attempt_id']}: reference_id does not link to a reference in this split/session")
            if schema == 2:
                require(row['reference_group_id'] == reference['reference_group_id'],
                        f"{row['attempt_id']}: reference group does not match candidate")
        if schema == 2:
            if row['role'] == 'reference' and row['retry_index'] == '1':
                require(row['reference_group_id'] == row['attempt_id'],
                        f"{row['attempt_id']}: new reference must start its own group")
            if int(row['retry_index']) > 1:
                previous = physical[index - 1] if index else None
                require(previous is not None and row['retry_of_attempt_id'] == previous['attempt_id'] and
                        int(row['retry_index']) == int(previous['retry_index']) + 1 and
                        row['reference_group_id'] == previous['reference_group_id'] and
                        row['role'] == previous['role'] and row['split'] == previous['split'] and
                        row['session_id'] == previous['session_id'] and row['participant_id'] == previous['participant_id'] and
                        row['pose_id'] == previous['pose_id'] and row['relation'] == previous['relation'] and
                        row['scene_condition'] == previous['scene_condition'] and
                        row['camera_code'] == previous['camera_code'] and
                        row['lighting_code'] == previous['lighting_code'] and
                        (row['role'] == 'reference' or row['reference_id'] == previous['reference_id']),
                        f"{row['attempt_id']}: retry link/index is not the previous compatible attempt")
    for split in SPLITS:
        planned = doc.get('planned', {}).get(split)
        require(type(planned) is int and planned >= 0, f'JSON planned.{split} is invalid')
        recorded = sum(r['split'] == split for r in physical)
        for field, expected in (('uninitiated', max(0, planned - recorded)),
                                ('overrun', max(0, recorded - planned))):
            compare(doc.get(field, {}).get(split), expected, f'JSON {field}.{split}')
    if schema == 2:
        require(doc.get('planned_unit') == 'physical_attempts', 'JSON planned_unit must be physical_attempts')
        require('pilot_source_study_id' in doc, 'JSON pilot_source_study_id is missing')
    require(doc.get('frozen_config_id') is None or doc['frozen_config_id'] in CONFIGS,
            'JSON frozen_config_id is invalid')
    require(not any(r['split'] == 'heldout' for r in physical) or doc['frozen_config_id'] in CONFIGS,
            'Held-out attempts require a frozen configuration')
    compare(doc, source_summary(rows, schema))
    return rows, doc


def outcome_counts(rows):
    counts = Counter()
    for row in rows:
        if row['signature_produced'] == '0':
            key = 'rejected_no_reference' if row['reference_available'] == '0' else 'rejected'
        elif row['reference_available'] == '0':
            key = 'accepted_no_reference'
        elif row['comparison_status'] in ('match', 'mismatch'):
            key = row['comparison_status']
        else:
            key = 'unavailable'
        counts[key] += 1
    return dict(counts)


def analysis(rows, doc, split):
    valid = [r for r in rows if r['split'] == split and r['protocol_status'] == 'valid']
    physical = [r for r in rows if r['split'] == split and r['config_id'] == 'baseline']
    configs = {}
    for config in CONFIGS:
        group = [r for r in valid if r['config_id'] == config]
        genuine = [r for r in group if r['relation'] == 'genuine']
        refs = [r for r in group if r['role'] == 'reference']
        with_ref = [r for r in genuine if r['reference_available'] == '1']
        matches = sum(r['match'] == '1' for r in genuine)
        signed = sum(r['signature_produced'] == '1' for r in genuine)
        per_pose = {}
        for pose in POSES:
            subset = [r for r in genuine if r['pose_id'] == pose]
            per_pose[pose] = {'valid_trials': len(subset), 'outcomes': outcome_counts(subset)}
        configs[config] = {
            'valid_genuine_trials': len(genuine), 'outcomes': outcome_counts(genuine),
            'signature_acceptance': fraction(signed, len(genuine)),
            'rejection': fraction(len(genuine) - signed, len(genuine)),
            'conditional_match': fraction(matches, sum(r['signature_produced'] == '1' for r in with_ref)),
            'end_to_end_match': fraction(matches, len(with_ref)),
            'reference_acceptance': fraction(sum(r['signature_produced'] == '1' for r in refs), len(refs)),
            'rejection_reasons_genuine': dict(Counter(r['rejection_code'] for r in genuine if r['rejection_code'])),
            'rejection_reasons_reference': dict(Counter(r['rejection_code'] for r in refs if r['rejection_code'])),
            'per_pose': per_pose
        }
    retry = None if doc['schema_version'] == 1 else {
        'initiated_retries': sum(int(r['retry_index']) > 1 for r in physical),
        'reference_retries': sum(r['role'] == 'reference' and int(r['retry_index']) > 1 for r in physical),
        'trial_retries': sum(r['role'] == 'trial' and int(r['retry_index']) > 1 for r in physical)
    }
    return {'study_id': doc['study_id'], 'split': split,
            'protocol_label': 'exploratory pilot' if split == 'pilot' else 'held-out evaluation',
            'schema_version': doc['schema_version'], 'frozen_config_id': doc.get('frozen_config_id'),
            'physical_attempts': len(physical),
            'excluded': dict(Counter(r['protocol_status'] for r in physical if r['protocol_status'] != 'valid')),
            'retry_counts': retry,
            'reference_groups': (None if doc['schema_version'] == 1 else
                                 len({r['reference_group_id'] for r in physical if r['role'] == 'reference'})),
            'configs': configs,
            'latency': {field: latency([r for r in physical if r['protocol_status'] == 'valid'], field)
                        for field in ('attempt_ms', 'capture_ms')},
            'latency_values_ms': {field: [number(r[field], field) for r in physical
                                          if r['protocol_status'] == 'valid' and r[field] != '']
                                  for field in ('attempt_ms', 'capture_ms')}}


def esc(value):
    return html.escape(str(value), quote=True)


class Figure:
    def __init__(self, title, data, definition, height=610):
        self.height = height
        self.items = [f'<svg xmlns="http://www.w3.org/2000/svg" width="1050" height="{height}" viewBox="0 0 1050 {height}" role="img">',
                      '<rect width="1050" height="100%" fill="#ffffff"/>']
        self.text(55, 48, title, 25, '#17283e', weight='bold')
        self.text(55, 77, f"{data['study_id']}  |  {data['split'].upper()} — {data['protocol_label']}  |  n={data['physical_attempts']} physical attempts", 14, '#41546b')
        self.text(55, height - 58, 'Configurations: loose 0.02/1°, baseline 0.04/2°, strict 0.06/3°.', 12, '#41546b')
        self.text(55, height - 38, definition, 12, '#41546b')
        self.text(55, height - 18, 'Valid protocol attempts only; excluded and unavailable-reference outcomes are reported separately.', 12, '#41546b')

    def text(self, x, y, value, size=14, color='#17283e', weight='normal', anchor='start'):
        self.items.append(f'<text x="{x}" y="{y}" fill="{color}" font-family="Arial, sans-serif" font-size="{size}" font-weight="{weight}" text-anchor="{anchor}">{esc(value)}</text>')

    def rect(self, x, y, width, height, color):
        self.items.append(f'<rect x="{x}" y="{y}" width="{max(0, width):.2f}" height="{height}" fill="{color}"/>')

    def line(self, x1, y1, x2, y2, color='#d1dae3'):
        self.items.append(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{color}"/>')

    def circle(self, x, y, radius, color):
        self.items.append(f'<circle cx="{x:.2f}" cy="{y:.2f}" r="{radius}" fill="{color}"/>')

    def save(self, path):
        path.write_text('\n'.join(self.items + ['</svg>']) + '\n', encoding='utf-8')


def stacked(fig, y, label, counts, scale_max, categories):
    fig.text(55, y + 16, label, 14)
    x = 245
    total = sum(counts.values())
    for category in categories:
        value = counts.get(category, 0)
        width = 620 * value / max(scale_max, 1)
        fig.rect(x, y, width, 28, COLORS.get(category, '#738496'))
        if width >= 25:
            fig.text(x + width / 2, y + 19, value, 12, '#ffffff', weight='bold', anchor='middle')
        x += width
    fig.text(880, y + 19, f'n={total}', 13)


def draw_figures(data, out):
    configs = data['configs']
    outcomes = ('match', 'mismatch', 'rejected', 'rejected_no_reference', 'accepted_no_reference')
    legend = [('match', 'Match'), ('mismatch', 'Mismatch'), ('rejected', 'Rejected with reference'),
              ('rejected_no_reference', 'Rejected; no reference'), ('accepted_no_reference', 'Accepted; no reference')]

    fig = Figure('Genuine trial outcomes by configuration', data,
                 'Denominator: valid genuine trials per configuration.')
    for i, (key, label) in enumerate(legend):
        x = 55 + (i % 3) * 325; y = 120 + (i // 3) * 30
        fig.rect(x, y - 12, 14, 14, COLORS[key]); fig.text(x + 22, y, label, 12)
    max_n = max(configs[c]['valid_genuine_trials'] for c in CONFIGS)
    for i, c in enumerate(CONFIGS):
        stacked(fig, 220 + i * 85, c, configs[c]['outcomes'], max_n, outcomes)
    fig.save(out / '01_configuration_outcomes.svg')

    fig = Figure('Acceptance and exact-match rates', data,
                 'Denominator: shown as n/d for each rate; N/A means no eligible reference.', 700)
    fig.text(55, 112, 'Acceptance: signed / valid genuine. Conditional: match / signed with reference.', 13)
    fig.text(55, 133, 'End-to-end: match / valid genuine with reference. Rejections are never mismatches.', 13)
    for tick in range(0, 101, 25):
        x = 290 + tick * 6.3; fig.line(x, 165, x, 600); fig.text(x, 622, f'{tick}%', 12, anchor='middle')
    for i, c in enumerate(CONFIGS):
        for j, (key, title) in enumerate((('signature_acceptance', 'Acceptance'),
                                          ('conditional_match', 'Conditional match'),
                                          ('end_to_end_match', 'End-to-end match'))):
            y = 177 + i * 145 + j * 39; rate = configs[c][key]
            fig.text(55, y + 17, f'{c} · {title}', 13)
            if rate['value'] is not None:
                fig.rect(290, y, rate['value'] * 630, 23, COLORS[{'signature_acceptance': 'acceptance',
                                                                 'conditional_match': 'conditional',
                                                                 'end_to_end_match': 'end_to_end'}[key]])
            fig.text(940, y + 17, f"{rate['numerator']}/{rate['denominator']}" +
                     (f" ({rate['value']:.0%})" if rate['value'] is not None else ' (N/A)'), 12)
    fig.save(out / '02_rates.svg')

    fig = Figure('Per-pose genuine trial outcomes', data,
                 'Denominator: valid genuine trials for each pose/configuration.', 975)
    for i, (key, label) in enumerate(legend):
        x = 55 + (i % 3) * 325; y = 112 + (i // 3) * 27
        fig.rect(x, y - 12, 14, 14, COLORS[key]); fig.text(x + 20, y, label, 12)
    max_pose = max((configs[c]['per_pose'][p]['valid_trials'] for c in CONFIGS for p in POSES), default=1)
    for p_index, pose in enumerate(POSES):
        group_y = p_index * 175
        fig.text(55, 197 + group_y, pose.replace('_', ' ').title(), 15, weight='bold')
        for c_index, c in enumerate(CONFIGS):
            stacked(fig, 208 + group_y + c_index * 35, c,
                    configs[c]['per_pose'][pose]['outcomes'], max_pose, outcomes)
        if p_index < len(POSES) - 1:
            fig.line(55, 330 + group_y, 970, 330 + group_y)
    fig.save(out / '03_per_pose.svg')

    reasons = sorted({reason for c in CONFIGS for reason in configs[c]['rejection_reasons_genuine']})
    reason_height = max(610, 225 + 3 * (len(reasons) * 42 + 30))
    fig = Figure('Genuine trial rejection reasons', data,
                 'Denominator: valid genuine trials per configuration; bars count rejected trials.', reason_height)
    if not reasons:
        fig.text(55, 185, 'No genuine-trial rejection reasons were recorded.', 16)
    else:
        max_count = max(configs[c]['rejection_reasons_genuine'].get(reason, 0) for c in CONFIGS for reason in reasons)
        for i, c in enumerate(CONFIGS):
            for j, reason in enumerate(reasons):
                y = 155 + i * (len(reasons) * 42 + 30) + j * 42
                count = configs[c]['rejection_reasons_genuine'].get(reason, 0)
                fig.text(55, y + 17, f'{c} · {reason}', 13)
                fig.rect(305, y, count / max(max_count, 1) * 570, 23, '#ad4770')
                fig.text(895, y + 17, f"{count}/{configs[c]['valid_genuine_trials']}", 13)
    fig.save(out / '04_rejection_reasons.svg')

    fig = Figure('Physical-attempt latency distributions', data,
                 'Denominator: valid timed physical attempts; each dot is one attempt.', 650)
    fig.text(55, 120, 'Attempt: initiation to finish. Capture: readiness wait plus 25-frame capture.', 13)
    values = data['latency_values_ms']; all_values = values['attempt_ms'] + values['capture_ms']
    if all_values:
        minimum, maximum = min(all_values), max(all_values)
        if minimum == maximum: maximum += 1
        scale = lambda value: 285 + (value - minimum) / (maximum - minimum) * 600
        for tick in range(5):
            x = 285 + tick * 150; fig.line(x, 162, x, 510)
            fig.text(x, 540, f'{minimum + tick * (maximum - minimum) / 4:.0f} ms', 12, anchor='middle')
        for series, y, color in (('attempt_ms', 245, '#216b9a'), ('capture_ms', 400, '#17806d')):
            fig.text(55, y - 52, f"{series.replace('_', ' ').title()}  n={len(values[series])}; median={data['latency'][series]['median_ms']} ms", 15)
            for i, value in enumerate(sorted(values[series])):
                fig.circle(scale(value), y + ((i % 9) - 4) * 7, 4, color)
            if values[series]:
                fig.line(scale(data['latency'][series]['median_ms']), y - 46,
                         scale(data['latency'][series]['median_ms']), y + 48, color)
    else:
        fig.text(55, 210, 'No valid timed physical attempts.', 16)
    fig.save(out / '05_latency.svg')

    fig = Figure('Reference acceptance by configuration', data,
                 'Denominator: valid physical reference attempts per configuration.')
    for tick in range(0, 101, 25):
        x = 265 + tick * 6.1; fig.line(x, 140, x, 455); fig.text(x, 480, f'{tick}%', 12, anchor='middle')
    for i, c in enumerate(CONFIGS):
        rate = configs[c]['reference_acceptance']; y = 180 + i * 95
        fig.text(55, y + 21, c, 15)
        if rate['value'] is not None: fig.rect(265, y, rate['value'] * 610, 29, '#216b9a')
        fig.text(900, y + 21, f"{rate['numerator']}/{rate['denominator']}" +
                 (f" ({rate['value']:.0%})" if rate['value'] is not None else ' (N/A)'), 13)
    fig.save(out / '06_reference_acceptance.svg')


def write_outputs(rows, doc, csv_path, json_path, out):
    out = Path(out)
    require(not out.exists(), f'Output directory already exists: {out}')
    splits = [split for split in SPLITS if any(r['split'] == split for r in rows)]
    results = {split: analysis(rows, doc, split) for split in splits}
    out.mkdir(parents=True)
    aggregate_fields = ('study_id', 'split', 'config_id', 'relation', 'pose_id', 'recorded', 'excluded',
                        'valid', 'signed', 'matched', 'mismatched', 'rejected', 'unavailable_reference',
                        'signature_acceptance_n', 'signature_acceptance_d', 'signature_acceptance_rate',
                        'rejection_n', 'rejection_d', 'rejection_rate',
                        'conditional_match_n', 'conditional_match_d', 'conditional_match_rate',
                        'end_to_end_match_n', 'end_to_end_match_d', 'end_to_end_match_rate',
                        'reference_acceptance_n', 'reference_acceptance_d', 'reference_acceptance_rate',
                        'attempt_latency_n', 'attempt_median_ms', 'capture_latency_n', 'capture_median_ms')
    with (out / 'aggregate_metrics.csv').open('w', newline='', encoding='utf-8') as stream:
        writer = csv.DictWriter(stream, fieldnames=aggregate_fields); writer.writeheader()
        for split in splits:
            for config in CONFIGS:
                for relation in RELATIONS:
                    for pose in ('all',) + POSES:
                        group = [r for r in rows if r['split'] == split and r['config_id'] == config and
                                 r['relation'] == relation and (pose == 'all' or r['pose_id'] == pose)]
                        if pose != 'all' and not group: continue
                        valid = [r for r in group if r['protocol_status'] == 'valid']
                        signed = [r for r in valid if r['signature_produced'] == '1']
                        with_ref = [r for r in valid if r['reference_available'] == '1']
                        matches = sum(r['match'] == '1' for r in valid)
                        accepted = fraction(len(signed), len(valid))
                        rejected = fraction(len(valid) - len(signed), len(valid))
                        conditional = fraction(matches, sum(r['signature_produced'] == '1' for r in with_ref))
                        end_to_end = fraction(matches, len(with_ref))
                        reference = accepted if relation == 'reference' else None
                        attempt_latency = latency(valid, 'attempt_ms')
                        capture_latency = latency(valid, 'capture_ms')
                        writer.writerow({
                            'study_id': doc['study_id'], 'split': split, 'config_id': config,
                            'relation': relation, 'pose_id': pose, 'recorded': len(group),
                            'excluded': len(group) - len(valid), 'valid': len(valid),
                            'signed': len(signed), 'matched': matches,
                            'mismatched': sum(r['match'] == '0' for r in valid),
                            'rejected': len(valid) - len(signed),
                            'unavailable_reference': sum(r['reference_available'] == '0' for r in valid),
                            'signature_acceptance_n': accepted['numerator'],
                            'signature_acceptance_d': accepted['denominator'],
                            'signature_acceptance_rate': accepted['value'],
                            'rejection_n': rejected['numerator'], 'rejection_d': rejected['denominator'],
                            'rejection_rate': rejected['value'],
                            'conditional_match_n': conditional['numerator'],
                            'conditional_match_d': conditional['denominator'],
                            'conditional_match_rate': conditional['value'],
                            'end_to_end_match_n': end_to_end['numerator'],
                            'end_to_end_match_d': end_to_end['denominator'],
                            'end_to_end_match_rate': end_to_end['value'],
                            'reference_acceptance_n': reference['numerator'] if reference else '',
                            'reference_acceptance_d': reference['denominator'] if reference else '',
                            'reference_acceptance_rate': reference['value'] if reference else '',
                            'attempt_latency_n': attempt_latency['count'],
                            'attempt_median_ms': attempt_latency['median_ms'],
                            'capture_latency_n': capture_latency['count'],
                            'capture_median_ms': capture_latency['median_ms']
                        })
    detailed = {'analysis_schema': 1, 'study_id': doc['study_id'], 'source_schema_version': doc['schema_version'],
                'input_sha256': {'csv': hashlib.sha256(Path(csv_path).read_bytes()).hexdigest(),
                                 'json': hashlib.sha256(Path(json_path).read_bytes()).hexdigest()},
                'planned': doc['planned'], 'recorded': doc['recorded'], 'uninitiated': doc['uninitiated'],
                'overrun': doc['overrun'], 'frozen_config_id': doc.get('frozen_config_id'),
                'pilot_source_study_id': doc.get('pilot_source_study_id'),
                'splits': results}
    (out / 'analysis.json').write_text(json.dumps(detailed, indent=2) + '\n', encoding='utf-8')
    report = [f"# GestCrypt study analysis — {doc['study_id']}", '',
              f"Source export schema: v{doc['schema_version']}. CSV and JSON counts, rates, and latency summaries were reconciled before generating outputs.",
              'The output contains no signatures, feature summaries, credentials, or participant IDs.', '']
    for split, data in results.items():
        subdir = out / split; subdir.mkdir()
        draw_figures(data, subdir)
        report.extend([f"## {split.title()} — {data['protocol_label']}", '',
                       f"Physical attempts: {data['physical_attempts']}; planned: {doc['planned'][split]}; "
                       f"excluded: {sum(data['excluded'].values())}; overrun: {doc['overrun'][split]}.", '',
                       '| Configuration | Genuine match | Mismatch | Rejected | Trials without reference (overlapping) | Reference accepted |',
                       '|---|---:|---:|---:|---:|---:|'])
        for config in CONFIGS:
            item = data['configs'][config]; counts = item['outcomes']; ref = item['reference_acceptance']
            report.append(f"| {config} | {counts.get('match',0)} | {counts.get('mismatch',0)} | "
                          f"{counts.get('rejected',0)+counts.get('rejected_no_reference',0)} | "
                          f"{counts.get('rejected_no_reference',0)+counts.get('accepted_no_reference',0)} | "
                          f"{ref['numerator']}/{ref['denominator']} |")
        report.extend(['', 'Match and rejection categories are distinct; a no-reference trial may also have been rejected.',
                       'Rates and their denominators are in aggregate_metrics.csv and analysis.json.',
                       'Six SVG figures are in this split directory. Attempt and capture timing share each physical attempt across configurations.', ''])
        if split == 'pilot':
            report.extend(['Pilot figures are exploratory calibration evidence, not held-out validation.', ''])
    report.extend(['## Limits', '',
                   'No FAR/FRR or population-level reliability estimate is produced. Cross-session reference matching cannot be inferred from fresh-session references.',
                   'The routine exports omit signatures and derived feature measurements, so quantization cannot be recomputed for new margins.',
                   'Schema v1 has no reference-group or retry-predecessor fields; its retry history is not reconstructed.',
                   'capture_ms includes readiness waiting as well as capture. Excluded attempts remain in recorded counts but not valid performance denominators.', ''])
    (out / 'report.md').write_text('\n'.join(report), encoding='utf-8')
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('csv_export', type=Path)
    parser.add_argument('json_summary', type=Path)
    parser.add_argument('--out', type=Path, required=True, help='New output directory; existing paths are refused')
    args = parser.parse_args()
    try:
        rows, doc = load_study(args.csv_export, args.json_summary)
        output = write_outputs(rows, doc, args.csv_export, args.json_summary, args.out)
    except StudyDataError as error:
        parser.exit(2, f'GestCrypt analysis error: {error}\n')
    print(f'Validated {len(rows)//3} physical attempts; wrote {output}')


if __name__ == '__main__':
    main()
