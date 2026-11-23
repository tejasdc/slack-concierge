---
failure: A checked follow-up left its Inbox request open and repeatedly woke the router.
date: 2026-11-22
fix_commits: []
cause_status: confirmed
---

# A checked follow-up left an Inbox request open

## What was seen

The finger-drumming course request had a completed final with a live check in its
thread. The Inbox router could not close the request because an open decision still
blocked it. The thread showed no decision waiting on Tejas. Upkeep kept reporting
unverified work and a reply waiting to be processed.

## Cause

The decision belonged to the earlier dispatch. Tejas replied to its post, and
the reply went to the worker on a new dispatch linked to the same request.
The new final could expire questions from its own dispatch only. The earlier
decision stopped appearing in Needs you because it had a reply, but it still
blocked request closure. Upkeep turned that particular refusal into a generic
message about missing verification.

## Fix

The request closure check can use the retained checked final of a linked continuation
and the exact human reply it carried to record the earlier decision answered.
Concierge writes the decision evidence and closes the request in the same event,
for both explicit closure and upkeep. A decision that still blocks closure is named
in the recovery message.

## Acceptance scenario

- **Seed:** A linked work dispatch asked a decision. The human replied to its specific post and the reply was forwarded as a new dispatch.
- **Action:** Record a checked completed final on the forwarded dispatch, then run explicit closure or upkeep.
- **Expected:** The original decision records its human reply and final event, the request closes completed, and upkeep emits no recovery for it. A generic thread reply or an unchecked final leaves the decision open.
- **Replayable offline:** yes, the legacy topic completion fixture exercises both closure paths with disposable storage.
