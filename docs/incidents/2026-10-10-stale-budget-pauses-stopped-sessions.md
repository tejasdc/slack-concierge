---
failure: Thirteen agent conversations, including the repair agent, stayed paused after Claude had room again because an allowance decision had been applied as an ordinary human-style Pause.
date: 2026-10-10
fix_commits: [6ef04aae, bc8c6ce9, ca11c509, 2061d0a7]
cause_status: confirmed
---

# Budget pauses left conversations stopped after allowance returned

## What was seen

On October 10 thirteen conversations sat paused although Claude had room: scheduled firings (nightly review, Adidas
watch, taste mining) and the repair agent, whose never-submitted alert inputs piled up while it was paused. Several of
the original overnight runs had been completed by Codex while their Claude conversations stayed paused.

## Cause

An outside steering pattern used `budget-pause-*` session Pause actions to stop Claude work at an allowance wall. A Pause
needs an explicit Continue, so the usage-hold release that fires on fresh readings never applied. Withdrawing a request
did not terminalize its already queued target turn, so releasing the pause would have rerun work Codex had covered.

## Fix

6ef04aae refuses `budget-pause-*` action ids and `usage`/`budget` Pause values, terminalizes queued target turns of
withdrawn requests (also at startup), and adds a one-time audited repair (`bot/src/incident-budget-pause-recovery.ts`):
on a fresh usable reading, per conversation, it matches latest Pause, expected inputs, queue, open requests and active
attempts, marks covered runs, clears that Pause and wakes the queue. bc8c6ce9 keeps due firings queued and retires a
superseded watch. ca11c509 admits the repair agent's retained notices in order. 2061d0a7 credits the taste-mining request
to the retained Codex result so its pause can be released without repeating it.

## Acceptance scenario

- **Seed:** A conversation with a queued scheduled turn and a `budget-pause-*` Pause; a withdrawn request whose target turn
  is queued.
- **Action:** An agent tries a new `budget-pause-x` Pause; then a fresh reading shows Claude room.
- **Expected:** The new Pause is refused; the withdrawn request's target turn is terminal and never runs; a manual Pause
  stays paused.
- **Replayable offline:** yes (scratch ledger; the one-time repair itself is historical)
