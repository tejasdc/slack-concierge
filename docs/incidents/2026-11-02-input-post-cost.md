---
failure: Posting one human session message held the owner loop for about a second.
date: 2026-11-02
fix_commits: []
cause_status: best-explanation
---

# Human input admission repeated thread resolution

## What was seen

In release `8e3135ca…`, the owner log at 22:00:30.363 UTC recorded a 202 response for
`POST /sessions/v1/sessions/:id/inputs` after 866 ms, 2,041 database calls and 3,777,020
result bytes. The corresponding loop-lag line at 22:00:30.364 UTC recorded 812 ms of lag.
The next post at 22:00:37.667 UTC took 821 ms and the same 2,041 calls. Across 41 posts,
the call count stayed at about 2,041 until 22:03:24 UTC, then jumped to about 2,212
from 22:03:36 UTC onward; result bytes rose from about 3.78 to 4.11 MB. These are two
stable read sizes, consistent with two existing reply chains. The requests reported zero
awaited time. The slowest statement,
fingerprint `df10fed5b6554a59`, was the owner-wide duplicate-action query in the
request handler; its disjunction prevented an efficient lookup by the unique
`(scope, action_id)` key and took 51–54 ms in those two posts.

## Cause

The input path resolved the addressed Inbox message's root directly and then did it again
when clearing attention or reopening the thread. Direct resolution follows retained reply
parents, reading each ancestor. The topic system already maintains a root memo, invalidated
when thread links move, while the separate presentation worker materializes exact message roots.
Admission bypassed the memo; the memo itself did not consult the prepared root. Repeated
ancestor reads are the current best explanation for the large, stable call count. The logs
do not break the calls down by helper, so the installed before/after result is the causal check.

## Fix

Admission and attention clearing now share the topic system's root memo. On a cold lookup,
the memo reads the prepared root when its worker has applied the latest thread link; a missing
or lagging prepared record falls back to retained-ledger resolution. The duplicate-action
status check seeks the exact surface scope by its unique key; an agent source identity is
checked separately when present. Neither changes accepted-message identity, routing, or
retry custody.

## Acceptance scenario

- **Seed:** A production-sized Inbox conversation with long retained reply chains and a
  prepared message projection, plus a current human session input.
- **Action:** Post one addressed input through the normal Thinkering entrance.
- **Expected:** The installed owner's completed-request log records a small constant database
  call count, less than 100 ms, and no related owner-loop lag; the input retains its exact
  thread and return target.
- **Replayable offline:** yes, using an isolated ledger with a long reply chain and prepared
  projection. The latency claim still requires a production observation.

After installation, post one marked input through the production surface and inspect its
`owner_request_completed` record. Confirm a small database-call count, less than 100 ms of
owner time, and no associated `owner_event_loop_lag`. A source check alone does not establish
that the installed owner meets those numbers.
