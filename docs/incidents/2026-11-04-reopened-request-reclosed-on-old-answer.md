---
failure: A reopened Inbox request closed again using the answer that preceded reopening.
date: 2026-11-04
fix_commits: []
cause_status: confirmed
---

# Reopened work closed on its previous answer

## What was seen

The Inbox router reopened Tejas's no-drop request because a Gemini audit was still
unreconciled. About 37 seconds later, Concierge closed the request as completed using
the same earlier continuation that had led to the disputed closure. The later Gemini
repair had not yet happened.

During historical reconciliation, an earlier failed attempt was linked after a later
checked continuation. Its position in the request's list made the completion guard
read it as the current attempt, refusing closure on the later success. A new repair
request was then admitted and correctly kept the broader obligation open.

## Cause

The request ledger retained its linked attempts when reopening, but recorded no
boundary between answers already considered and answers for the renewed obligation.
Automatic settlement read the latest completed attempt, even when that attempt had
finished before the reopen.
The list was also insertion ordered, so linking an older failed attempt after its
successor changed which attempt was considered latest.

## Fix

Record the linked-attempt count and time when reopening. Automatic completion must
come from a newly linked attempt made for the reopened work. If prior work is later
found to cover it, the router must explicitly cite a checked answer posted in the
original thread after reopening. Later human replies reopen with their new forwarded
attempt already beyond the recorded boundary.
Evaluate linked attempts by their recorded admission time. A failed predecessor
cannot block a completed successor; a genuinely new unfinished attempt still does.
For a checked thread post cited after reopening, resolve its thread from the event's
recorded input when the post payload has no explicit thread root. Ordinary router
posts use that input. Apply the admission-time boundary only to requests that were
reopened; an audit may record a request after its completed dispatch was admitted.

## Acceptance scenario

- **Seed:** A completed Inbox request has a checked linked answer; reopen it because some of its scope remains unfinished.
- **Action:** Run upkeep before linking or posting any new completion evidence.
- **Expected:** The request remains open and recovery is offered; its old answer cannot automatically close it again. A new linked checked answer can close it, or the router can cite a fresh checked post for the original thread.
- **Late-link check:** Link an older failed dispatch after a checked successor. The successor remains the latest attempt; a newer running attempt still prevents completion.
- **Replayable offline:** yes (using an isolated owner ledger and a completed request).
