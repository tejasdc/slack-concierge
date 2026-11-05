---
failure: The reply stop hook blocked an agent after its open request had a recorded partial reply backed by an active release watch.
date: 2026-11-05
fix_commits: []
cause_status: confirmed
---

# The agent could not leave a release wait to its watch

## What was seen

On November 5, the agent in session `concierge:8762` sent a partial reply for request `9b083df0` naming active watch `58c62b6b3c03`. Concierge accepted the reply and recorded that the watch belonged to the same agent. The owed-reply Stop hook still blocked the turn twice, asking for a final reply or another partial. The earlier November 4 release-watch repair saw the same failure for request `902b96aa-b77e-4ac1-8f42-59a1f2a9e00e` and watch `9a431f7f1955`; that agent waited for installation in the foreground.

## Cause

Stranded-request recovery already checks whether a specific open request has a live watch or returning child request. The Stop hook's owner query checked only whether the request was still open. It did not consult that shared wake predicate. The predicate also matched only the original watch ID, even though a renewing watch receives a new ID within the same series.

## Fix

The owner excludes a request from the Stop hook's owed list while the shared wake predicate finds its live dependency. The predicate follows the watch series across renewals and still requires that the current watch belong to the worker. An unrelated request without a live dependency remains owed. Inbox filing remains a separate Stop hook obligation.

## Acceptance scenario

- **Seed:** An open request with a recorded partial naming an active watch owned by its worker; another open request has no dependency.
- **Action:** The worker ends its turn and the Stop hook checks both requests. Then the watch renews under a new ID and the hook checks again.
- **Expected:** The watched request does not block either Stop. The unrelated request still blocks. If the watch ends with no active successor or pending delivery, the watched request blocks until answered.
- **Replayable offline:** no (the repository disables agent-run ledger tests; the installed owner and managed hook provide the live acceptance entrance).
