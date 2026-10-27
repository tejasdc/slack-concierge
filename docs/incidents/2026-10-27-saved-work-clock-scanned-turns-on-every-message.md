---
failure: Concierge's owner loop blocked for 3–7 seconds every minute while several agents streamed output, delaying every page, message and agent command.
date: 2026-10-27
fix_commits: []
cause_status: confirmed
---

# Saved-work clock scanned the whole turns table on every recorded provider message

## What was seen

Work-flow supervisor incident `b670a2d5-daf8-489f-8a55-151fd6f38575` (first seen 09:44 UTC,
capture `0ff80af196b1da122410`): `owner_loop_blocked`, 16.0 s then 17.5 s of summed owner loop lag
per five minutes, no host pressure episode, no slow or in-flight owner request, prepared
presentation caught up, memory flat. The installed release was main's head (`aae7f3c0`).

The owner's 250 ms loop monitor recorded bursts of three to five blocked ticks of 200–1,165 ms
every 20–45 s. In every tick process CPU matched or exceeded the lag (computing, not waiting on
disk or a lock), the storage counters showed 120–372 ledger transactions and 1,200–4,500
statements per tick, and `in_flight` was empty. The slowest statement named in those ticks was,
most often, the repeating-schedule due query of `advanceRepeatingSchedules` (fingerprint
`da341a64b3ca0168`, 25–32 ms), reached through `prepareSavedWorkForClaims ← pump ← wake`, both
from the execution-change listener and from the communication coordinator's `dispatch` and
`deliver` calling `owner.dispatch`.

Lag per minute tracked recorded provider `message` events per minute almost linearly:

| UTC minute | messages recorded | owner lag |
| --- | ---: | ---: |
| 09:25 | 30 | 0.0 s |
| 09:36 | 101 | 2.4 s |
| 09:39 | 140 | 3.9 s |
| 09:43 | 191 | 4.2 s |
| 09:46 | 192 | 4.7 s |
| 09:50 | 190 | 6.7 s |
| 09:55 | 186 | 4.0 s |

Four sessions (7464, 7468, 7465, 7460) recorded 1,582 messages in the 25 minutes to 10:16 UTC.
The same pattern, at the same per-message cost, appears in the journal on 2026-10-26 03:00 UTC
(43 s of lag in the hour), 15:00–16:00 UTC (50 s) and 2026-10-27 01:00 UTC (21 s), all before the
installed release, and in quiet hours with no agent output the lag is under one second.

## Cause

Confirmed from code, query plans and timing:

1. `recordSessionEvent` (`bot/src/session-inputs.ts`) calls `executionChanged()` after every
   recorded event, including each provider `message` projected by
   `projectSessionProviderMessage`. One Claude or Codex stream event is one recorded message.
2. Every execution change runs the queue listener (`bot/src/index.ts`): `sessionTurnQueue.wake()`
   → `pump()` → `prepareSavedWorkForClaims()` → `advanceRepeatingSchedules()`. The communication
   coordinator also re-dispatches every open request on every execution change (24 at the time)
   and each `owner.dispatch` of an already bound input wakes the queue again, repeating the same
   clock pass (yielding between requests, so this loaded the loop rather than blocking it).
3. The clock's due query selects the latest firing of each repeating schedule with
   `saved_kind='scheduled' AND saved_repeat_ms IS NOT NULL AND saved_root_id IS NOT NULL` and a
   correlated `NOT EXISTS`. `EXPLAIN QUERY PLAN` on the live ledger (read-only connection) reported
   `SCAN latest`: a full scan of the 12,098-row `turns` table, whose rows average about 3 KB of
   text. Warm, from a separate connection, 14.9 ms; inside the busy owner 25–32 ms. Only 897 rows
   are repeating firings and only 14 schedules exist, so the scan read 92% of the table for nothing.
4. 25 ms per message at 100–200 messages a minute is 2.5–5 s of blocked loop a minute; with the
   per-request re-wakes on top, the measured 3–7 s.

Minor contributors left in place: six dropped repeating schedules still match the due query
and each opens a two-statement transaction per pump before returning; a `recoverUnsentSteeredInput`
transaction and a queue pump run per open request per sweep.

## Fix

A partial index for the clock's query, created at startup beside `saved_turn_firing` in
`bot/src/state.ts`:

```sql
CREATE INDEX IF NOT EXISTS turns_repeating_schedule
  ON turns(saved_kind, saved_root_id, saved_sequence)
  WHERE saved_kind='scheduled' AND saved_repeat_ms IS NOT NULL AND saved_root_id IS NOT NULL
```

Measured on a scratch database built from the live `turns` and `sessions` schema with every live
index, 12,098 rows padded to the live average text width, 930 of them repeating firings over 14
roots: the due query went from 18.1 ms (`SCAN latest`) to 2.0 ms (`SEARCH latest USING INDEX
turns_repeating_schedule (saved_kind=? AND saved_root_id>?)`). A `(saved_root_id, saved_sequence)`
partial index with the same `WHERE` was not chosen by the planner (still `SCAN latest`), which is why
`saved_kind` leads. The index is partial on all three predicates of the query, so no query without
them can be routed through it; the saved-work page, firing lookup, exact-turn and queued-order
queries kept their plans in the same measurement.

Not changed, for the owners of those paths: a recorded `message` raising the execution-change
fan-out (queue pump, request sweep, exhausted-Claude recovery) rather than only the event streams
that need to know; the request sweep waking the queue once per open request; dropped repeating
schedules re-entering a transaction on every pump.

## Acceptance scenario

- **Seed:** a ledger with about 12,000 `turns` rows of about 3 KB each, 14 repeating schedules
  with about 900 past firings (six of them dropped), 24 open requests bound to running turns, and
  four running sessions whose provider output is recorded at 150–200 messages a minute.
- **Action:** record messages at that rate for five minutes while the owner's 250 ms loop monitor
  and the storage interval counters run.
- **Expected:** `EXPLAIN QUERY PLAN` of the clock's due query reports `SEARCH latest USING INDEX
  turns_repeating_schedule`; no `owner_event_loop_lag` tick names that query as its slowest
  statement; summed lag over five minutes stays below the supervisor's 15 s rule at that message
  rate, where the unindexed query produced 16–17.5 s.
- **Replayable offline:** yes (scratch ledger with synthetic wide turns rows and a fake provider
  that records messages at a chosen rate; the scan cost scales with row width and count).
