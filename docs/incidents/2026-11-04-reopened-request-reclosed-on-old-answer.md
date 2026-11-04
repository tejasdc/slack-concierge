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

## Cause

The request ledger retained its linked attempts when reopening, but recorded no
boundary between answers already considered and answers for the renewed obligation.
Automatic settlement read the latest completed attempt, even when that attempt had
finished before the reopen.

## Fix

Record the linked-attempt count and time when reopening. Automatic completion must
come from a newly linked attempt made for the reopened work. If prior work is later
found to cover it, the router must explicitly cite a checked answer posted in the
original thread after reopening. Later human replies reopen with their new forwarded
attempt already beyond the recorded boundary.

## Acceptance scenario

- **Seed:** A completed Inbox request has a checked linked answer; reopen it because some of its scope remains unfinished.
- **Action:** Run upkeep before linking or posting any new completion evidence.
- **Expected:** The request remains open and recovery is offered; its old answer cannot automatically close it again. A new linked checked answer can close it, or the router can cite a fresh checked post for the original thread.
- **Replayable offline:** yes (using an isolated owner ledger and a completed request).
