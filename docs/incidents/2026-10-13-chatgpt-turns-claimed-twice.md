---
failure: Eleven agents' ChatGPT questions failed with "Queued turn N was claimed twice locally" after a never-sent send was put straight back in line.
date: 2026-10-13
fix_commits: [8cbd6a13, 4684681a]
cause_status: confirmed
---

# Queued ChatGPT questions failed with a "claimed twice" error

## What was seen

Between 22:49 and 23:05Z on 2026-10-13, eleven ChatGPT turns failed at setup with "Queued turn N was claimed
twice locally", and each failure failed the agent request it carried. This began right after 9e13a3a3
(`2026-10-13-chatgpt-restart-spent-retry-budget.md`) was installed.

## Cause

9e13a3a3 re-queued a `CHATGPT_NOT_SENT` turn with `nextAttemptMs: Date.now()`, an immediate attempt. The turn
returned to the durable queue while its failed local run was still unwinding and still held the turn ID in
`SessionTurnQueueCoordinator.activeTurnIds` (`bot/src/session-turn-queue.ts`). The next wake's
`claimNextQueuedTurn` (`bot/src/state.ts`) knew nothing of local ownership and claimed the same turn; the
coordinator saw the ID already active and called `onError` with "claimed twice locally", which settles the
claim as a setup failure. Any requeue faster than the unwind could hit this, including other immediate-retry
paths and turns held by an adopted execution.

## Fix

- 8cbd6a13: a lost-place ChatGPT send waits the ordinary short provider retry delay
  (`providerRetryDelayMs`) like every other retryable failure, still spending no retry budget. This removed the
  trigger observed that night.
- 4684681a: the invariant. The claim query excludes turn IDs owned locally (`turn.id NOT IN json_each(?)`):
  the queue coordinator passes its active turn IDs, and `index.ts` adds adopted-run turn IDs
  (`adoptedTurnIds`), released and followed by a queue wake when the run unwinds. A requeued turn stays queued
  for a later wake instead of being claimed and terminalized. Documented in AGENTS.md and
  `docs/architecture/TURN-LIFECYCLE.md`.

## Acceptance scenario

- **Seed:** A queue coordinator with one running local turn T whose run is still unwinding (its promise not
  yet settled), and T's ledger row set back to `queued` with `next_attempt_at` now.
- **Action:** Wake the queue before T's run settles, then let the run settle.
- **Expected:** The first wake does not claim T and no "claimed twice locally" error is recorded; after the run
  settles, the queue wakes and claims T once, and it runs. The same holds when T is held by an adopted run.
- **Replayable offline:** yes (queue coordinator with a deferred run promise and a scratch ledger)
