---
failure: A session switching provider could not be handed over while a finished ChatGPT answer waited in its queue, so the answer and the work both stalled.
date: 2026-11-16
fix_commits: []
cause_status: confirmed
---

# A handoff refused forever while a ChatGPT answer waited in the old session's queue

## What was seen

Codex's weekly allowance ran out on every account. Concierge proposed handing concierge:9772
(GPT-6.1 Sol, building passive conversation context) to a new Claude session, concierge:9874.
ChatGPT Pro had already answered 9772's final review, and that answer's return input sat in
9772's queue. Every acceptance attempt answered: "A ChatGPT answer has not reached its asking
session yet. Let the exact return receipt settle before handing off its duty."

## Cause

Acceptance required the predecessor's provider to acknowledge the answer's return input before
the answer duty could move. The predecessor's only way to acknowledge it was to run a turn, and
it could not run: that is why it was being handed off. The handoff already moves never-started
queued inputs safely (it cancels the original turn and queues a linked copy on the successor,
re-pointing the answer event at that copy), but the answer guard ran before and ignored that.

## Fix

When the unacknowledged return still waits in a queued turn the handoff itself moves (never
admitted to a provider, no dependencies), the answer duty moves with it in the same ledger
transaction. Its receipt is recorded when the successor's provider acknowledges the copied return.
A return that may have reached any provider still holds acceptance.

## Acceptance scenario

- **Seed:** a Codex session with a settled ChatGPT request, its obligation in `return_pending`,
  and the answer event's return input waiting in a never-started queued turn.
- **Action:** propose a provider-change handoff and accept it from the successor.
- **Expected:** acceptance succeeds; the obligation's asker is the successor and stays
  `return_pending`; the answer event points at the successor's queued copy of the return.
- **Replayable offline:** yes (`bun scripts/held-work-movability-fixture.ts` from `bot/`).
