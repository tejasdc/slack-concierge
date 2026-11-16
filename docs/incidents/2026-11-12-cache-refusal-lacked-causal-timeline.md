---
failure: Disposable cache backup refusals could not be reviewed against synchronized setup, stopping and foreground evidence.
date: 2026-11-12
fix_commits: []
cause_status: confirmed
---

# Cache trials retained peaks without the interval that caused refusal

## What was seen

Request `38013343-c0e3-4f12-8a74-8263b65c69e8` reported repeated two-second
local-Restic refusals near 65% accounted device activity, with a later lower
iostat interval. Low sampled own bytes and PSI averages did not identify the
source or foreground impact of that activity. Pro critique
`ded2077b-c5d9-4d38-8cca-608260fd37e2` requested synchronized baseline, raw
counters, setup phases, stop/exit/cleanup and protected-service evidence.

## Cause

The report retained first/last samples and peaks, without intermediate raw
intervals, phase boundaries or signal/exit timestamps. Fresh repository setup
was inside the guard, but its overlap could not be distinguished from backup.
Later intervals and process byte peaks were different observations. The runner
also cannot read the private supervisor's durable-response counters, so absent
slow-sync logs cannot fill that evidence gap.

## Fix

A bounded in-memory timeline preserves actual monotonic samples and the guard's
interval calculation, raw physical-device diskstats and PSI, process identities,
phases, stop attempts, wrapper reaping and cleanup. The explicit diagnostic
entrance records one 60-second observer-only baseline, the unchanged guarded
disposable trial, cleanup and a 60-second post-exit interval, then writes a new
private artifact with numeric-only retrospective journal evidence. Missing
foreground latency/acknowledgement age/backlog and attribution/quiescence remain
unknown. Limits, guard decisions, exclusion, custody and production hold remain
unchanged. Live observation requires host archive coordination and never retries
until a preferred result appears.

## Acceptance scenario

- **Seed:** Synthetic samples with zero initial accounted busy time and then
  510 ms additional busy time over 1000 ms; an owned blocked native fixture child;
  a simulated scheduled-backup collision.
- **Action:** Run `bun bot/scripts/cache-admission-diagnostics-fixture.ts --native-collision`.
- **Expected:** Raw samples reproduce a 51% crossing and unchanged refusal. The
  first sample has no interval. Unknown device coverage refuses. Trace loss is
  explicit, snapshots cannot be rewritten through retained references, and an
  admission signal attempt precedes wrapper exit and scratch cleanup while the
  original cache remains exact.
- **Replayable offline:** yes. No real host observation or Restic workload is
  performed by the focused fixture. The separately coordinated live diagnostic
  may legitimately refuse and cannot establish safe production coexistence.
