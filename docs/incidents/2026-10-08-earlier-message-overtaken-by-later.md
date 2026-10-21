---
failure: A message Tejas sent to a session sat queued while the next one he sent 27 seconds later went straight into the running agent and was answered first.
date: 2026-10-08
fix_commits: [19e75fb8]
cause_status: confirmed
---

# His earlier message was overtaken by his later one

## What was seen

At 23:42 UTC on 2026-10-08 a message recorded into concierge:4081 sat queued behind a run held open by background
work. His next message, sent 27 seconds later, joined the running work directly and was answered, while the
earlier one still waited for its own turn.

## Cause

Confirmed from 19e75fb8. A message can be admitted as its own queued turn (for example when the run was not
steerable at that moment) and a later message can be steered into the live run. The steering path in
`session-execution-host.ts` delivered only the new message into the run; earlier waiting human messages in the
same session stayed in the FIFO behind the running turn, so his order was inverted.

## Fix

19e75fb8: when a human message joins running work, `releaseEarlierWaitingInputs` (`session-inputs.ts`) finds any
earlier message of his in that session still waiting for its own turn with no explicit delivery choice,
delivers each into the run first, oldest first, and withdraws its waiting turn; the steering delivery is factored
into one `deliver` per message. Explicitly queued messages stay queued. Rehearsed on a ledger copy: input
5409db0e moved from queued turn 5750 into run 5720 with all 924 characters; a second pass moved nothing.

## Acceptance scenario

- **Seed:** session with a running turn T; human message M1 queued as its own turn (no delivery choice); human
  message M3 queued with explicit Queue.
- **Action:** Tejas sends M2 steered into T.
- **Expected:** the run receives M1 then M2; M1's queued turn is withdrawn; M3 stays queued; repeating the
  pass moves nothing.
- **Replayable offline:** partly (ledger effects yes; delivery order into a live run needs a provider stub)
