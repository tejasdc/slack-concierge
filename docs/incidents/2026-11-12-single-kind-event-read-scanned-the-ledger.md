---
failure: An agent asking for one session's accepted events got no usable answer and an "[object Object]" error, while the same session asked for three kinds answered in half a second.
date: 2026-11-12
fix_commits: []
cause_status: confirmed
---

# A single-kind session event read walked the whole event log

## What was seen

During a sign-in investigation an agent read
`GET /sessions/v1/events?sessionId=concierge:9480&kind=accepted&limit=5` and the command client
threw `[object Object]`. The same session read with `kind=accepted,run,turn_outcome&limit=10`
answered in 496 ms. Reproduced on release 74433e42 at 20:20Z: the single-kind read took
2,560 ms, the three-kind read 11 ms.

## Cause

Two defects, both confirmed from the code and the live timing.

1. **The general filter hid its predicates from SQLite.** The owner's event page wrote every
   filter as `(? IS NULL OR …)` with kinds and runs passed through `json_each`. SQLite cannot use
   the `(session_id, kind)` index for such a predicate, so it walked the event log in sequence
   order and tested every row. Only the exact `accepted,run,turn_outcome` shape the notify
   watcher uses had been given a hand-written direct query, so every other kind list, including a
   single kind, paid the full walk. Under owner load (the same day's restart freezes, see
   `2026-11-12-threads-list-waited-for-worker.md`) the walk could run long enough to fail.
2. **The client lost the refusal text.** The owner refuses as `{error:{code,message}}`; the agent
   command client passed that object to `Error`, which printed `[object Object]`.

This is not the Threads-list cause recorded the same day; that read waited on the presentation
worker, while this one did its own scan.

## Fix

The event page now builds its statement from only the filters given, as direct predicates with
one placeholder per kind or run. Bun's and Python's SQLite both plan every shape through the
`session_owner_events_session_kind` index (or `turns_native_run` for a run filter). The special
three-kind query is gone because the general one now takes the same path. The command client
renders an object refusal as `code: message`.

## Acceptance scenario

- **Seed:** a ledger with many sessions' events, the target session's events far from the log's start.
- **Action:** `GET /sessions/v1/events?sessionId=<that session>&kind=accepted&limit=5` through the
  agent command client; then a request the owner refuses.
- **Expected:** the read answers in tens of milliseconds, as fast as
  `kind=accepted,run,turn_outcome`, with only that session's accepted events; the refusal prints
  `code: message`, never `[object Object]`.
- **Replayable offline:** yes (any ledger copy; `EXPLAIN QUERY PLAN` shows the index seek).
