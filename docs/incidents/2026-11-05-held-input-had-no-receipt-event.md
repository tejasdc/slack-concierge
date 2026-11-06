---
failure: A message retained in a paused session never appeared in an already-open page because its receipt change had no owner event.
date: 2026-11-05
fix_commits: []
cause_status: confirmed
---

# A held message stayed absent from an already-open session

## What was seen

A marked public Send to a paused acceptance receiver returned HTTP 202 and the owner retained the exact text, attachment custody and source identity. Exact and prepared receipt reads showed the file. A second browser window opened afterwards rendered the message and attachment, but the browser window that was already open before Send stayed stale without a reload. Its event stream contained only the browser-command settlement and no event naming the accepted input receipt.

## Cause

The owner recorded an `accepted` event only when an input gained a queued turn or joined a live turn. A paused session correctly retained the input without either execution transition, but no separate event represented that durable receipt change. The browser-command event named the command action rather than the resulting conversation operation, so the client correctly did not use it to refresh a receipt.

## Fix

The owner now records a distinct, operation-addressed `receipt` event when a surface input becomes durable without a turn. It commits with the input and does not imply provider admission. Startup records the same deterministic event for still-held surface inputs from an older release that have an explicit queue intent and no receipt-changing event, without inferring custody for ambiguous legacy inputs or releasing or replaying anything.

## Acceptance scenario

- **Seed:** Open a session observer, pause its dedicated receiver, and prepare a marked agent source plus one attachment.
- **Action:** Send the marked input once while the receiver remains paused.
- **Expected:** The owner retains one input and no target turn, emits one `receipt` event naming that input, and the already-open observer refreshes the exact receipt to show the text and attachment without reload or provider execution. Repeating the same action or restarting after deleting only the derived event still yields one event and no second input or turn.
- **Replayable offline:** yes
