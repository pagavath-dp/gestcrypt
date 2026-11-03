import csv
import json
import tempfile
import unittest
from pathlib import Path

from study_analysis import (BASE_FIELDS, CONFIGS, CONFIG_PARAMETERS, V2_FIELDS, StudyDataError, analysis,
                            load_study, source_summary, write_outputs)


def fixture(schema=1):
    common = dict(study_id='STUDY-TEST', app_version=f'gestcrypt-m3-eval-{schema}',
                  participant_id='P01', session_id='S01', split='pilot', pose_id='fist',
                  relation='genuine', scene_condition='single', observed_hands='one',
                  capture_outcome='complete', quantization_outcome='accepted',
                  comparison_status='match', rejection_code='', reference_available='1',
                  signature_produced='1', match='1', attempt_ms='100', capture_ms='80',
                  retry_index='1', browser_code='chrome_current', camera_code='built_in',
                  lighting_code='normal', protocol_status='valid')
    attempts = []
    ref = dict(common, attempt_id='A0001', role='reference', reference_id='A0001',
               relation='reference', reference_available='', match='', comparison_status='reference')
    trial = dict(common, attempt_id='A0002', role='trial', reference_id='A0001')
    excluded = dict(common, attempt_id='A0003', role='trial', reference_id='A0001',
                    capture_outcome='state_reject', quantization_outcome='not_run',
                    comparison_status='not_evaluated', rejection_code='protocol_invalid',
                    signature_produced='0', match='', protocol_status='protocol_invalid')
    if schema == 2:
        for item in (ref, trial, excluded):
            item['reference_group_id'] = 'A0001'
            item['retry_of_attempt_id'] = ''
        excluded['retry_index'] = '2'
        excluded['retry_of_attempt_id'] = 'A0002'
    for base in (ref, trial, excluded):
        for config in CONFIGS:
            row = dict(base, config_id=config)
            if config == 'strict' and base['role'] == 'reference':
                row.update(quantization_outcome='rejected', signature_produced='0',
                           rejection_code='finger_ambiguous')
            if config == 'strict' and base['attempt_id'] == 'A0002':
                row.update(reference_available='0', comparison_status='no_reference_for_config',
                           match='')
            if base['attempt_id'] == 'A0003' and config == 'strict':
                row.update(reference_available='0', comparison_status='not_evaluated')
            attempts.append(row)
    summary = source_summary(attempts, schema)
    doc = dict(schema_version=schema, app_version=common['app_version'], study_id=common['study_id'],
               configs=[{'id': c, 'ratioMargin': margins[0], 'angleMargin': margins[1]}
                        for c, margins in zip(CONFIGS, CONFIG_PARAMETERS)], planned={'pilot': 2, 'heldout': 0},
               uninitiated={'pilot': 0, 'heldout': 0},
               overrun={'pilot': 1, 'heldout': 0}, frozen_config_id=None)
    doc.update(summary)
    if schema == 2:
        doc.update(planned_unit='physical_attempts', pilot_source_study_id=None)
    return attempts, doc


class StudyAnalysisTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def pair(self, rows, doc):
        csv_path, json_path = self.root / 'study.csv', self.root / 'study.json'
        fields = BASE_FIELDS if doc['schema_version'] == 1 else V2_FIELDS
        with csv_path.open('w', newline='', encoding='utf-8') as stream:
            writer = csv.DictWriter(stream, fieldnames=fields)
            writer.writeheader()
            writer.writerows(rows)
        json_path.write_text(json.dumps(doc), encoding='utf-8')
        return csv_path, json_path

    def test_schema_v1_missing_reference_exclusion_and_zero_denominator(self):
        rows, doc = fixture(1)
        csv_path, json_path = self.pair(rows, doc)
        parsed, _ = load_study(csv_path, json_path)
        result = analysis(parsed, doc, 'pilot')
        self.assertIsNone(result['retry_counts'])
        self.assertEqual(result['physical_attempts'], 3)
        self.assertEqual(result['excluded'], {'protocol_invalid': 1})
        self.assertEqual(result['configs']['baseline']['signature_acceptance'],
                         {'numerator': 1, 'denominator': 1, 'value': 1})
        self.assertEqual(result['configs']['strict']['outcomes'], {'accepted_no_reference': 1})
        self.assertEqual(result['configs']['strict']['conditional_match']['denominator'], 0)
        self.assertIsNone(result['configs']['strict']['conditional_match']['value'])
        self.assertEqual(result['configs']['baseline']['reference_acceptance']['denominator'], 1)
        self.assertEqual(result['latency']['attempt_ms']['count'], 2)

    def test_schema_v2_retry_links_and_figure_data(self):
        rows, doc = fixture(2)
        csv_path, json_path = self.pair(rows, doc)
        parsed, _ = load_study(csv_path, json_path)
        result = analysis(parsed, doc, 'pilot')
        self.assertEqual(result['retry_counts'],
                         {'initiated_retries': 1, 'reference_retries': 0, 'trial_retries': 1})
        self.assertEqual(result['configs']['baseline']['per_pose']['fist']['outcomes'], {'match': 1})
        self.assertEqual(result['configs']['strict']['reference_acceptance'],
                         {'numerator': 0, 'denominator': 1, 'value': 0})
        output = write_outputs(parsed, doc, csv_path, json_path, self.root / 'output')
        with (output / 'aggregate_metrics.csv').open(newline='', encoding='utf-8') as stream:
            aggregate = list(csv.DictReader(stream))
        baseline = next(r for r in aggregate if (r['split'], r['config_id'], r['relation'], r['pose_id']) ==
                        ('pilot', 'baseline', 'genuine', 'all'))
        self.assertEqual((baseline['signature_acceptance_n'], baseline['signature_acceptance_d'],
                          baseline['signature_acceptance_rate']), ('1', '1', '1.0'))
        self.assertEqual((baseline['conditional_match_n'], baseline['conditional_match_d'],
                          baseline['conditional_match_rate']), ('1', '1', '1.0'))
        strict = next(r for r in aggregate if (r['split'], r['config_id'], r['relation'], r['pose_id']) ==
                      ('pilot', 'strict', 'genuine', 'all'))
        self.assertEqual((strict['end_to_end_match_n'], strict['end_to_end_match_d'],
                          strict['end_to_end_match_rate']), ('0', '0', ''))
        self.assertEqual(json.loads((output / 'analysis.json').read_text())['splits']['pilot']['reference_groups'], 1)
        figures = sorted((output / 'pilot').glob('*.svg'))
        self.assertEqual(len(figures), 6)
        self.assertFalse((output / 'heldout').exists())
        self.assertIn('Trials without reference (overlapping)', (output / 'report.md').read_text())
        per_pose = (output / 'pilot' / '03_per_pose.svg').read_text()
        self.assertIn('viewBox="0 0 1050 975"', per_pose)
        self.assertIn('<line x1="55" y1="330" x2="970" y2="330"', per_pose)
        for figure in figures:
            body = figure.read_text()
            self.assertIn('STUDY-TEST', body)
            self.assertIn('PILOT', body)
            self.assertIn('Denominator:', body)
        self.assertIn('1/1', (output / 'pilot' / '02_rates.svg').read_text())
        self.assertIn('0/0 (N/A)', (output / 'pilot' / '02_rates.svg').read_text())
        for path in output.rglob('*'):
            if path.is_file():
                self.assertNotIn('P01', path.read_text())
                self.assertNotIn('GC1:', path.read_text())
        with self.assertRaisesRegex(StudyDataError, 'already exists'):
            write_outputs(parsed, doc, csv_path, json_path, output)

    def test_invalid_pair_and_duplicate_are_rejected(self):
        rows, doc = fixture(1)
        doc['metrics']['pilot']['baseline']['genuine']['signature_acceptance']['numerator'] = 0
        paths = self.pair(rows, doc)
        with self.assertRaisesRegex(StudyDataError, 'CSV/JSON mismatch'):
            load_study(*paths)
        rows, doc = fixture(1)
        rows.append(dict(rows[0]))
        paths = self.pair(rows, doc)
        with self.assertRaisesRegex(StudyDataError, 'duplicate study/attempt/configuration'):
            load_study(*paths)

    def test_pairing_schema_protocol_and_retry_errors_are_clear(self):
        rows, doc = fixture(2)
        rows.pop()
        with self.assertRaisesRegex(StudyDataError, 'exactly one row'):
            load_study(*self.pair(rows, doc))
        rows, doc = fixture(2)
        rows[0]['protocol_status'] = 'surprise'
        with self.assertRaisesRegex(StudyDataError, 'invalid protocol_status'):
            load_study(*self.pair(rows, doc))
        rows, doc = fixture(2)
        rows[-1]['retry_of_attempt_id'] = 'A0001'
        with self.assertRaisesRegex(StudyDataError, 'physical-attempt fields differ|retry link'):
            load_study(*self.pair(rows, doc))
        rows, doc = fixture(2)
        doc['schema_version'] = 3
        with self.assertRaisesRegex(StudyDataError, 'schema_version'):
            load_study(*self.pair(rows, doc))
        rows, doc = fixture(2)
        doc['planned'] = None
        with self.assertRaisesRegex(StudyDataError, 'JSON planned must be an object'):
            load_study(*self.pair(rows, doc))
        rows, doc = fixture(2)
        for row in rows:
            if row['attempt_id'] == 'A0003':
                row['reference_id'] = 'A9999'
        with self.assertRaisesRegex(StudyDataError, 'reference_id does not link'):
            load_study(*self.pair(rows, doc))

    def test_rejected_attempt_is_not_a_mismatch(self):
        rows, doc = fixture(1)
        for row in rows:
            if row['attempt_id'] == 'A0002' and row['config_id'] == 'baseline':
                row.update(quantization_outcome='rejected', signature_produced='0',
                           comparison_status='not_evaluated', rejection_code='finger_ambiguous', match='')
        doc.update(source_summary(rows, 1))
        parsed, _ = load_study(*self.pair(rows, doc))
        result = analysis(parsed, doc, 'pilot')['configs']['baseline']
        self.assertEqual(result['outcomes'], {'rejected': 1})
        self.assertEqual(result['conditional_match']['denominator'], 0)
        self.assertEqual(result['end_to_end_match']['denominator'], 1)
        self.assertEqual(result['end_to_end_match']['numerator'], 0)

    def test_pilot_and_heldout_figures_are_separate(self):
        rows, doc = fixture(2)
        for config in CONFIGS:
            reference = dict(rows[0], attempt_id='A0004', session_id='S02', split='heldout',
                             reference_id='A0004', reference_group_id='A0004', config_id=config)
            rows.append(reference)
        doc.update(source_summary(rows, 2))
        doc['planned']['heldout'] = 1
        doc['frozen_config_id'] = 'baseline'
        paths = self.pair(rows, doc)
        parsed, _ = load_study(*paths)
        output = write_outputs(parsed, doc, *paths, self.root / 'separate')
        self.assertEqual(len(list((output / 'pilot').glob('*.svg'))), 6)
        self.assertEqual(len(list((output / 'heldout').glob('*.svg'))), 6)
        self.assertIn('exploratory pilot', (output / 'pilot' / '01_configuration_outcomes.svg').read_text())
        self.assertIn('held-out evaluation', (output / 'heldout' / '01_configuration_outcomes.svg').read_text())
        self.assertEqual(len(list(output.glob('*.svg'))), 0)

    def test_missing_capture_latency_keeps_figure_valid(self):
        rows, doc = fixture(1)
        for row in rows:
            row['capture_ms'] = ''
        doc.update(source_summary(rows, 1))
        paths = self.pair(rows, doc)
        parsed, _ = load_study(*paths)
        output = write_outputs(parsed, doc, *paths, self.root / 'no-capture-times')
        figure = (output / 'pilot' / '05_latency.svg').read_text()
        self.assertIn('Capture Ms  n=0', figure)
        self.assertNotIn('None ms</text>\n<line', figure)

    def test_excluded_reference_uses_not_evaluated_without_match(self):
        rows, doc = fixture(2)
        for row in rows:
            if row['attempt_id'] == 'A0001':
                row.update(protocol_status='protocol_invalid', quantization_outcome='not_run',
                           comparison_status='not_evaluated', rejection_code='protocol_invalid',
                           signature_produced='0')
            elif row['attempt_id'] == 'A0002':
                row.update(reference_available='0', comparison_status='no_reference_for_config', match='')
        doc.update(source_summary(rows, 2))
        parsed, _ = load_study(*self.pair(rows, doc))
        result = analysis(parsed, doc, 'pilot')
        self.assertEqual(result['excluded']['protocol_invalid'], 2)
        self.assertEqual(result['configs']['baseline']['reference_acceptance']['denominator'], 0)
        self.assertEqual(result['configs']['baseline']['outcomes'], {'accepted_no_reference': 1})


if __name__ == '__main__':
    unittest.main()
