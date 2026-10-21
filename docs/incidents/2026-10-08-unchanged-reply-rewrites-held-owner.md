---
failure: With nobody using it, Concierge stayed frozen most of the time because it re-saved every waiting reply about once a second and walked whole tables for single-row lookups.
date: 2026-10-08
fix_commits: [85c240c1, 71797a2e]
cause_status: confirmed
---

# Concierge stayed frozen most of the time with nothing in flight

## What was seen

After the Accounts recursion was fixed (b88a4f7e), the owner loop was still held about 75% of the time with
no request in flight. Once the write churn was removed it was still held about 13 s a minute. Pages and
message sends waited behind it.

## Cause

Confirmed by strace and WAL inspection, recorded in the commits.

1. Write churn (85c240c1): the queue coordinator wakes on every execution change (~1/s while turns stream),
   and `deliver()` in `session-communication.ts` rewrote `status`, `error` and `accepted_input_id` on
   `session_communication_events` for every unread return with the same values, one autocommit each.
   strace showed 598 fsyncs on `state.db-wal` in 15 s (~10 ms each, 6 s of the 15), 55 commits a second.
2. Whole-table reads (71797a2e): ~20k page reads a second over 5,800 distinct pages, mapped to full scans of
   communication requests and events, peer requests, events and deliveries, and the sessions table (the
   Inbox-session lookup walked it backwards), for single-row lookups the coordinator and live updates repeat.

## Fix

- 85c240c1: every such UPDATE carries a guard on the values it would change (`AND (status IS NOT ? OR …)`),
  so a pass that learns nothing writes nothing; the legacy-uncertain and status updates got the same guard.
- 71797a2e (`session-schema.ts`): narrow equality and partial indexes for those lookups; plans checked against
  the live schema, unrelated list queries unchanged. (f277858c later kept only the narrow queued-turn index for
  the flow view, since the ledger has no planner statistics.)

## Acceptance scenario

- **Seed:** a ledger with hundreds of unread returns in `held`/`admitted` states and several streaming turns
  producing execution changes every second.
- **Action:** let the coordinator run its delivery passes for one minute.
- **Expected:** zero `session_communication_events` writes when nothing changed (WAL frame count stable),
  single-row lookups use indexes (EXPLAIN QUERY PLAN shows no SCAN of those tables), owner loop lag stays
  under 200 ms.
- **Replayable offline:** yes (scratch ledger copy and synthetic execution-change events)
