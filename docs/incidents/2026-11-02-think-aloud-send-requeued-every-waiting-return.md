---
failure: Every speech segment he sent to a Canvas think-aloud session cancelled and re-queued every agent return waiting behind that run, so one send grew to a second of the owner's single thread.
date: 2026-11-02
fix_commits: []
cause_status: confirmed
---

# Think-aloud sends slowed to a second each while agent answers waited behind the run

## What was seen

On 2026-11-02 between 21:19 and 22:05 UTC, Tejas was thinking aloud on the Canvas board "curiosity engine"
(session concierge:7810, a Codex think-aloud session). Each speech segment arrives as one send to that session,
about one every ten seconds. The work-flow supervisor opened degradation incident f5720950 at 21:54 UTC with
`owner_loop_blocked`: 16–17 s of owner event-loop lag per five minutes, all of it inside the send route. Every send
was recorded as a slow owner request, and its cost stepped up over the hour: 155 ledger statements and 80 ms at
21:15, 486 at 21:20, 1,355 at 21:42, 1,869 at 21:52, 2,212 statements and 800–1,000 ms by 22:03. Nothing else in
the owner was slow; the host was not under pressure.

## Cause

The think-aloud run was opened by Canvas speech, and such a run takes only speech from the same board and page
(`sameCanvasSpeechTurn`, `bot/src/session-execution-host.ts`). While he spoke, the think-aloud agent delegated
work and its helpers answered: twelve service returns and agent requests to concierge:7810 arrived between 21:19
and 22:03. None carries Canvas context, so none may join the run; each correctly waited in its own queued turn.

Each later speech send steers into the run and first calls `releaseEarlierWaitingInputs`
(`bot/src/session-inputs.ts`), which withdraws every eligible waiting turn of the session, cancelling the turn and
detaching the input, before the execution host checks whether the run will take the message. The run refused each
return, and the host re-queued it under a fresh turn. So every send did, for every waiting return: cancel its turn,
detach it, insert a new turn, record a new accepted event, about 170 statements and 325 KB of row reads. The
per-send cost rose by one such unit at exactly the minute each return arrived (21:19:22, 21:19:56, 21:22:13,
21:36:42, 21:36:51, 21:37:15, 21:38:59, 21:47:34, 21:52:06 twice, 21:56:47, 22:03:32) and reset when the run ended
(21:03, 21:09). The owner's event page shows one return (`return:e74dd968`) re-queued into 147 distinct turns.
The October 16 record covers the same shape with a different refusal (a prior steering row); its guard does not
see this case because a refused Canvas message never gets a steering row.

## Fix

`releaseEarlierWaitingInputs` and `releaseWaitingInputs` take the run's own admission rule (`canJoin`) and ask it
for each candidate before withdrawing its turn; a refused message keeps its queued turn and is not touched again.
The execution host builds that rule once per run (`canvasSpeechTurnJoiner`) and passes it from both the live send
path and the restart take-back path. The same rule still decides the incoming message and each released one.

## Acceptance scenario

- **Seed:** A session whose running turn was opened by a Canvas speech input (board B, page P); three service
  returns to that session queued behind it, each with its own queued turn and no steering row.
- **Action:** Send a new Canvas speech input for board B, page P to the session.
- **Expected:** The speech input is steered into the running turn. The three returns keep their original queued
  turn IDs, their `updated_at` is unchanged, no turn is cancelled with "Joined the running work with his next
  message." and no new accepted event is recorded for them. The send's ledger statement count does not grow with
  the number of waiting returns. When the run ends, the returns run in order as ordinary turns.
- **Replayable offline:** yes (ledger rows plus a stub provider that accepts the steer)
