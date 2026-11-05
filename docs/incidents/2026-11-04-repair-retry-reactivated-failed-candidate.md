---
failure: Autonomous update repair restarted Concierge onto a candidate that had already failed to start, twice, instead of its committed repair, causing two more short outages.
date: 2026-11-04
fix_commits: []
cause_status: confirmed
---

# Concierge went down again at 21:01 and 21:05 ET on the same broken update

## What was seen

Update run 79ae201f activated candidate 15dbe76b at 20:48 ET. It failed startup (Codex App Server
readiness 503) and the last-known-good release 314dd740 was restored; repair incident 4f105855
committed 0116beb1 and pushed it to main at 20:59. The repair's retry then built 15dbe76b again
(release 6ca14b9e) and activated it at 21:01, a second ~1.5 min outage, and a third build
(438e293b) at 21:05, restarting Concierge onto it once more. A fourth retry began at 21:05:26;
an operator agent stopped and runtime-masked that one repair instance during its preparation.

## Cause

Confirmed from the ledger and code: `prepareDeploymentRetry` reset the run for a retry but left
its `desired_commit` at the failed candidate. The push of 0116beb1 advanced the target's desired
state but, by design, moves only an active run with no repair state, so run 79ae201f kept
15dbe76b. The controller's retry reads the run's desired commit and rebuilt it. Nothing at
activation refused a commit that had already been activated and failed in the same run.

## Fix

- The retry sets the run's desired commit to the incident's repair commit.
- Activation intent refuses a commit whose most recent activation, in any run, failed (that
  run's incident names it as its failed commit). A failure that
  never reached activation can still retry the same commit.

## Acceptance scenario

- **Seed:** a run whose candidate X was activated and failed, an incident with failed commit X
  and repair commit Y.
- **Action:** the repair supervisor prepares and runs its retry.
- **Expected:** the retry builds Y; an attempt to record activation intent for X in that run is
  refused with a message naming the incident; Concierge is never restarted onto X again.
- **Replayable offline:** yes (scratch ledger).
