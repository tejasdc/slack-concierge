---
failure: A restarted Concierge owner was up with its front door open, but the runner spent the whole time stopping fenced turns one by one and never reached it before the owner was stopped again.
date: 2026-11-05
fix_commits: []
cause_status: confirmed
---

# The runner stopped sixteen fenced turns one at a time instead of reconnecting

## What was seen

The owner instance 68515c7e (release 576bfc4a) started at 09:50:40 UTC, reported
`request_api` completed at 09:53:10 and was sent SIGTERM for the next release at 09:53:45. Its
front door did exist in that window: the foreground gateway answered `/events/stream` requests
(`foreground_owner_dependency_delayed` at 09:53:15) and the Codex observer reached
`requests.sock` and got the relay's 503 (no runner listening) at 09:53:14. The single Codex probe
that saw ENOENT before the drain ran at 09:53:10.685, 8 ms before the gateway reported ready; every
later ENOENT came after the drain closed the listeners at 09:53:45.

Runner ax41 (restarting into the same release) retried `reacquire` every 5 s until 09:53:00, then
logged `runner_turn_fenced` for sixteen turns at 2 s intervals from 09:53:05 to 09:53:43, and made
no owner call in between. The owner's 35 s window passed without runner contact; 19 turns waited
on the runner and the drain ran until systemd's SIGKILL at 09:58:45 (update c1676339 parked,
incident ce2c2192).

At 09:53:51 the runner reached the same owner's `reacquire` route as that owner drained, but
the following job read failed with `ConnectionRefused` and exited the runner. The batching fix
also stops hosts the owner has already settled before any such read, so an exit cannot strand a
host after its held record is deleted.

## Cause

The restart fence ran one blocking `systemctl stop` per stale turn (about 2 s each) before each
reacquire attempt, and all sixteen turns crossed the four-minute fencing time together. The live
fence loop and the stale-on-reacquire stop had the same one-unit-per-call shape.

## Fix

The runner stops every turn fenced at one moment with a single `systemctl stop` naming all their
units (systemd runs the stops together; a unit already gone does not stop the others), fences each
held attempt once per runner process, and stops owner-settled turns after reacquire the same way.

## Acceptance scenario

- **Seed:** a runner holding many turns whose owner contact is older than the fencing time, with
  the owner unreachable.
- **Action:** restart the runner, then bring the owner up.
- **Expected:** one `runner_turn_fenced` per turn within one bounded fencing pass, followed by a
  `reacquire` attempt without a separate blocking stop for each turn.
- **Replayable offline:** partly; `bot/scripts/runner-turn-check.ts` covers restart and
  reacquire with systemd, not the many-turn timing.
