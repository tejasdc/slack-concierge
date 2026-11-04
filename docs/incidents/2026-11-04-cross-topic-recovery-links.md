---
failure: A completed follow-up in another Inbox topic could not be linked to the human request it served.
date: 2026-11-04
fix_commits: []
cause_status: confirmed
---

# Follow-up work could not return to its original Inbox request

## What was seen

The November 4 historical reconciliation sent follow-up work for five human Inbox
requests. The work ran in a different topic from each request. `topics request link`
refused all five with `DISPATCH_TOPIC_MISMATCH`, leaving the original requests open
without an association to their active attempt. The audit identified requests
`8cb25309`, `8c2d3f09`, `81f4dd8a`, `d7992362`, and `1038485a`.
By the later live ledger read, four had since gained tracked follow-ups or a checked
result. The Gemini rerun request `8cb25309` still showed its older failed closure,
despite the later rerun being delivered in another topic. The initial five-count is
an incident snapshot, not the current count of untracked work.

## Cause

The link command conflated a dispatch's answer destination with the human request
whose work it advances. It also refused the same dispatch in a second topic. A
dispatch can serve several requests, but each human request must retain its own
scope, answer in its thread, and independently checked disposition.

## Fix

The owner now records explicit cross-topic associations, mirrors the retained
answer once to each associated topic, and leaves shared requests open for their
own completion check. A stable dispatch ID and per-topic answer event make
reconciliation safe to repeat. Existing single-topic requests keep their current
answer placement. A shared decision question stays in its original thread until
answered.

## Acceptance scenario

- **Seed:** An open human Inbox request and an answered dispatch in another topic.
- **Action:** Link the existing dispatch to the request, then repeat the link and restart reconciliation.
- **Expected:** The original request's topic shows one copy of the answer. The request stays open until its own scope is checked; no second dispatch or answer appears.
- **Replayable offline:** yes (with a disposable session ledger and two placed topics).
