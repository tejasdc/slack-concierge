---
failure: A manual requeue reused an earlier provider attempt and an Inbox turn failed before it could start.
date: 2026-11-19
fix_commits: []
cause_status: confirmed
---

# Manual requeue reused a provider attempt

## What was seen

The 3:57 PM Eastern repair notice reported an event identity conflict. The Inbox
router attempt failed before starting Claude. The ledger retained its prior
admission for attempt 2 and the earlier failure on attempt 7.

## Cause

A standalone requeue script reset the attempt numbers of five errored turns to
zero. The next claim reused an immutable admission identity with a different
payload. The existing conflict guard rejected that write.

## Fix

The ledger refuses updates that decrease a turn's attempt. The refusal aborts
the whole update statement, so a batch cannot partly requeue while resetting an
attempt. Ordinary claims continue increasing the attempt and keep the same
accepted input. This guard adds no replay or repair of historical data.

## Acceptance scenario

- **Seed:** Retain a turn and its first provider admission.
- **Action:** Try to requeue and reset that turn to attempt zero in one update.
- **Expected:** The update is refused and queue state and attempt are preserved.
  A later forward attempt retains its admission alongside the original.
- **Replayable offline:** yes, through the provider admission history fixture.
