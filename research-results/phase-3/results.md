# Exploratory Pilot Results for GestCrypt Gesture Capture

## Study and analysis method

Study `STUDY-1873C987` recorded one participant in one session. The export contains **31 physical attempts**: **7 reference captures** and **24 genuine same-person, same-pose trials** across fist, open palm, three-finger, and SWAG poses. The recorded plan was 24 physical attempts; the seven references account for the seven-attempt overrun. Each physical attempt yielded one row under each of three evaluation configurations, for 93 CSV rows. These rows are paired outcomes, not 93 independent observations.

All attempts were marked protocol-valid, single-hand, and capture-complete. The exported environment codes were current Chrome, built-in camera, and normal lighting for all 31 attempts. These codes do not specify the browser version, camera model, or measured illumination. There were no different-pose or second-person attempts. The source exports are schema v1; their values were reconciled with the paired summary by the [offline analyzer](../../study_analysis.py). The [validated aggregate CSV](../../analysis-output/pilot-STUDY-1873C987/aggregate_metrics.csv) and [analysis JSON](../../analysis-output/pilot-STUDY-1873C987/analysis.json) are the numerical sources for this report.

The study-only quantizer evaluated each completed 25-frame feature summary under loose (0.02 ratio units, 1°), baseline (0.04, 2°), and strict (0.06, 3°) ambiguity margins. Both reference and trial were reevaluated for each configuration, while feature definitions and variability limits stayed fixed. Baseline is the unchanged production setting. As documented in the [study protocol](../../README.md), these margins are experimental parameters, not calibrated optima. The pilot was exploratory; no held-out results appear here.

## Configuration outcomes

For each configuration, the denominator for signature acceptance and rejection is **24 valid genuine trials**. Conditional match counts exact signature matches among accepted trials with an available reference. End-to-end match counts matches among all valid genuine trials **with an available reference**, including their capture or quantization rejections in its denominator. A trial with no accepted reference is reported separately rather than classified as a mismatch.

| Metric | Loose | Baseline | Strict |
|---|---:|---:|---:|
| Signature acceptance | 21/24 (87.5%) | 14/24 (58.3%) | 5/24 (20.8%) |
| Rejection | 3/24 (12.5%) | 10/24 (41.7%) | 19/24 (79.2%) |
| Conditional match | 18/21 (85.7%) | 12/14 (85.7%) | 3/3 (100%) |
| End-to-end match with reference available | 18/24 (75.0%) | 12/24 (50.0%) | 3/5 (60.0%) |
| Reference acceptance | 7/7 (100%) | 5/7 (71.4%) | 1/7 (14.3%) |

The disjoint trial outcomes were loose: 18 matches, 3 mismatches, 3 rejections; baseline: 12 matches, 2 mismatches, 10 rejections; and strict: 3 matches, 0 mismatches, 19 rejections, and 2 accepted trials without a reference. Strict had **19/24 trials without an accepted reference**; this descriptor overlaps with rejection for 17 trials. Its 3/3 conditional match result is based on only three comparable, accepted trials. The [configuration outcome figure](figures/01_configuration_outcomes.svg) shows disjoint categories; the [rate figure](figures/02_rates.svg) displays each rate's numerator and denominator.

## Results by pose

The following cells are **match / mismatch / rejection**, with all counts drawn from genuine trials. The final column reports strict trials lacking an accepted reference; it overlaps with strict rejections and must not be added to the other columns. Pose sample sizes are six fist, seven open-palm, six three-finger, and five SWAG trials.

| Pose | Trials | Loose | Baseline | Strict | Strict trials without reference (overlapping) |
|---|---:|---:|---:|---:|---:|
| Fist | 6 | 1 / 3 / 2 | 1 / 2 / 3 | 0 / 0 / 5; 1 accepted without reference | 6/6 |
| Open palm | 7 | 6 / 0 / 1 | 4 / 0 / 3 | 0 / 0 / 6; 1 accepted without reference | 7/7 |
| Three-finger | 6 | 6 / 0 / 0 | 3 / 0 / 3 | 0 / 0 / 6 | 6/6 |
| SWAG | 5 | 5 / 0 / 0 | 4 / 0 / 1 | 3 / 0 / 2 | 0/5 |

Fist was the only pose with accepted mismatches in this pilot: 3/6 trials under loose margins and 2/6 under baseline. Three-finger reference attempts were accepted 3/3 under loose margins, 1/3 under baseline, and 0/3 under strict. SWAG references were accepted 2/2, 2/2, and 1/2 respectively. Fist and open-palm references were each accepted 1/1 under loose and baseline but 0/1 under strict. These small counts show pose-specific variation in this session, without establishing a general pose ranking. See the [per-pose figure](figures/03_per_pose.svg) and [reference acceptance figure](figures/06_reference_acceptance.svg).

## Rejection reasons and timing

All recorded genuine-trial rejections carried the `finger_ambiguous` code: **3/24 loose**, **10/24 baseline**, and **19/24 strict**. Reference rejections were **0/7 loose**, **2/7 baseline**, and **6/7 strict**, also coded `finger_ambiguous`. The export does not identify the affected finger or its distance from a quantization boundary. All 31 captures completed, so this pilot provides no observed rate for readiness failure, multi-hand rejection, disappearance, or camera error. The [rejection reason figure](figures/04_rejection_reasons.svg) shows genuine trials; reference rejection appears in the [reference figure](figures/06_reference_acceptance.svg).

Across the **31 valid physical attempts**, both `attempt_ms` and `capture_ms` had a **median of 829 ms** and a recorded range of **805–858 ms**. These are browser timing records, not isolated model-inference measurements. `attempt_ms` runs from study initiation through completion and may include camera startup. `capture_ms` starts after camera initialization but includes waiting for readiness as well as the 25-frame capture. The near-equality of the two measures in this session does not establish a general startup or processing cost. See the [latency distribution figure](figures/05_latency.svg).
