---
failure: Stale Kindle questions returned from a Mac worker could not leave Needs attention.
date: 2026-11-03
fix_commits: []
cause_status: confirmed
---

# Returned Kindle questions stayed open after the task moved on

## What was seen

Two returned Mac requests told Tejas to exit KOReader and reconnect the Kindle's
USB cable. Later, he opened KOReader and agents reached the Kindle over Wi-Fi,
so the old requests were superseded. The receiving session still showed both
questions in Needs attention. Its withdrawal command refused their exact event IDs.
The agent report is
`capture:f5be102d1e5f753c293f7295af654cc11569d4c46ced511e970d8aee153bf55b`.

## Cause

The owner creates a `needs_you` event when a worker returns a decision to its
requester, but withdrawal accepted only a turn's direct outcome event. It
rejected the returned event even while that exact question was still open.

## Fix

The receiving session can withdraw an exact, still-open returned decision.
The owner checks its event identity, target session, return input and returned
decision marker, keeps the original event in history, and records the reason.

## Acceptance scenario

- **Seed:** A requester session has an open returned Kindle decision, then the Kindle becomes reachable and a later request replaces that step.
- **Action:** The requester withdraws the returned decision by its exact event ID.
- **Expected:** Only that question leaves Needs attention, the original return remains in history, and a second withdrawal of the same open identity is refused.
- **Replayable offline:** yes (the owner checks the retained return and open attention identity).
