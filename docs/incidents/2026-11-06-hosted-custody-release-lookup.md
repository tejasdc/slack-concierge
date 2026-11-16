---
failure: Ordinary release shutdown paused the owner while classifying hosted turns through SQLite after request surfaces closed.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# Hosted custody lookup delayed release shutdown

## What was seen

Normal release samples included 2.273 seconds in the hosted-turn lookup on November 7 at 07:46 UTC and 6.043 seconds in the same lookup on November 7 at 05:24 UTC. Request handling was interrupted for 11.199 and 12.557 seconds respectively. The lookup was only part of those intervals.

## Cause

After closing request surfaces, shutdown synchronously asked SQLite which active turns had open hosted executions. The owner could not advance its event loop while that statement waited. The durable execution rows were needed for recovery, but reading them in the shutdown loop was unnecessary once the active dispatch had already loaded its identities.

## Fix and acceptance

Keep the authoritative execution rows for recovery. During an active dispatch, mirror the open hosted execution identities in memory and update that membership with execution-state transitions. Shutdown reads this mirror to decide which turns still depend on the process. Mac shutdown also rechecks custody before cancelling a turn and when a deferred cancellation callback arrives; an earlier person's Stop remains independent of the release wait.

An ordinary installed release must show a shorter interruption without the hosted-custody statement in the drain path. Check exact accepted requests, active provider results, and successor adoption before calling the incident resolved. No accepted input is replayed merely to create an acceptance sample.
