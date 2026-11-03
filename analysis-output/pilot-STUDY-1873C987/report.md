# GestCrypt study analysis — STUDY-1873C987

Source export schema: v1. CSV and JSON counts, rates, and latency summaries were reconciled before generating outputs.
The output contains no signatures, feature summaries, credentials, or participant IDs.

## Pilot — exploratory pilot

Physical attempts: 31; planned: 24; excluded: 0; overrun: 7.

| Configuration | Genuine match | Mismatch | Rejected | No reference | Reference accepted |
|---|---:|---:|---:|---:|---:|
| loose | 18 | 3 | 3 | 0 | 7/7 |
| baseline | 12 | 2 | 10 | 0 | 5/7 |
| strict | 3 | 0 | 19 | 19 | 1/7 |

Match and rejection categories are distinct; a no-reference trial may also have been rejected.
Rates and their denominators are in aggregate_metrics.csv and analysis.json.
Six SVG figures are in this split directory. Attempt and capture timing share each physical attempt across configurations.

Pilot figures are exploratory calibration evidence, not held-out validation.

## Limits

No FAR/FRR or population-level reliability estimate is produced. Cross-session reference matching cannot be inferred from fresh-session references.
The routine exports omit signatures and derived feature measurements, so quantization cannot be recomputed for new margins.
Schema v1 has no reference-group or retry-predecessor fields; its retry history is not reconstructed.
capture_ms includes readiness waiting as well as capture. Excluded attempts remain in recorded counts but not valid performance denominators.
