---
failure: Each change to an Inbox request made the background Inbox-page preparer read every event in the ledger, which stalled prepared pages for over a minute and slowed Concierge itself right after updates.
date: 2026-11-24
fix_commits: []
cause_status: confirmed
---

# Concierge reported "answering but degrading" for minutes after each update

## What was seen

The work-flow supervisor reopened degradation incident `6ca7d85f-fc81-4bbe-92ba-11262679096d`
three times on 2026-11-24 with `owner_loop_blocked`: 17.2 s of loop blocking in five minutes at
03:58 UTC, 16.3 s at 04:06 and 22.0 s at 05:20. Two followed an update restart by minutes (owner
started 03:53:39 and 05:17:28); the 04:06 one had no restart. The restart at 03:33:57 produced
only 3.4 s. The owner answered its health probe in about 10 ms throughout, with no slow request.

In each episode the presentation worker logged `presentation_worker_batch` lines whose `apply_ms`
was 63,805 / 66,855 / 69,368 ms (03:57–04:06) and 89,523 / 81,006 / 81,105 ms (05:20–05:23),
for batches of 24 to 500 changes; its backlog reached 666. The host's `io_by_owner` samples show
the Concierge unit reading 6–13 GB a minute from disk during those batches, and the unit's cgroup
counted 7.06 million file refaults within seven minutes of the 05:17 restart. Over the same
minutes the owner's `owner_event_loop_lag` lines blamed ordinary indexed statements (the
undelivered-return audit, the Codex process audit, request-topic backfill) taking 0.3–1.9 s each
with low processor time: disk waits for ledger pages that had just been pushed out of memory.

## Cause

Every slow batch contained a change to `inbox_requests` (change-log sequences 8377936–8377944,
8378399 and 8378472–8378473 for the three 05:20 batches; the same match, to the minute, holds
for all twelve batches over 10 s between 03:46 and 05:24 UTC). For each such change the worker
asks which posts answered the request's dispatches:

```sql
SELECT … FROM session_owner_events WHERE kind='post' AND json_extract(payload_json,'$.requestId')=?
```

No index covers that question, so the plan is `SCAN session_owner_events`: all 2.3 million
events of a 19 GB ledger, with their payloads, to find rows among 10,219 posts held by 15 Inbox
sessions. With the ledger in memory that took about 10 s; just after a restart and beside the
nightly restic backup it took 80–90 s and replaced the page cache the owner's own reads rely on.

What is inferred rather than observed: that the owner's blocked loop was caused by this cache
displacement. The evidence is timing (the one restart without an Inbox request change in its
first minutes had a fifth of the blocking; the 04:06 episode had the scan but no restart) and the
refault count; no per-page attribution was taken.

## Fix

The lookup now walks each session's posts through the existing `(session_id, kind)` index and
filters those by request, so it reads posts only. On the live ledger the same question returns in
0.1–0.2 s with the identical candidate set (10,219 posts counted both ways, none without a
session). Both call sites in the presentation worker share one statement
(`bot/src/request-posts-sql.ts`).

Chosen over a new partial index on the request id: that index answers in one seek, but building
it scans the whole event table once on the owner's start, and a schema change schedules the ledger
copy that itself competes for disk. Walking 10,219 index entries costs a tenth of a second today
and needs neither; the index remains the next step if posts grow by orders of magnitude.

Not changed: the owner's own first reads after a restart still come from disk, and the supervisor
has no allowance for the minutes after an update.

## Acceptance scenario

- **Seed:** A ledger with 10,000 non-post events and four posts across three sessions, two of
  them naming request `wanted`.
- **Action:** Run the request-post lookup for `wanted`.
- **Expected:** It returns exactly those two posts in sequence order and its query plan searches
  events through `session_owner_events_session_kind` with no scan of the event table
  (`bot/scripts/storage-observation-check.ts`, part of the build).
- **Replayable offline:** yes
