---
failure: A settled human command had no session-owner event, so the browser had to poll for confirmation.
date: 2026-11-01
fix_commits: []
cause_status: confirmed
---

# Human command settlement had no event

## What was seen

Thinkering thread actions used a repeated status read every 250 milliseconds to learn when
Concierge had finished a command. The 2026-10-31 nightly window measured 14 reads with
owner-confirmation p95 of 3.55 seconds against a 1.5 second target. That timing has other
unresolved contributors; the missing event is a confirmed contract gap, not a proven cause
of the entire delay.

## Cause

The capture queue retained a terminal command status in its own database. The session owner
did not publish that transition into its retained event stream, so a client could only
discover it by reading the command status again.

## Fix

The capture queue writes a terminal-event outbox entry in the same transaction as settlement.
The command worker publishes the full terminal status and action identity to the session
owner's retained stream, waits for the ledger durability barrier, then acknowledges the
outbox. Retry uses the same event identity and original stream anchor. A missed event can
still be reconciled with the existing command status read. Thinkering's browser owner must
consume the event before its polling behavior changes.

## Acceptance scenario

- **Seed:** Create a marked Inbox thread action with a durable custody receipt and a subscriber to the session-owner event stream.
- **Action:** Settle the action, interrupt publication before the outbox acknowledgement, and resume the publisher.
- **Expected:** Exactly one terminal event appears with the action ID and full terminal status; the outbox is acknowledged after durability; a status read still answers if the subscriber missed the event.
- **Replayable offline:** yes (the focused command-event acceptance runs on scratch state and simulates the lost acknowledgement).
