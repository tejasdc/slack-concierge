---
failure: Agents that had ended their turn to wait on another agent or on a watch were reported to their askers as stuck, waking the askers for nothing.
date: 2026-10-08
fix_commits: [3d4b9bfe, 2f96a3da, 14b338e8, d7308ff9]
cause_status: confirmed
---

# Agents waiting on sub-work were reported as stalled

## What was seen

On 2026-10-08 three requests were reported stalled in the same second their worker's own sub-request was
answered, before the return that would wake it had started a turn. Workers waiting on a watch they had
registered were also reported stuck. Each stalled notice woke the asking agent; a wake cost about half a
million tokens (the lab coordinator re-read ~518k tokens per wake). Askers were also told a request was stuck
after its answer had already arrived.

## Cause

Confirmed from the diffs. `request-liveness.ts` judged a worker that ended its turn without a final reply as
stranded unless it had a live outgoing request (`waitingOnLiveRequest`). That check missed (a) a sub-request
answered but whose return was still `recorded`/`admitted` and not yet taken in, and (b) a registered watch
(`watches` in `accepted`/`observing` or with a pending delivery). The stall notice was also queued without
checking at delivery whether the request had since been answered.

## Fix

- 3d4b9bfe: `waitingOnLiveRequest` also counts a sub-request with a final answer not yet taken in; the 15-minute
  overdue check (`session-return-audit.ts`) uses the same rule. (Its batching option was removed by 14b338e8
  before it ran.)
- 2f96a3da: `waitingOnDependency` adds registered watches.
- 14b338e8: a stall notice is checked against its request at delivery and dropped if the request is answered.
- d7308ff9 (review): only dependencies the worker started for this request count, so a worker waiting on
  something unrelated is still reported.

## Acceptance scenario

- **Seed:** request R from A to B; B asked C (request S) and ended its turn; separately B2 registered a watch
  and ended its turn.
- **Action:** C answers S (return recorded, not yet started); the liveness inspection runs; B later answers R
  while a stall notice for R is queued.
- **Expected:** no stalled notice for B or B2; the queued notice for R is dropped once R is answered; a worker
  idle with no dependency of its own is still reported.
- **Replayable offline:** yes (scratch ledger, run the liveness inspection directly)
