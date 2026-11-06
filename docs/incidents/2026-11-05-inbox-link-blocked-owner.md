---
failure: Linking retained Inbox work stalled all new session requests.
date: 2026-11-05
fix_commits: []
cause_status: confirmed
---

# Inbox request linking blocked the owner

## What was seen

During a backlog of retained Inbox work, session and Inbox requests intermittently waited or
failed while the owner spent 1.3 to 36.5 seconds inside one request-link command. The owner
reported event loop lag and delayed foreground dependencies. The same already-posted answer
identities appeared repeatedly in the logs.

## Cause

Each link searched the entire history of forwarded Inbox posts and extracted the request ID
from each JSON payload, even though the command supplied one exact dispatch request ID. On the
live 9.6 GB ledger this blocked the single owner thread. The router was linking distinct old
dispatches, not retrying one failed link.

## Fix

For an exact dispatch, read its final event through the indexed local and peer request-event
tables, then fetch its forwarded Inbox post by primary key. Startup's bounded historical
reconciliation retains its separate sequence-range path. Cross-thread answer and closure
behavior stays intact.

## Acceptance scenario

- **Seed:** A retained final answer already posted in an Inbox thread, and a second open topic
  request that links the same dispatch after the answer arrived, within a large event ledger.
- **Action:** Link that dispatch to the second topic request.
- **Expected:** The answer appears once in the linked thread, the request can settle, and the
  owner can accept another session request promptly while linking a backlog.
- **Replayable offline:** yes (with a seeded ledger and its exact request events).
