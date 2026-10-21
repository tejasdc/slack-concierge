---
failure: A Concierge update failed when its presentation check hit a 90-second limit under disk contention, and the failed release kept no evidence of where the check stopped.
date: 2026-10-12
fix_commits: [61ea2e21, b2d36250, 719f5ac2]
cause_status: confirmed
---

# A candidate check timed out with nothing recorded

## What was seen

On October 12 a release's presentation candidate check timed out at its 90-second guard; the installed controller kept
only stderr, which held no progress, so the failed release had no record of where it stopped. The same candidate passed
in 52 seconds under load on a retry; successful preparation normally took about 47 seconds.

## Cause

`bot/scripts/presentation-release-check.ts` wrote nothing to stderr while running, and `deployment-application-check.ts`
/ `deployment-release.ts` retained neither stdout nor the exit status or signal. The 90-second guard left little margin over
a 47-second normal run on a contended disk.

## Fix

61ea2e21 writes bounded phase and reader markers to stderr, which older controllers already retain. b2d36250 sets a
180-second guard in preparation and preactivation and retains exit or signal, timeout and both stream tails in release and
deploy failure records. 719f5ac2 reconciles the deployment runbook across the installation boundary.

## Acceptance scenario

- **Seed:** A candidate whose presentation check is forced to stall in a known phase.
- **Action:** Run preparation with the installed controller.
- **Expected:** The failure record shows the timeout, the signal, the last phase marker and both stream tails; a normal
  candidate under moderate disk load passes within 180 s.
- **Replayable offline:** yes for the record contents; timing under contention needs a loaded host
