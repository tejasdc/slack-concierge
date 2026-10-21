---
failure: A Concierge update sat waiting for about an hour behind Codex agent turns, and neither Tejas nor the agents it waited for were told.
date: 2026-10-08
fix_commits: [bef5931a, 461c7ca1]
cause_status: confirmed
---

# An update waited an hour behind Codex turns, silently

## What was seen

An update that began draining at 06:46 UTC on 2026-10-08 was held over an hour, three of its four blockers
being lab Codex turns started after it began. One update waited 55 minutes on a Codex turn with no word to
Tejas or to the agent ("I thought like we had like a 15 minute warning … we still need the system, right?").
His fixes waited with it.

## Cause

Confirmed from bef5931a and 582bb103. The update gate waits for every run that would not survive a restart.
Shared-daemon Codex turns already survived restarts, but were still counted as non-survivable because their
machine-wide hooks run with the daemon's environment, which has no per-run helper folder: an update would have
swapped the hooks under a running turn. Meanwhile the runner released the drain gate while waiting, so new
Codex turns kept being admitted and extended the wait. Only Claude background jobs got a "still waiting" prompt.

## Fix

- bef5931a: when a shared Codex turn starts, the coordinator files the installed release's helper folder under
  the Codex conversation id (`hook-pins.ts`, `<state>/hook-pins/codex/<id>`); the managed wrappers (v2) read
  `session_id` from the hook's stdin and run that folder's hook. `execution-survival.ts` counts codex turns as
  survivable only when this machine's installed wrappers are v2, so the Mac keeps waiting until its password
  step installs them.
- 461c7ca1 (`update-wait-notices.ts`): after 15 minutes each run an update waits for gets a steered service
  notice (again at an hour). Its Inbox notice to Tejas was removed the same morning by c8294403 as a duplicate
  of the update line.
- 582bb103 instead held new non-survivable runs during a drain; Tejas overruled it and 64dc5e37 reverted it.

## Acceptance scenario

- **Seed:** server with v2 Codex hook wrappers installed; a shared-daemon Codex turn running; a deployment run
  becomes ready to drain.
- **Action:** the drain evaluates what it must wait for; separately, with v1 wrappers, a Claude-in-service run
  holds the update past 15 minutes.
- **Expected:** with v2 wrappers the Codex turn does not hold the update and its hooks keep resolving to the
  pinned release after activation; in the held case the waited-for run receives one steered notice at 15
  minutes and one at an hour.
- **Replayable offline:** no (needs the shared Codex App Server and a real deployment drain)
