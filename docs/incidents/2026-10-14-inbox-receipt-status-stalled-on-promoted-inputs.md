---
failure: After waiting Inbox messages were moved into the router's running turn, the status shown under every Inbox message stopped updating.
date: 2026-10-14
fix_commits: [73160537]
cause_status: confirmed
---

# Inbox message statuses froze after waiting messages joined the current run

## What was seen

On 2026-10-14, minutes after 495ac553 (merged 13:47 ET) began delivering direct Inbox messages into
the router's running turn, the live acceptance check promoted two older queued human messages. From
then on the prepared receipt worker stopped advancing its checkpoint, so the receipt status of Inbox
messages (queued, read, answered) stopped changing in thnkr.ing.

## Cause

Promotion gives one accepted input two `accepted` events in `session_owner_events`: the queue
admission and the later steering admission. Both are valid delivery records. The Inbox message
readers (`inboxMessageSourceSql` in `bot/src/presentation-message-source.ts` for the prepared worker,
`inboxRowsWhere` in `bot/src/session-inbox.ts` for live reads) projected every `accepted` event as a
message, so the same input produced two messages with one identity. The prepared message table's
uniqueness constraint refused the second row, the worker's batch failed, and its checkpoint never
moved past that event, so every later receipt change waited behind it. 495ac553 made this reachable:
before it, a queued Inbox input was not normally admitted a second time.

## Fix

73160537 adds `firstInboxAcceptanceSql` (`bot/src/inbox-message-identity.ts`): an `accepted` event is
a message only when no earlier `accepted` event exists for the same input and session (an indexed
lookup on the input). Both the prepared and live readers use the one predicate, so they cannot
disagree. The message keeps its first accepted position; the later event stays as audit history.
No rows were deleted and no delivery was replayed: the existing worker checkpoint resumed by itself.
`docs/contracts/native-inbox.md` (waiting captures) and `AGENTS.md` record the rule.

## Acceptance scenario

- **Seed:** An Inbox router session with a running turn and two human messages queued behind it,
  plus a prepared receipt worker caught up to the current event sequence.
- **Action:** Promote both queued messages into the running turn (Work with current run), so each
  input gets a second `accepted` event.
- **Expected:** The prepared worker's checkpoint advances past both events with no uniqueness error;
  each message appears once, at its original position; receipt status changes made afterwards show
  up. Both `accepted` events remain in the event log.
- **Replayable offline:** yes (a scratch ledger with the two event rows and the prepared worker; no
  provider needed)
