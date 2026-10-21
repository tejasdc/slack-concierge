---
failure: Concierge froze for minutes and grew past 40 GB of memory after restarts because it re-read each agent's whole output on every printed line.
date: 2026-10-07
fix_commits: [fbf63092]
cause_status: confirmed
---

# Concierge froze and grew to over 40 GB of memory after restarts

## What was seen

On the evening of 2026-10-07 the owner process reached 20-44 GB of memory several times (f7f4bf78 counts
six episodes, 8f61c14d three with swap); each froze every reply for minutes and ended with a kill. In the
best-observed episode the main thread was busy from 20:46:43 until it was killed at 21:02 EDT, growing from
~1.1 GB (last `owner_memory` reading) to 44.3 GB plus 68.6 GB swap (systemd peak).

## Cause

Confirmed for the 20:46 episode by CPU profiles taken during the stall, whose top stack was hosted read ->
handle -> `onStdout` -> `parseClaudeCodeOutput` -> `JSON.parse`. In `runClaudeCodeTurn`
(`bot/src/claude-code.ts`) live narration re-split and re-parsed the run's entire accumulated stdout on every
chunk. Runs now lived in execution hosts (4772d731), so after a restart an adopted run's stdout held its
replayed host journal (2-8 MB) and the hosted reader delivered pending frames to `onStdout` in one synchronous
pass: k lines cost k full parses of megabytes without yielding, allocating faster than collection. The
earlier episodes were not individually profiled; this is the best explanation for them.

## Fix

fbf63092: each line is parsed once as it arrives and kept in `streamEvents`; narration reads those parsed
events through the new `claudeOutputFromEvents`, at most once per 250 ms burst, and the final result still
parses the full output once. Related same-day changes that were not the fix: 8f61c14d capped the unit's
memory and 23fe1c7f removed the cap before it was installed (Tejas rejected ceilings); f7f4bf78 added the
per-minute `owner_memory` reading.

## Acceptance scenario

- **Seed:** an execution-host journal of a long Claude run with several MB of stdout; an owner adopting it on
  startup while the host keeps printing lines in bursts.
- **Action:** restart the owner so it adopts the run and replays the journal, then stream a burst of 1,000 lines.
- **Expected:** `JSON.parse` work is linear in bytes printed (each line parsed once); owner RSS stays near its
  baseline; `owner_event_loop_lag` shows no multi-second hold; narration still updates.
- **Replayable offline:** yes (fake provider writing JSON lines through a scratch execution host; no real Claude needed)
