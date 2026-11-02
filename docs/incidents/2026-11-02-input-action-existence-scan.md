---
failure: Every client action ID made the input POST admission check scan the retained inputs table, adding 35–90 ms to each request.
date: 2026-11-02
fix_commits: []
cause_status: confirmed
---

# Input action existence check scanned the retained ledger

## What was seen

The 2026-11-02 think-aloud input incident showed 35–90 ms spent in one existence check on each send, even before the separate waiting-return amplification. The repeated statement fingerprint was `df10fed5b6554a59` in `owner_request_slow` records for the input POST route. The admission check runs for every POST with a client action ID.

## Cause

The check combined `scope='surface:thinkering'` and a matching `source_input_id` inside an OR. The table has a unique index on `(scope, action_id)`, but the OR could not seek with it, so SQLite scanned the whole table to answer a one-row existence question. A source-scoped retry had no corresponding index either.

## Fix

Check the ordinary surface action with its existing unique `(scope, action_id)` index. Only when a source ID is supplied and that first lookup misses, check `(source_input_id, action_id)` with a dedicated partial index. Both branches preserve the original duplicate status and source identity semantics.

On an isolated SQLite database using these keys and 200,000 representative rows, the old missing-action check planned a full table scan and averaged 14.406 ms over 100 runs. Each new lookup planned a covering index seek and averaged 0.003 ms over 100 runs. This demonstrates the query shape; production timing still needs a live post after installation.

## Acceptance scenario

- **Seed:** A retained inputs table with many prior rows, an existing ordinary surface action, and an existing source-scoped action.
- **Action:** Inspect the query plan and time repeated ordinary, source-scoped, and missing-action lookups against an isolated copy of the schema with representative rows; then post an ordinary human input after installation.
- **Expected:** Both action lookups seek their indexes; a normal human input makes a small, constant number of database calls, completes well under 100 ms, and causes no owner event-loop lag. Duplicate actions keep their prior HTTP status.
- **Replayable offline:** yes (isolated SQLite database with the same keys and indexes).
