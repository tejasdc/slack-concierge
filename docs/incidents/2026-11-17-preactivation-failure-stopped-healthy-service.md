---
failure: A failed candidate preparation stopped the working Concierge service, then probed it while stopped for 90 seconds before restarting it.
date: 2026-11-17
fix_commits: []
cause_status: confirmed
---

# A failed update left requests unavailable for two minutes

## What was seen

On November 17 at 19:45 UTC, Concierge closed request admission with nine active
turns. The drain completed at 19:45:33.814, but systemd did not start the service
again until 19:47:07. Request acceptance returned at 19:47:36.611: a 127.135-second
gap. Nine provider executions were adopted on recovery. Their exact result custody
requires separate identity-level reconciliation.

## Cause

The candidate failed preparation before activation. The deployment failure path
nonetheless stopped the still-working last-known-good service, restored its same
release pointer, and ran a 90-second functional probe against the stopped service.
It restarted only after that probe expired. The deployment journal's stop, probe
timeout, and restart ordering matches this source path.

## Fix

On a failure before activation, compare the current and last-known-good release
identities and prove the running service healthy. If both match, leave that service
running while handing the failed candidate to repair. If restoration is necessary,
start the restored service before probing it. Keep admission held if health cannot
be proved. If the repair service refuses to start after its incident is recorded,
the deployment worker retries that exact incident while the run stays releasing.

## Acceptance scenario

- **Seed:** A healthy last-known-good owner serves while a new candidate is being prepared.
- **Action:** Candidate preparation fails before activation.
- **Expected:** The owner is probed and stays serving; no stop, restoration, or restart occurs. When the current release differs from the last-known-good release, the controller stops, restores, starts, then probes in that order. A refused repair-service start retains a runnable repair incident and cannot mark the run failed.
- **Replayable offline:** yes, with the deployment preactivation failure fixture.
