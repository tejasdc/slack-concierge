---
failure: Reading the update status held Concierge's owner for about eight seconds while the disk was busy.
date: 2026-10-13
fix_commits: [da7d71a7]
cause_status: best-explanation
---

# Reading update status held Concierge for eight seconds under disk pressure

## What was seen

During the 2026-10-13 update at 22:42 UTC the accepting owner's loop was held 10.388 s, of which 8.128 s was one
statement reading `deployment_run_events`. Sessions and requests on the owner stalled for that time. A concurrent
Thinkering backup was reading at least 23.5 GB and writing 3.4 GB on the disk behind the ledger.

## Cause

Mechanism confirmed in code: `deploymentWait` in `bot/src/session-owner.ts` and `currentWait` in
`bot/src/update-wait-notices.ts` ran `SELECT MIN(created_at) ... FROM deployment_run_events` on every status or
wait-notice read just to learn when the wait began, although the run row's own `created_at` is identical (the run
and its first `prepared` event are inserted together; all 331 matching runs in the 2026-10-10 offline snapshot
matched). Best explanation for the duration: the scan was slow because of disk contention from the backup. No
per-process I/O sample or lock-holder sample proves which operation held the statement, as the doc states.

## Fix

da7d71a7 replaces both event-table reads with `run.created_at`, removing the slow statement. The loop-lag outcome
of another real update under disk load has not yet been observed. Evidence is recorded in
docs/architecture/LEDGER-DURABILITY.md.

## Acceptance scenario

- **Seed:** A ledger with a `prepared` deployment run and a `deployment_run_events` table made very large or slow
  (or instrumented to count reads).
- **Action:** Call update status and the wait-notice reader.
- **Expected:** `waitingSince` and the notice start equal the run's `created_at`, and no query touches
  `deployment_run_events`; owner loop lag during the call stays well under a second. The real-update loop-lag
  check under disk load remains outstanding.
- **Replayable offline:** yes for the query/timestamp behavior; no for the disk-pressure loop-lag outcome (needs a
  real update with a concurrent bulk disk job)
