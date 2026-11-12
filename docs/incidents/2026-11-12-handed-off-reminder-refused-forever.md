---
failure: A "no confirmed answer after 15 minutes" reminder whose asking session had been handed off was resent to the successor under the predecessor's identity, refused by the ledger, and retried about three times a minute for five days.
date: 2026-11-12
fix_commits: []
cause_status: best-explanation
---

# Three Nov 7 reminders were refused 6,133 times in one morning

## What was seen

The owner logged `session_communication_failed` with "Idempotency conflict: accepted action payload
changed." about three times a minute, 6,133 times between the morning restart and 19:00 UTC on
2026-11-12. The outside investigation of incident 4b6c9a1f traced two of them to Nov 7 reminders
for Kindle reader requests: each reminder input was accepted for the asking session, that session
was handed off, the successor received its own copy, and Concierge kept re-sending the reminder to
the successor under the original identity. A third (a Twitter daily schedule request) looked
identical to its accepted copy in every field compared; its exact differing field was not found.

## Cause

Reminder delivery called the owner's admit with `request-reminder:<event>` and the request's
current asking session. The handoff had moved the request's asking session to the successor and
copied the queued reminder there as `handoff-input:<handoff>:request-reminder:<event>`, so the
original identity still belonged to the predecessor and every admit was refused. The delivery
event stayed undelivered, so it was retried on every pass. Any other change in the re-admitted
fields (text, source run) fails the same way, which is the best explanation for the third.

## Fix

A reminder is admitted once. Afterwards its delivery is read from the input carrying it now,
following `continuedAs` from the handoff copy, and never admitted again under that identity. A
successor with no copy receives one as `request-reminder:<event>:session:<successor>`; a reminder
withdrawn on purpose is retired with a reason. Both the local and peer request paths use it.

## Acceptance scenario

- **Seed:** a reminder queued on a predecessor, a handoff copy queued on the successor, the
  original cancelled with `continuedAs`; separately, a reminder never queued on a suspended
  predecessor.
- **Action:** deliver the reminder event with the successor as the asking session.
- **Expected:** the first reads as admitted on the successor copy (the old admit is refused); the
  second is admitted on the successor under its own identity, and delivering again changes nothing
  (`bot/scripts/held-release-pacing-fixture.ts`).
- **Replayable offline:** yes
