---
failure: The Inbox could not record its outcome for a reply in a routed thread, and the database error undid the delivered turn's completion, leaving it stuck in delivering.
date: 2026-10-16
fix_commits: [f76d6070]
cause_status: confirmed
---

# Inbox outcome for a routed thread failed and rolled back a finished turn

## What was seen

During the 2026-10-16 capacity episode, the Inbox router's outcome declaration for a recovered held reply was refused
by a foreign-key error three times. The turn that had already delivered its answer did not finish: its completion was
rolled back each time and it stayed in `delivering`.

## Cause

`recordTurnOutcome` in `bot/src/session-turn-outcome.ts` wrote the thread root it answered into
`session_owner_events.input_id`, a column that references accepted inputs. An Inbox thread root can be a message that
is not an accepted input: a routed topic's destination message or a request's own entry. For such a root the insert
failed its foreign key. The same function is reached through `recordUnsaidTurnOutcome` inside the projection
transaction in `session-projection.ts` that finishes the turn, so the constraint error aborted that transaction and
undid the turn's terminal state. The same column was also used for the follow-up `needs_you` event.

## Fix

f76d6070:
- `recordTurnOutcome` writes the root into `input_id` only when `getAcceptedSessionInput` finds it; the root always
  stays in the payload (`inputId`), and the already-notified check now joins on `json_extract(payload_json,'$.inputId')`.
  The `needs_you` insert uses the same rule.
- `session-projection.ts` wraps `recordUnsaidTurnOutcome` in a try/catch that logs
  `turn_unsaid_outcome_record_failed`, so recording an outcome can never roll back the turn's finish.
AGENTS.md records the rule.

## Acceptance scenario

- **Seed:** An Inbox topic whose root is a routed topic's destination message (no `session_inputs` row with that ID),
  and an Inbox router turn answering it that has delivered its reply.
- **Action:** The router declares `sessions outcome response` for that thread (and separately, the turn ends with no
  declaration so the unsaid outcome is recorded).
- **Expected:** Both `turn_outcome` (and `needs_you`) events are stored with `input_id` NULL and the root in the
  payload; no foreign-key error; the turn reaches `done`; a second declaration in the same run is recognised as
  already notified.
- **Replayable offline:** yes (ledger-only; seed rows directly)
