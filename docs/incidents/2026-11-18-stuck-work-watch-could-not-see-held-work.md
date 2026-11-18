---
failure: Codex work held by an admission hold for over an hour raised no stuck-work alarm, because the watch counted only work the queue could start.
date: 2026-11-18
fix_commits: []
cause_status: confirmed
---

# The stuck-work watch could not see held work

## What was seen

On November 17 the thnkr.ing co-writer (concierge:7302) and Codex sessions 9680 and 10069 sat
queued from about 00:08Z to 01:22Z behind a Codex admission hold
(`2026-11-17-codex-rehome-hold-queued-all-codex-work.md`). Concierge filed no stuck-work notice;
Tejas found it himself. The nightly brittleness sweep of November 18 (thnkr.ing
`tmp/reviews/n1118-brittleness.md`) traced why.

## Cause

`stuck-work-watch.ts` asked `claimableNotClaimed`, which applies the queue's own claim rule
including the Codex admission gate and the update-install gate, and returns nothing at all while
an update installs. Work a gate holds is by definition not claimable, so it was never counted,
however long it waited. Separately, the shared-runtime maintenance hold drained admission while
running Codex turns finished, with no time bound.

## Fix

- `heldNotClaimable` runs the same claim rule with the Codex and update gates switched off and
  subtracts what is really claimable; what remains is held only by a gate. The watch adds these
  turns, logs each gate (`codex-admission:<holders>` or `update-install`) and says in the notice
  why the work waits in plain words (for example "Codex on the server is switching accounts, which
  should end by 1:30 AM"). Scheduled, banked and snoozed work, per-session order, Pause, Stop, archive, usage and
  retry waits stay out, so 6275 and 9515 (scheduled work that night) would still not alarm.
- Shared-runtime maintenance drains admission for at most five minutes from when its holder was
  first taken; afterwards admission reopens with its durable row kept, and it holds only around its
  own swap at an idle moment. Malformed or unknown holders still block as before.

## Acceptance scenario

- **Seed:** disposable ledger; a shared Codex turn queued well past ten minutes.
- **Action:** take a re-home holder; read the claim view and the held view; repeat with a
  per-session active run, a future retry, a young turn and an update drain; then a fresh and an aged
  runtime-maintenance holder with `boundRuntimeMaintenanceDrains`.
- **Expected:** the claim view is empty while the held view returns the turn named by its holder;
  serialization, retries and young work are not reported; an update drain is named `update-install` with its plain reason;
  a fresh maintenance drain keeps admission held, an aged one reopens it, keeps its row and lets the
  original turn be claimed.
- **Replayable offline:** yes; `bun run scripts/codex-outside-admission-fixture.ts` from `bot/`.
