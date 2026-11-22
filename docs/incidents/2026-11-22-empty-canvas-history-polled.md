---
failure: An empty Canvas conversation reread newest history every second before its first message.
date: 2026-11-22
fix_commits: []
cause_status: confirmed
---

# Empty Canvas history kept polling

## What was seen

The November 22 nightly review of a retained Mac Think-aloud conversation found 54 empty newest-history reads over about a minute before the first input. Its empty frame drew within 5 ms and the first accepted input drew in 147 ms. The read count, rather than the 63-second wait for a person to speak, is the defect. Source request: `a980bccb-e9b1-4543-942e-01582cbe6a0d`; retained evidence: `/root/workspace/thinkering/tmp/reviews/2026-11-22-evidence/slow-open-attribution.md`.

## Cause

A newly created native session has no provider transcript or provider binding. The history worker fell through to the ledger-backed page and marked it incomplete, although the ledger held only the no-input creation and no turns. thnkr.ing correctly retried incomplete history every second. That protection was built for a cold existing transcript and was applied to a conversation known to be empty.

## Fix

The owner answers complete empty history only while the exact ledger state proves no first input: one retained no-input creation, no turns, and no provider binding. An accepted first input ends that condition; the existing session event stream wakes open readers. A cold existing transcript or accepted unbound input remains incomplete.

## Acceptance scenario

- **Seed:** A marked native Canvas session created without a first input, shown in one speaking window and an already-open observer window.
- **Action:** Leave it empty, then send one marked input through the Canvas entrance.
- **Expected:** The empty state draws without repeated newest-history reads. The first input and the agent's answer appear in the observer without reloading it, with accepted input shown once.
- **Replayable offline:** no (requires the installed owner, thnkr.ing and an open browser observer).
