---
failure: A repeating schedule whose session was suspended logged a failure every minute trying to place its next firing.
date: 2026-10-10
fix_commits: [afec4d54]
cause_status: confirmed
---

# A suspended repeating schedule logged a failure every minute

## What was seen

The logs repeated the same failure once a minute for a repeating saved-work schedule whose session had been suspended. No
work was lost; the noise hid other signals and meant the queue retried a doomed operation on every tick.

## Cause

Recurrence advancement in `bot/src/saved-work.ts` selects a repeating root's latest firing and places the next one once that
firing is due or has left the queue. A suspended (or archived) session cannot accept a new queue entry, and the enqueue
step refuses it. But the selection query still returned the firing while it sat queued for the suspended session, so every
queue tick attempted the placement, was refused, and logged. The query and the enqueue disagreed about whether the session
was available.

## Fix

afec4d54 adds a session-availability condition to the selection: a firing whose status is still `queued` is considered only
if its session is not archived and not suspended (`native_metadata_json.suspended`). The held firing is retained untouched so
an explicit resume makes it eligible again, and ordinary queue admission is unchanged. AGENTS.md was updated: a suspended
session keeps its queued firing without creating successors; drop, archive or suspend stops successors after a firing leaves
the queue.

## Acceptance scenario

- **Seed:** A repeating schedule with a queued firing in a session marked suspended.
- **Action:** Run the saved-work recurrence pass across several simulated minutes.
- **Expected:** No successor is placed, no enqueue refusal or failure is logged, and the queued firing is still present.
  After the session is resumed the same firing becomes eligible and the next one is placed normally.
- **Replayable offline:** yes (ledger rows and the recurrence function with a fake clock)
