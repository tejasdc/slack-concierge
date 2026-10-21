---
failure: A message, watch or returned answer sent to a session with scheduled work waited hours behind a firing that was not yet due.
date: 2026-10-09
fix_commits: [1b43fd82]
cause_status: confirmed
---

# Session inputs waited hours behind a not-yet-due scheduled firing

## What was seen

The thread reader's watch fired at 21:25 UTC on October 9 and sat queued behind that session's 03:17 fallback firing.
A returned answer to the nightly review session sat queued for sixteen hours. Any session with a repeating schedule was
effectively shut between firings, because its next firing is always queued.

## Cause

The per-session FIFO rule (`EARLIER_TURN_BLOCKS_SQL` in `bot/src/state.ts`) treated any earlier queued turn as first in
line, including a saved (scheduled or banked) turn that was waiting for its own time. A later input could not be claimed
until that saved turn ran.

## Fix

1b43fd82 changes the predicate so an earlier queued turn blocks only when it is not saved work, or when it was started by
hand (`saved_kind IS NULL OR saved_manual_start=1`). When a saved turn comes due, its lower id still puts it first.
Blocking only until due was rejected because it would put the clock into a SQL fragment shared by four readers.

## Acceptance scenario

- **Seed:** A session with a repeating schedule whose next firing is queued for tomorrow; no running turn.
- **Action:** An agent request (or a watch firing, or a service return) is admitted to that session now.
- **Expected:** The new input is claimed and runs immediately; when the firing's time arrives, the firing is claimed
  ahead of any input admitted after it.
- **Replayable offline:** yes (scratch ledger, fake clock for the queue claim)
