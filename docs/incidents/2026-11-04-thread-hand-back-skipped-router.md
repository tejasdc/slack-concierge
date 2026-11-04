---
failure: A hand-back posted in a named Inbox thread did not return to the asking router.
date: 2026-11-04
fix_commits: []
cause_status: confirmed
---

# Thread hand-back skipped the router

## What was seen

On November 2, a session handed back Tejas's read-aloud report as too loaded. Its answer appeared in the named thread, but the Inbox router did not receive a runnable return. The request remained without a new worker for about 6.8 hours, until nightly review sent it again.

## Cause

The return rule treated every reply to a named thread as discharged by the thread post, including a final hand-back. The event was marked received before return delivery, and the queued-input guard would have refused an attempted return as a stale duplicate.

## Fix

A final hand-back is an actionable requester return in both local and peer delivery. The thread post remains keyed by its original event, and the requester copy says it is already in the thread. The queued-input guard exempts that specific final event. Progress and ordinary finals retain their thread-only rule.

Requests routed to another session instead of a named Inbox thread keep their separate return rule; this fix covers requests naming an Inbox thread.

## Acceptance scenario

- **Seed:** An Inbox request names a thread and does not opt into a requester return.
- **Action:** The receiving session sends a final failed reply with `--hand-back too-loaded`.
- **Expected:** The hand-back appears once in the thread; the asking router receives one runnable return with the fresh-session instruction and can start a new session. Reconciliation does not suppress or duplicate either delivery.
- **Replayable offline:** yes (request, event and input guard); the full router action also needs a marked live request.
