---
failure: An agent's answer appeared in an older thread named when the work was sent, instead of the thread the request itself had been placed in.
date: 2026-10-10
fix_commits: [851212fc, 18f1345f, 498f7a44, 67d7f8bb, 563b2a08, e14ddb0a]
cause_status: best-explanation
---

# Answers landed in the dispatch's older thread, not the request's own

## What was seen

Best explanation from the commit messages: requests the router placed as their own Inbox thread had their answers (and
reading items) shown under the older thread passed as `--thread` at dispatch, so the visible conversation did not match the
work's thread. The fix reprojects "affected messages" and reconciles completed topic requests, which implies retained
answers were misplaced; no specific capture is cited.

## Cause

Answer placement used the `--thread` captured at dispatch. When `request:<requestId>` was later placed as a topic root,
that placement was not consulted, so answers and their reading items stayed with the older thread
(`docs/contracts/native-inbox.md`, `session-owner-v1.md`).

## Fix

851212fc makes a placed dispatch root own the request and every answer, local and peer, including retained answers, and
backfills only request and attributed answer rows in the prepared reader. 18f1345f refuses linking that dispatch to a
different topic. 498f7a44 records a plain explanation when a reading item is refiled. 67d7f8bb keeps one attention record
when a question moves topics. 563b2a08 reconciles requests placed after their answers arrived at server startup (closing
the request and moving its reading item without a second notification); e14ddb0a bounds that reconciliation.

## Acceptance scenario

- **Seed:** Thread T1 exists; the router dispatches a request with `--thread T1`, then places `request:<id>` as root of
  new thread T2.
- **Action:** The agent posts a partial and a final answer.
- **Expected:** Both appear in T2's conversation under the original request text; the reading item is in T2; T1 shows
  nothing new; restarting the owner moves nothing and notifies nothing.
- **Replayable offline:** yes (scratch ledger)
