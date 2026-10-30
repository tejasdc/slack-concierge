---
failure: Marking an Inbox thread read waited up to 9.6 seconds for owner confirmation.
date: 2026-10-30
fix_commits: []
cause_status: best-explanation
---

# Thread read marks and route checks held the owner loop

## What was seen

Thinkering's nightly review measured four thread read actions in the preceding day.
Their screen update p95 was 121 ms, while owner confirmation p95 was 9,626 ms against
a 1,500 ms budget. This confirms a delayed owner response, not its cause.

## Cause

The earlier 8.3-second topic transaction was specifically an agent route on October 29,
not a read mark. Its one slow SQL statement was the prior-route lookup. The recorded
statement fingerprint `b72c284dd6410fea` matches the source SQL exactly. That SQL
used `kind='topic_route'`; SQLite did a full event-ledger scan because the existing
source-message index has the partial predicate `kind IN ('topic_route','session_route')`.
An isolated `EXPLAIN QUERY PLAN` confirmed that the old predicate scans the table
while the exact two-kind predicate seeks the index. The route then filters to topic
routes, keeping the duplicate-destination rule.

The current `read` action in `session-topics.ts` also built the complete topic summary
inside `humanMutation`'s SQLite write transaction only to find the latest conversation
sequence. That work could extend the global Inbox entry index and read questions,
requests, human replies and work across the Inbox. Its unnecessary reconstruction is
a confirmed source defect, but the nightly 9.6-second read wait was not traced to a
specific owner transaction, so its causal share remains unknown.

## Fix

The prior-route query now uses the index's exact two-kind predicate, then considers
only topic routes for the duplicate-destination check.

The screen already supplies the exact last entry sequence it displayed. The owner
now checks that one retained conversation event against the thread's current root
placement and records a monotonic read position. A moved or missing entry yields a
conflict; no future sequence can hide an unseen entry. The existing transaction still
retains the human action, event and receipt atomically.

## State boundary

One Concierge owner orders each Inbox thread's events and writes its read position.
The browser's action ID makes retries return the same receipt. Its immediate read
prediction is provisional; the retained position wins on refresh. A successful
owner receipt proves the action and its event were committed, while the visible
screen update is observed separately. A restart replays the retained event into
the same topic projection; older pages receive the unchanged event shape. If the
response is lost after commit, the same action ID returns the original result.
The falsifying sequence is a route that moves the displayed entry before the
read action arrives: the owner must return a conflict rather than advance the
read position. The moved-entry race remains a contract check, not a reproduced
live event.

## Acceptance scenario

- **Seed:** A marked Inbox capture is placed in one thread, and a second thread exists;
  a real open Thinkering page has a thread summary with an exact last-entry sequence.
- **Action:** Route the marked message to the second thread, then Tejas marks a thread read.
- **Expected:** The route uses an indexed source lookup without a multi-second owner-loop
  lag. The read action returns owner confirmation under 1,500 ms and never advances past
  the exact displayed entry. The next normal nightly window stays within that budget.
- **Replayable offline:** yes (isolated owner and prepared-reader fixture); an agent cannot
  originate Tejas's read action on the installed site without falsely attributing it to him.
