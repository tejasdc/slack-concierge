---
failure: A retained Stop could settle adopted Codex work locally before the existing provider turn was reconciled.
date: 2026-11-13
fix_commits: []
cause_status: confirmed
---

# Retained Stop bypassed adopted Codex turn reconciliation

## What was seen

A disposable reproduction supplied an already accepted Codex thread and turn, then registered a
retained Stop. Cancellation ran synchronously before the adapter read either adoption ID. The
adapter returned `ProviderTurnCancelledError` with no `turn/interrupt`, history read, or new
submission RPC. This proves the local cancellation routing defect. It does not establish whether
the real Codex daemon continued or later completed that turn.

## Cause

The shared Codex adapter registered its cancellation callback before entering the adopted-turn
branch. With its local submission flag still false, Stop took the ordinary pre-submission path and
rejected the connection wait. The accepted provider work was therefore never reconciled by that
attempt. This differed from an unsent input, where ending the wait before provider submission is
correct.

## Fix

The adapter now establishes retained thread and turn identity before registering cancellation.
Stop on adopted work enters the existing recovery loop, uses exact thread history and the retained
client message ID to discover a missing turn ID, interrupts only the matched provider turn, and
waits for terminal history. A successful interrupt callback is not terminal proof. If identity or
history remains uncertain, the accepted attempt stays parked and is not resubmitted. The ordinary
pre-submission Stop path remains unchanged.

## Acceptance scenario

- **Seed:** Scratch state and a fake Codex client with an adopted in-progress turn, plus a retained
  Stop before cancellation registration.
- **Action:** Exercise exact turn ID, client-message-ID discovery when the turn ID is absent, the
  ordinary unsent Stop control, and unavailable history with no provider turn identity.
- **Expected:** Adopted cases issue `turn/interrupt` only for the exact provider thread and turn,
  read terminal provider history before settling, and never call `turn/start`. Unsent Stop sends no
  RPC. Unavailable identity/history remains unconfirmed despite Stop callback completion.
- **Replayable offline:** yes, with `bun run scripts/codex-adopt-stop-fixture.ts` from `bot/`.
- **Before/after replay:** with the original `bot/src/codex.ts` restored from `HEAD`,
  `bun run scripts/codex-adopt-stop-fixture.ts` exited 1 at the assertion that requires the exact
  `turn/interrupt` thread and provider turn. With the correction, the same fixture passes and
  checks exact interruption, terminal history, client-message-ID discovery, no new submission,
  the unsent control, and uncertain missing identity/history.
- **Live-provider boundary:** not exercised here; a real daemon may have continued after the
  pre-fix local cancellation. Fresh review and the separately authorized native acceptance remain
  required before claiming installed completion.

## Expanded candidate boundaries

The same acceptance now includes the adjacent parked-claim race and the narrowly authorized native
controller entrance. A Stop retained after parked candidate enumeration must be rejected by both
the shared followability predicate and the atomic claim. Only an agent-created Codex session's
initial accepted creation input receives its own reconnectable client. The source-bound control
stores its operation before cutting that client's captured bridge generation, and the receipt is
`observed` only after the child's disconnect path runs. The source-bound Stop uses the normal exact
run cancellation path while preserving agent authorship; it does not run human-only ChatGPT task
withdrawal. See the runbook for the required post-release host, account-independence and live-proof
sequence. Those account and daemon experiments were not run as part of this local repair.

- **Replayable additional checks:** `bun run scripts/codex-generation-loss-fixture.ts`,
  `bun run scripts/codex-test-control-fixture.ts`, and the parked-follow fixture from `bot/`.
- **Controller limitation:** the focused owner fixture supplies a fake runtime callback. It proves
  source/target refusal, durable authorship, and idempotency, but the disposable bridge fixture is
  the only actual child-generation loss. Neither fixture proves recovery by a live Codex daemon.
