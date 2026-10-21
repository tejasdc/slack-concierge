---
failure: Every time Tejas's Inbox was marked read, Concierge froze for about a minute and a half.
date: 2026-10-16
fix_commits: [c6eb9707, 2e538ace]
cause_status: confirmed
---

# Marking the Inbox read froze Concierge for 82-89 seconds

## What was seen

e280a028 (letting routed replies and placed thread replies count as the source of questions Tejas
asked) was installed at 02:39 ET on 2026-10-16. From 02:42 every human "read" action on the Inbox
router session (concierge:3172) ran one CPU-bound transaction of 82-89 s on the owner's event loop,
about every two minutes while the Inbox was open. `owner_event_loop_lag` showed `cpu_ms` about equal
to `lag_ms`, with the slowest frame `action` via `handleRequest`. That was 83 s of loop blocking per
five minutes, and supervisor incident fa772103 reopened as `owner_loop_blocked`. Read actions before
that release took under 0.5 s.

## Cause

e280a028 added a lookup from a message ID to the route event that moved it: `routedMessageFor` in
`bot/src/session-topics.ts`, plus the same inline query in `bot/src/prepared-topic-values.ts`:
`SELECT … FROM session_owner_events WHERE kind IN ('topic_route','session_route') AND (event_id=? OR
json_extract(payload_json,'$.destinationMessageId')=? OR json_extract(payload_json,'$.sourceMessageId')=?)`.
No index serves that OR over JSON fields (there was none on `destinationMessageId`), so each call
scanned the event log. Recomputing questions after a read ran it for every source of every question,
and in `sourcesMatch` for each source again, all synchronously on the owner's loop.

## Fix

c6eb9707 reverted the merge at 02:49 ET as the first move, restoring sub-second reads.
2e538ace re-landed the feature at 03:15 ET with bounded lookups. An ID shaped like a route event is
looked up by `event_id`. A `request:` ID maps to its `session-route:` event ID. Only then does the
lookup try `sourceMessageId` and `destinationMessageId`, each as a separate equality query on a
partial index; `session_owner_events_route_destination` is added in `bot/src/session-schema.ts`
beside the existing source index. The commit states Inbox reads stay well under 1 s.

## Acceptance scenario

- **Seed:** A ledger copy at production size (millions of `session_owner_events`), an Inbox topic
  with several asked and reading questions whose sources include routed messages.
- **Action:** Perform the human "read" action on the Inbox session, repeatedly.
- **Expected:** Each read completes in well under 1 s with no `owner_event_loop_lag` over the
  threshold. The question-source query plans use the event-ID or route partial indexes, not a scan.
- **Replayable offline:** yes (a diagnostic snapshot of the ledger and a scratch owner; time the
  read action and check `EXPLAIN QUERY PLAN`)
