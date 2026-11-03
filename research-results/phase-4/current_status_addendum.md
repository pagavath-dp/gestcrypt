# Held-Out Study: Current Status Addendum

**Addendum date:** 3 November 2026 (Asia/Kolkata)<br>
**Scope:** Latest locally archived checkpoint available to the release audit

The [held-out protocol](heldout_protocol.md) is a dated, approved collection plan, and the [configuration decision](configuration_decision.md) records the primary configuration selected before collection. Their original wording describes the implementation and study status at the time they were written; neither document is a report of completed held-out results.

The latest locally archived checkpoint for `STUDY-9C3BC7C99A3E693B` contains **12 recorded physical attempts out of 32 planned**. It is incomplete and does not establish a completed held-out evaluation. The checkpoint for `STUDY-2261F158` belongs to a separate, earlier interrupted study; its attempts must not be merged with this checkpoint. The exploratory pilot, `STUDY-1873C987`, is a separate calibration dataset and must not be presented as held-out validation.

The current application supports versioned local study snapshots and guarded recovery after a page reload. The original protocol was written before that persistence and recovery behavior was implemented, so its statements that reload necessarily loses in-memory history are historical implementation notes. Local persistence reduces accidental loss in the same browser storage context; it does not replace paired CSV/JSON checkpoint exports or establish that collection is complete.

The active held-out browser profile was not inspected during the release audit. This addendum describes only the locally archived evidence. No missing attempts or outcomes have been fabricated or inferred, and no checkpoint has been merged, repaired, or changed.
