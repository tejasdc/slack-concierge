---
failure: Failed, uncertain and decision-blocked named-thread results did not return to the Inbox router.
date: 2026-11-05
fix_commits: []
cause_status: confirmed
---

# Named-thread failures did not return to the router

## What was seen

The typed work disposition was retained correctly, but the delivery decision treated every
answer with a named Inbox thread as thread-only. Confirmed completion was quiet as intended;
`failed`, `needs_decision`, unclassified work and overdue answers were quiet too. The thread
kept the answer, but the requesting router did not receive the actionable return needed to
recover the route or continue after a decision.

This was the remaining half of Tejas's request to stop waking the Inbox for every ordinary
completion while preserving wakeups when something still depends on the result. The earlier
September rule that returned every settled result solved dropped completion at the cost of one
requester turn per answer. Named-thread custody later removed that cost, but used only the
destination shape and ignored the typed result.

## Cause

The return decision read the result destination but not the retained result. A named thread
therefore made every result quiet, even when its typed disposition required recovery or a
decision. The queue guard repeated that destination-only rule, so a restart could not recover
the missing router wake.

## Fix

A named Inbox thread is sufficient delivery for a confirmed completed work result or a successful
informational answer. Anything that requires another action returns to the requester: failure,
`needs_decision`, an unclassified work final, an overdue answer, cancellation not caused by
Tejas's own Stop, uncertainty, or an explicit hand-back. A request without a named thread returns
every outcome. The exact final event and request result decide; prose never does.

## State card

- **Entity and writer:** one communication request and its ordered events; the Concierge owner is
  the only writer of delivery state.
- **Operation identity:** request ID plus final event ID; retries reuse the existing return input.
- **Acceptance ladder:** retained final event, thread post, actionable requester input, provider
  acknowledgement. Each is recorded separately.
- **Provisional state:** progress stays on the request and wakes nobody. The typed final replaces
  no earlier event and selects its destination.
- **Lifetime:** the owner retries pending delivery across restarts; no new service or timer exists.
- **Old readers:** old completed events remain history and are not replayed. New events use the
  installed owner's rule on server and peer paths.
- **Failure trace:** work fails, the final is retained, the thread receives it, destination-only
  classification marks it received, restart sees no pending return, and the router never acts.
- **Falsifying check:** the release fixture runs the same decision and queue refusal for server and
  peer events. It rejects a requester wake for completed and informational success, and requires
  one for failed, `needs_decision`, unclassified work, informational failure, overdue and hand-back
  events. Tejas's own Stop remains quiet.

The existing return destination decision now reads the retained final event and outcome. The
queue guard uses the same closed classification, so a stale thread-only return cannot bypass the
owner and an actionable return cannot be discarded as ordinary completion. Current contract and
architecture documentation describe the same rule.

## Acceptance scenario

- **Seed:** Create local and peer work requests with a named Inbox thread and final events for
  completed, failed, `needs_decision`, unclassified, overdue, hand-back and Tejas-Stop outcomes.
- **Action:** Run each event through both the live destination decision and the queue refusal.
- **Expected:** Completed work and successful information stay thread-only. Failure, decision,
  uncertainty, overdue and hand-back return exactly once. Tejas's own Stop remains quiet.
- **Replayable offline:** yes, against the release fixture's disposable ledger.
