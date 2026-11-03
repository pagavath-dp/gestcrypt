# Held-Out Configuration Decision

**Decision date:** 31 October 2026 (Asia/Kolkata)<br>
**Decision status:** Approved before held-out collection<br>
**Pilot source study:** `STUDY-1873C987`<br>
**Primary held-out study configuration:** `loose`

## Selected parameters

The held-out study's primary evaluation configuration is `loose`, with a **0.02 ratio-unit ambiguity margin** and a **1° spread-angle ambiguity margin**. The study-only quantizer keeps the existing finger-ratio boundaries at **1.30 and 1.70**, thumb-ratio boundaries at **1.15 and 1.60**, spread boundary at **12°**, and variability limits at **0.12 ratio units** and **6°**. Feature definitions and the 25-frame capture summary remain unchanged. This decision selects an evaluation setting; it does **not** change the production gesture quantizer.

## Evidence and rationale

The exploratory pilot recorded one participant in one session, with **24 genuine trials** and **7 reference attempts**. The three configurations were evaluated on the same physical captures. Counts below come from the validated [pilot analysis](../../analysis-output/pilot-STUDY-1873C987/analysis.json) and [aggregate metrics](../../analysis-output/pilot-STUDY-1873C987/aggregate_metrics.csv).

| Pilot metric | Loose 0.02 / 1° | Baseline 0.04 / 2° | Strict 0.06 / 3° |
|---|---:|---:|---:|
| Genuine signature acceptance | 21/24 (87.5%) | 14/24 (58.3%) | 5/24 (20.8%) |
| Genuine rejection | 3/24 (12.5%) | 10/24 (41.7%) | 19/24 (79.2%) |
| Conditional exact match, accepted trial with reference | 18/21 (85.7%) | 12/14 (85.7%) | 3/3 (100%) |
| End-to-end exact match, valid trial with reference | 18/24 (75.0%) | 12/24 (50.0%) | 3/5 (60.0%) |
| Reference acceptance | 7/7 (100%) | 5/7 (71.4%) | 1/7 (14.3%) |

Loose is selected for a **usability-oriented held-out evaluation** because it produced the most accepted genuine captures and available references in this pilot. It also produced **3 accepted mismatches among 21 accepted genuine trials**, so the choice is not based on acceptance alone. Baseline remains a secondary paired comparison because it is the unchanged production setting and rejected more genuine captures while retaining **5/7** references. Strict remains secondary because its **3/3** conditional matches come from only three comparable accepted trials; **19/24** genuine trials were rejected and only **1/7** references was accepted. These outcomes make strict's apparent conditional matching insufficient evidence of practical superiority.

The pilot has no different-pose or second-person trials. Its small, single-session sample cannot establish optimal margins, biometric accuracy, identity verification, liveness, replay protection, or stronger security for loose. GestCrypt v2 file protection uses a passphrase-derived key-encryption key and a random data-encryption key; this gesture-study choice does not change that cryptographic path. See the [pilot limitations](../phase-3/limitations.md) and the approved [held-out collection protocol](heldout_protocol.md).

## Freeze and analysis rule

**No held-out data had been collected when this decision was made.** The approval recorded here is a pre-collection analysis decision, not a claim that the browser recorder has already been frozen. Before the first held-out attempt, the operator must enter pilot source `STUDY-1873C987`, select `loose`, click **Freeze pilot choice**, and verify `frozen_config_id="loose"` and `pilot_source_study_id="STUDY-1873C987"` in the paired JSON. The production margins remain **0.04 ratio units and 2°**.

Report loose as the primary held-out configuration. Baseline and strict may be reported as secondary exploratory comparisons on the same attempts. **Do not use held-out outcomes to change, reselect, or tune the frozen primary configuration.** Any different primary decision would need a documented amendment made before collection begins.
