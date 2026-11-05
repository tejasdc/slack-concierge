---
failure: Every restart of the agents' runner stopped each running agent turn older than four minutes, though the owner had heard from it seconds before.
date: 2026-11-04
fix_commits: []
cause_status: confirmed
---

# Agent turns ended at each Concierge release once runners carried every turn

## What was seen

After every agent turn moved onto runner ax41, each runner restart (each Concierge release through
the remote-box release watcher, and remote-box deploys) logged `runner_turn_fenced` for every held
turn older than the fencing time (silentMs 1650080, 799949, 771920, 324380 at 22:30:37 and
22:43:36 ET), stopped their execution units, and then `runner_reacquired` found the same attempts
live at a new epoch. The owner had never lost them; their agents were already stopped.

## Cause

On startup the runner fences each held turn whose saved `lastContactAtMs` is older than
`RUNNER_FENCE_MS`. That value was written at claim and was meant to be refreshed every half minute
on a successful sync, but the refresh compared against the in-memory last contact, which the same
sync resets every half second, so the condition never held and the saved time stayed at the claim.
Any turn older than four minutes therefore looked silent on restart.

## Fix

The restart fence now takes the later of the attempt's claim (or reacquire) time and the runner's
owner-contact file, which the sync loop writes after every successful sync and which each host
already uses as its own deadline. The broken per-attempt refresh is removed, so runner and hosts
fence on one fact.

## Acceptance scenario

- **Seed:** a turn on a runner whose held attempt records a claim older than the fencing time,
  with the runner's syncs answered by the owner up to the moment it stops.
- **Action:** kill and restart the runner.
- **Expected:** no `runner_turn_fenced`; the runner reacquires the attempt at a new epoch and the
  turn answers a follow-up input (`bot/scripts/runner-turn-check.ts` step 3a).
- **Replayable offline:** yes (needs systemd-run on the machine).
