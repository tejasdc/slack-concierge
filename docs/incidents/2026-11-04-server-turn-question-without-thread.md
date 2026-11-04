---
failure: A server agent could declare that it needed Tejas, but a missing Inbox thread left the question outside his Inbox and phone alerts.
date: 2026-11-04
fix_commits: []
cause_status: confirmed
---

# A server agent's question had no Inbox thread

## What was seen

The nightly review found that a server worker's end-of-turn question could be accepted when
the Inbox request had no usable thread address. The worker's own session retained the question,
but the Inbox did not get a question or blocking notification.

## Cause

The outcome command saved the turn before filing it in an Inbox thread. A missing request or
thread returned no result; an exception was logged. Both cases still acknowledged the outcome.
The search for a request also considered older work sent to the same agent, which could choose
the wrong thread.

## Fix

The exact request that delivered the turn is the only source of its thread address. When it
has none, the server creates an Inbox thread containing the agent's exact question and files
one blocking decision there, owned by the asking session. Filing uses the outcome's stable
identity and rolls back a failed thread attempt before trying the fallback. Work without a
Inbox origin continues to use its own session attention. An agent-authored Inbox request is
eligible without pretending it was written by Tejas.
When the request row is missing, the accepted worker input's source and exact source run
still prove which session dispatched it.

## Acceptance scenario

- **Seed:** The Inbox sends a request to a server session without a thread root.
- **Action:** That session declares an end-of-turn question for Tejas.
- **Expected:** One question from that session appears in a new Inbox thread and one blocking
  notification reaches his device. His reply in that thread can target the asking session.
- **Replayable offline:** no (phone delivery requires the installed server and thnkr.ing).

## State card

- **Writer and identity:** The server Concierge ledger owns the turn outcome, Inbox post,
  thread, decision and alert. The accepted outcome action identifies the fallback on retry.
- **Acceptance:** An outcome receipt proves server custody. The Inbox thread and its question
  prove filing. Only the device delivery record or Tejas's observation proves a phone alert.
- **Failure trace:** A request has no thread; the worker declares a question; ordinary filing
  finds no exact request; the fallback creates the thread and decision in the same transaction;
  a repeated action returns the first receipt without another question.
- **Falsifying check:** A marked live request with no thread root must show one decision in the
  Inbox and one blocking notification, with the asking session offered as a reply target.
