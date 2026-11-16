---
failure: Active Claude conversations stayed on the account whose week ends later and spent it, while an account whose week ended sooner kept its room.
date: 2026-11-15
fix_commits: []
cause_status: confirmed
---

# The week ending Sunday was spent while the week ending Wednesday kept its room

## What was seen

Tejas, Mac bug report, Nov 15, 10:31 PM ET (capture
`1b09d6c10c88ec304ebf2162c1e8a2227b3904fcd4ad26d133c13392898cbe05`): "Why is my account with the
weekly reset window, which is happening on Sunday getting used up here? Should we not use up the
first … things that are gonna get it expired by Wednesday or Thursday? … we should not be
changing only when they're expiring, but actually based on what weekly windows are happening."
His screenshot of Accounts showed chann.app in use with its week ending Sunday, Gmail at 14% with
its week ending Wednesday 2:59 AM, hey@tejas.nyc at 14% ending Thursday 8 PM. The week's usage
report put 2,377 weighted units on chann.app against 272 on Gmail and 511 on hey@tejas.nyc.

## Cause

The October 13 rule ranks Claude accounts by lapse pressure (weekly room left over hours to the
week's end), so the allowance that lapses first is spent first. The October 23 change added a
warm-cache stay before that ranking: a conversation whose last real Claude response was under an
hour ago keeps its account while it has any room, because moving it rewrites its prompt cache.
Any conversation active every hour therefore never left its account, whatever the weeks' ends.
The ledger's recorded choices for November 13: 159 turns stayed for a warm cache (116 on
hey@tejas.nyc, 22 on chann.app, 21 on Gmail) against 48 moves for room.

## Fix

The warm stay yields when another account's lapse pressure exceeds the warm account's by more
than a hysteresis band (`WARM_STAY_BAND`, twice): the warm account keeps the conversation while
its own pressure is at least half the best account's, so near-equal accounts do not ping-pong and
one prefix rewrite is not paid for nothing, but a week with room and a near end is spent even by
active conversations. `chooseAccountForTurn` in `provider-account-choice.ts`.

## Acceptance scenario

- **Seed:** A conversation last called Claude on account A 20 minutes ago. A has 99% weekly room with 171 hours to its end (pressure 0.58); B has 86% room with 52 hours to its end (pressure 1.65), both with fresh readings and no refusal.
- **Action:** Dispatch the conversation's next ordinary turn.
- **Expected:** It runs on B with reason `moved-for-room`. If B instead has 86% room with 120 hours left (pressure 0.72, under twice A's), it stays on A with reason `stayed-for-warm-cache`. A fresh manual selection and a banked binding keep their precedence.
- **Replayable offline:** yes (`chooseAccountForTurn` is a pure function over room readings).
