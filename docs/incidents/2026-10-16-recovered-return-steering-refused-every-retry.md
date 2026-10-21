---
failure: Answers returning to a busy session after a restart were never delivered; each was pulled out of its queue place and retried as a live message that the ledger refused every few seconds.
date: 2026-10-16
fix_commits: [fd284a68]
cause_status: confirmed
---

# Returned answers stuck retrying after a restart

## What was seen

On 2026-10-16 four service returns (answers coming back to requester sessions) were queued after a Concierge
restart and then did not arrive. The owner kept retrying them as steering into the requester's running turn every
few seconds, and every retry failed on the unique steering index (`docs/architecture/SESSION-OWNER.md`, "The October
16 incident").

## Cause

A return is delivered live (steered) into a busy session. When provider evidence proves a steering attempt was never
received (a `failed` row in `turn_steering_messages` with no `provider_sent_at`), `recoverUnsentSteeredInput` in
`bot/src/session-inputs.ts` detaches the input and gives it a queued turn, while the failed steering row stays as
permanent evidence for that accepted input ID.

`releaseEarlierWaitingInputs` (earlier-waiting promotion: a later live message pulls earlier unstarted queued inputs
into the running turn) did not exclude inputs that already had a steering row. It cancelled the recovered queue turn
and called `attachSessionSteering` again, which inserted a second `turn_steering_messages` row for the same
`accepted_input_id`. The unique index refused it, the input was left with neither a queue turn nor a delivery, and the
next pass repeated the same promotion and refusal. The dispatch path in `session-execution-host.ts` (`deliver`) also
attempted a fresh attachment instead of reading the recorded one.

## Fix

fd284a68 makes the accepted input ID the retry identity:
- `releaseEarlierWaitingInputs` skips any input with an existing steering row, so a recovered return keeps its FIFO
  queue turn.
- `attachSessionSteering` returns the input unchanged when it already has a steering row, and the execution host's
  `deliver` reads that row's state instead of inserting another.
- `recoverUnsentSteeredInput` finishes the half-done case (already detached, failed unsent row, no queue turn) by
  enqueueing it, rebinds a sent or ambiguous row without replay, and now detaches and enqueues in one transaction so
  dispatch never sees the unattached input in between.
The unique index stays as the last defence. `docs/architecture/SESSION-OWNER.md` and `AGENTS.md` record the rule.

## Acceptance scenario

- **Seed:** A session with a running turn; an accepted service return whose steering row is `failed` with no
  `provider_sent_at`, recovered into a queued turn; then a later live input to the same session.
- **Action:** The later input is steered into the running turn (triggering earlier-waiting promotion), and the queue
  wakes.
- **Expected:** The recovered return keeps its queue turn and runs once, in order, as an ordinary turn; no second
  steering row is attempted and no unique-index error is logged. A variant with the input already detached and no
  queue turn is re-queued by recovery under the same input ID.
- **Replayable offline:** yes (ledger rows plus a stub provider that reports the first steering as unsent)
