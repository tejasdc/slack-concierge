---
failure: A handoff successor received a ChatGPT answer but could not acknowledge it.
date: 2026-11-05
fix_commits: []
cause_status: confirmed
---

# Handoff left a ChatGPT answer duty with the predecessor

## What was seen

After Concierge accepted the handoff from session 6695 to 8753, the answer to the previously sent ChatGPT Pro question arrived in 8753. Its exact return was acknowledged, but `sessions answer` refused 8753 with “Only the exact asking session can handle this ChatGPT answer.” The predecessor was superseded and could not write. The duty remained open with the predecessor and entered an external hold.

## Cause

Handoff acceptance changed the sent request's source session to the successor but left the separate ChatGPT answer obligation's asking session on the predecessor. The answer handler checked that old session identity. The repair scanner also tried to reach that superseded session.

## Fix

Handoff acceptance now includes open ChatGPT answer duties in its inventory and transfers their handling and repair ownership with the sent request. The original request, answer event, and input provenance remain. An unacknowledged return holds a new handoff until its exact receipt settles. At startup, Concierge reconciles older accepted handoffs from the retained answer and return receipts, then wakes the current successor for handling without asking ChatGPT again. Direct human-turn questions remain guarded and available for follow-up after transfer.

## Acceptance scenario

- **Seed:** A work session has an open ChatGPT question and a successor handoff accepted after the question was sent; the exact answer has returned to the successor and its return input was acknowledged.
- **Action:** The successor records `used` or `scoped` for that request and answer event through `sessions answer` using its own accepted source input.
- **Expected:** The command succeeds once, the same request and answer event remain in the ledger, the duty resolves, and a repeated action ID is idempotent. An unrelated session still cannot handle it. If the answer return is unacknowledged when a new handoff is proposed, acceptance waits for its receipt.
- **Replayable offline:** yes (isolated owner ledger with accepted handoff, ChatGPT request and return event).
