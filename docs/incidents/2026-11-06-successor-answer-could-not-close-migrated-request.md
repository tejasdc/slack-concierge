---
failure: An accepted Inbox successor's answer in the original thread could not close its migrated human request.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# Successor answer could not close migrated request

## What was seen

The human request `req:a358bca7-a0fa-4778-b182-c81be57a4255` remained open after the standing Inbox successor answered its exact thread. Closing with the answer post `post:9bafd003-7fbf-4b9c-9bfc-05835ee77afb` was refused as `REQUEST_COMPLETION_EVIDENCE_REQUIRED`. No answer was replayed and the request was left open.

## Cause

The completion check looked up the successor's post through the shared Inbox lineage and found its thread root. The message projection gave its SQLite time as `YYYY-MM-DD HH:MM:SSZ`; the completion check converted the space to `T` and appended another `Z`. The invalid date failed the later-than-request comparison, so the genuine post was treated as missing evidence.

## Fix

Normalize a space-separated UTC time without adding a second zone suffix. Keep the existing checks for exact post identity, agent authorship, time, thread root and topic.

## Acceptance scenario

- **Seed:** A human request retained in an earlier Inbox session with no linked dispatch, and a current Inbox successor in the same lineage.
- **Action:** The successor posts an answer in the request's exact thread; the router checks the answer and cites that post to close the request.
- **Expected:** The request closes with that post as evidence. A post in another thread is refused; the answer is not posted again.
- **Replayable offline:** yes, with `bun run bot/scripts/legacy-topic-completion-fixture.ts` from the repository root.
