# Limitations and Scope of Inference

1. **Sample and setting.** The pilot contains one participant, one session, and 31 physical attempts. All were coded as single-hand captures in current Chrome with a built-in camera and normal lighting. The export does not record precise device specifications, browser version, illumination, or environmental variation. The results cannot establish population-level gesture reliability.

2. **Exploratory status.** This is calibration data, not held-out validation. The three configurations were compared on the same recorded attempts. Any configuration selected from these results must be frozen before a separate held-out session; the held-out outcomes must not be used to revise that choice.

3. **Plan and repeated references.** The planned count was 24 physical attempts, whereas 31 were recorded: 24 genuine trials and **seven additional reference attempts**. Three-finger had three reference captures and SWAG had two. These attempts remain in the record, but the extra references change which candidate may be used by later trials. All schema-v1 `retry_index` fields are 1, so the export cannot establish operator retry intent.

4. **Schema-v1 lineage.** The pilot CSV includes a trial `reference_id` but lacks schema-v2 `reference_group_id` and `retry_of_attempt_id`. Earlier reference candidates are visible, yet formal retry chains and reference groups cannot be reconstructed reliably. The analysis leaves schema-v1 retry counts unavailable rather than fabricating them.

5. **No feature measurements.** Routine exports omit feature medians, standard deviations, boundary distances, signatures, raw landmarks, and frames. This protects participant privacy but prevents independent recomputation under unrecorded margins or diagnosis of which finger caused `finger_ambiguous`. The reported three-configuration outcomes were computed during the study session; the offline pipeline validates their summaries rather than re-running gesture quantization.

6. **No negative or second-person trials.** All 24 trials were genuine same-person, same-pose attempts. There are no different-pose trials or consented second-person attempts. The data do not support a false-accept rate, false-reject rate, impersonation-resistance claim, or other population-level biometric-security estimate. Rejected captures are not mismatches, and no-reference trials are not comparable match decisions.

7. **No cross-session repeatability.** A single session does not test whether the same pose retains its signature across days, cameras, lighting, or natural changes in hand presentation. The current study recorder keeps references in browser memory. A fresh-session reference supports a new within-session comparison, not direct matching against the original pilot reference.

8. **Limited capture-state evidence.** Every recorded pilot attempt completed the 25-frame capture and was marked protocol-valid. This dataset does not quantify readiness failure, multi-hand ambiguity rejection, hand replacement, camera errors, or exclusion handling in real use. Automated tests of those paths are separate evidence and do not substitute for real-camera rates.

9. **Timing interpretation.** `attempt_ms` begins when the study attempt is initiated and can include camera startup. `capture_ms` begins after camera initialization but includes readiness waiting before and during the 25-frame capture process. The **829 ms median across 31 attempts** is not isolated inference or cryptographic processing time, and the range **805–858 ms** describes only this session.

10. **Security separation.** Exact gesture-signature matching is an interaction measurement, not authentication, identity verification, or liveness detection. The pilot does not test replay, guessability, offline key attacks, or v2 passphrase security. GestCrypt v2 does not use the gesture as cryptographic key material; v1 has a distinct legacy gesture-derived path.
