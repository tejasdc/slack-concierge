---
failure: A Codex account switch made 37 held agent turns runnable in the same instant, the owner blocked 35 s in five minutes and the shared Codex App Server dropped its connection, parking 36 of them.
date: 2026-11-12
fix_commits: []
cause_status: confirmed
---

# Every waiting Codex session restarted at once after an account switch

## What was seen

At 18:56:52 UTC the owner started moving Codex to another account because the one in use was
spent (`codex_account_move_started`, `in_use_account_spent`). At 18:56:58 the next usage reading
saw a new account in use and released the hold on 37 waiting Codex turns in one statement
(`provider_usage_hold_released`, `released: 37`, `account_switch`). Owner requests went from about
65 to about 720 per ten minutes, about 78 agent units started in six minutes, the supervisor
counted 35 s of owner-loop blocking in five minutes (mostly disk waits for small ledger reads and
writes, with Thinkering writing heavily at the same time), and the thread-view worker fell 10,900
changes behind. At 18:57:08 the relay to the shared Codex App Server was not accepted in time,
the connection closed and 36 turns were parked as uncertain. Twelve minutes later 15 had finished,
5 were running, 2 had been withdrawn by their askers, and 10 were still uncertain, holding 4
queued sessions behind them. The same burst shape froze the owner for 51 s on 2026-11-06
(incident 474d66cd). Investigation: work-flow-supervisor incident 4b6c9a1f.

## Cause

The release functions set every released turn's next attempt to zero in one update, so the queue
could claim all of them at once. The paced failover built on 2026-11-11 paced only moves to other
providers, not releases on the same provider.

## Fix

Every bulk release (account switch, reading with room, cleared cache, proven model check,
continuation and sign-in holds, and a usage hold reaching its own reset time) marks released turns `release_pace` and gives each session a start
time: two sessions every 15 s, sessions owing his open Inbox requests first, then the longest
waiting. Each release re-ranks the provider's still-waiting released sessions from now, so
overlapping releases share one pace and a later release cannot collapse it. The status line says
when the item starts.

## Acceptance scenario

- **Seed:** five Codex sessions, each with one turn held for usage until tomorrow.
- **Action:** release Codex usage holds (as an account switch does), then claim from the queue.
- **Expected:** start times now, now, +15 s, +15 s, +30 s; only two turns claimable now; a second
  release changes nothing (`bot/scripts/held-release-pacing-fixture.ts`).
- **Replayable offline:** yes
