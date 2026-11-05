---
failure: A candidate owner lost its runner relay during startup and parked three live Codex turns before failing health.
date: 2026-11-04
fix_commits: []
cause_status: confirmed
---

# Codex runner relay was required before it existed

## What was seen

Candidate `15dbe76b5b2b4c3b50ce8a93db506662c1595a3a` failed provider readiness and was
restored to `314dd7403f2f1d75518815762d7dfeae78a9e229`. Read-only journald records the
runner restart at 20:48:08 EST, three `provider_turn_parked` events at 20:48:30 with
`connect ENOENT /root/.local/state/concierge/requests.sock`, request API readiness at 20:48:30,
and provider readiness failing with `Unexpected server response: 503` at 20:48:31. The runner
reported a closed listen channel at 20:48:28 and next tried at 20:48:33, after the candidate
owner had already exited. The restored owner reported its known-good SHA at 20:49:58.

## Cause

The candidate switched the owner's Codex connections to a runner relay. Startup claimed and
started following surviving Codex turns during recovery, before it opened the request socket and
gateway. The first connections therefore failed with `ENOENT` and those turns were parked as
ambiguous. After opening the gateway, startup sent one Codex readiness request before the runner's
next listen attempt. The gateway correctly answered 503 because it had no runner channel; startup
treated that temporary missing channel as a fatal provider failure. The detached deployment
controller's functional health label was a consequence of this startup failure, not evidence that
the App Server itself failed.

## Fix

Keep claimed Codex turns protected during recovery, but follow them only after the gateway has
started and Codex readiness has reached the runner. While the gateway stays up, retry only its
specific missing-runner-channel 503 for at most 30 seconds. The deployment health probe reads the
installed service's runner setting and checks the same route the owner uses.

This incident CLI committed source and documentation only. The external supervisor owns integration,
restart and runtime proof. No test or review was run under the incident's human policy.

## Acceptance scenario

- **Seed:** An owner configured for a runner relay has live Codex turns to adopt; the runner is
  restarting onto the candidate release and its relay channel has not connected yet.
- **Action:** Start the candidate owner, then let the runner reconnect.
- **Expected:** Recovery preserves the live turn claims without parking them for a missing socket;
  the gateway stays up until the runner channel appears; Codex readiness and the deployed health
  probe both reach the runner's App Server; the same candidate reports its exact runtime SHA.
- **Replayable offline:** yes (with a private owner socket, gateway, runner and App Server stand-in).
