---
failure: Ordinary release shutdown paused the owner while classifying hosted turns through SQLite after request surfaces closed.
date: 2026-11-06
fix_commits: [feb0c9f3]
cause_status: confirmed
---

# Hosted custody lookup delayed release shutdown

## What was seen

Normal release samples included 2.273 seconds in the hosted-turn lookup on November 7 at 07:46 UTC and 6.043 seconds in the same lookup on November 7 at 05:24 UTC. Request handling was interrupted for 11.199 and 12.557 seconds respectively. The lookup was only part of those intervals.

## Cause

After closing request surfaces, shutdown synchronously asked SQLite which active turns had open hosted executions. The owner could not advance its event loop while that statement waited. The durable execution rows were needed for recovery, but reading them in the shutdown loop was unnecessary once the active dispatch had already loaded its identities.

## Fix

Keep the authoritative execution rows for recovery. During an active dispatch, mirror the open hosted execution identities in memory and update that membership with execution-state transitions. Shutdown reads this mirror to decide which turns still depend on the process. Mac shutdown also rechecks custody before cancelling a turn and when a deferred cancellation callback arrives; an earlier person's Stop remains independent of the release wait.

## Acceptance scenario

- **Seed:** An ordinary managed release with active hosted turns and retained execution rows.
- **Action:** Observe the outgoing owner's drain and the successor's first successful request without manufacturing a restart or replaying input.
- **Expected:** The drain no longer executes the hosted-custody ledger statement. The interruption is measured, active turns are adopted, and exact accepted requests and provider results remain recoverable.
- **Replayable offline:** The source-level parity and cancellation paths can be checked in a disposable ledger. The production interruption requires a natural release.
