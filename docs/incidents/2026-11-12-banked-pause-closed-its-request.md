---
failure: A banked job that paused at a planned point and then continued had its request closed as cancelled, so the asker was told the work stopped while the continuation went on to finish it.
date: 2026-11-12
fix_commits: [5dc56cfb]
cause_status: confirmed
---

# A paused banked job reported as stopped

## What was seen

Quiet-only banked turn 28657 (request 09226108-d761-4a30-ba7e-f737fd3f4336) was claimed at
07:13:18 UTC on 12 November, right after a Concierge update. The saved-work upkeep asked it to
yield at the deployment boundary (`banked_yield_failed` at 07:13:18.853: "The turn ended before
provider cancellation was available"), and the run ended cancelled at 07:13:25.283. At 07:13:25.901
the continuation, turn 28672, was queued as quiet-only banked work. It ran from 07:13:31 to
07:14:05. The request had already settled as `canceled`, with "The recipient execution was
cancelled without Tejas pressing Stop … follow it up". The asker was woken with that.

## Cause

When a request's turn ends, the request inspector follows a continuation only for a turn the
provider refused (`status='error'`). A cancelled turn settled at once. A planned banked pause is a
cancellation that the upkeep continues afterwards, in `resumeBankedAfterYield`, called once the run
has finished. So the inspector saw the cancellation before the continuation existed, and nothing
on the turn said a continuation was coming.

## Fix

- The upkeep records the planned pause on the turn (`saved_yield_reason`) before it asks the run
  to stop.
- `carryingTurn` follows a paused turn to its continuation, as it already did for refused turns.
  Every caller now treats a planned pause as carried on: the request inspector, the peer request
  view and Inbox recovery.
- While a paused turn's continuation is not yet queued, its request waits instead of settling.
- If the pause cannot be continued (his Stop, a withdrawn request, a session that moved on), the
  mark is cleared and the request settles as the cancellation it is.
- After an owner restart between the pause and its continuation, the upkeep queues the missing
  continuation on its next pass.

## Found during the live check: claimed and paused in a loop during an update

The live check (turn 28699, request 52de5ef6-b53c-453b-bbab-dc3c0dfabe3c) kept its request open
as intended. But during the update drain from 08:15:01 to 08:16:48 UTC, the queue claimed each new
continuation, and the upkeep paused it again within six seconds: 19 provider starts in two minutes.
The drain claim admitted any survivable native turn, including banked work that the upkeep yields
at a deployment boundary. Unattended banked work and quiet-only work are now not claimed while a
drain is in progress. They wait for the new owner.

After that release, the same live check showed a smaller repeat. The new owner adopted the running
continuation and paused it once more, about two seconds after it started. The cause was the
previous owner's drain gate, which was still recorded until startup cleared it. The upkeep now
treats only its own process's drain as a reason to pause. The request stayed open through both
pauses, at 08:15 and 08:30 UTC: the continuation posted its progress to the same request.

## Acceptance scenario

- **Seed:** a quiet-only banked turn claimed at night.
- **Action:** record a planned pause, cancel the run, then resume it.
- **Expected:** before the resume the request is waiting; after it, the request follows the queued
  continuation. An ordinary cancellation and a pause that cannot continue still settle at the
  cancelled turn.
- **Replayable offline:** yes (`bot/scripts/banked-yield-request-fixture.ts`).
