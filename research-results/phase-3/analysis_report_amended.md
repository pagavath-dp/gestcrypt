# GestCrypt pilot analysis — STUDY-1873C987

The paired schema-v1 CSV and JSON exports were validated before analysis. This amended report clarifies an overlapping category; all numerical results are unchanged from the [Phase 2 report](../../analysis-output/pilot-STUDY-1873C987/report.md).

## Exploratory pilot

The export contains 31 physical attempts: 24 genuine trials and 7 reference attempts. The planned count was 24 physical attempts, so the recorded overrun is 7. No attempt was excluded.

| Configuration | Genuine matches | Mismatches | Rejected trials | Trials without reference (overlapping) | Accepted references |
|---|---:|---:|---:|---:|---:|
| Loose | 18 | 3 | 3 | 0 | 7/7 |
| Baseline | 12 | 2 | 10 | 0 | 5/7 |
| Strict | 3 | 0 | 19 | 19 | 1/7 |

“Trials without reference” is **not an additional, disjoint outcome**. Under strict margins, 17 of those 19 trials were rejected and 2 produced a signature; all 19 lacked an accepted reference for comparison. Rejected trials were not counted as mismatches.

The six corrected presentation figures are in [figures](figures/). Detailed numerators, denominators, rates, and latency summaries remain in the validated [aggregate CSV](../../analysis-output/pilot-STUDY-1873C987/aggregate_metrics.csv) and [analysis JSON](../../analysis-output/pilot-STUDY-1873C987/analysis.json).

This is exploratory calibration evidence from one participant and one session. It is not held-out validation, a FAR/FRR estimate, or evidence of identity verification.
