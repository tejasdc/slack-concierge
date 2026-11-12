---
failure: A job banked to run only in the quiet overnight hours sat queued through seven nights and past its expiry without starting, and nobody was told why.
date: 2026-11-12
fix_commits: []
cause_status: best-explanation
---

# A quiet-only banked job never started

## What was seen

Saved turn 22048 (the Android lab work for "Personal computing sovereignty, starting with the
phone", Claude Opus session concierge:8694) was banked on 2026-11-05 06:14 UTC with quiet-only set
and an expiry of 2026-11-12 06:14 UTC. It stayed queued through seven quiet windows (00:00–06:00
America/New_York). At 06:15 UTC on 12 Nov it was still queued past its expiry. A manual
`sessions saved start 22048` at 06:16 admitted it at once, so the job and the Claude allowance were
fine. The only signal anyone received was a generic 15-minute overdue reminder to the requester.

## Cause

Quiet-only work inherited every condition of generic banking. Generic banking spends allowance
that would otherwise lapse, so it starts only when **nothing else in the whole fleet is running or
queued** and the forecast says the window would reach its reset unspent. Both the forecast pass
and the queue's claim required the idle fleet.

Some standing agent is always running overnight (nightly reviews, the Lab capacity planner, drop
watches). The systemd journal shows at least two Concierge agent execution units running at every
moment of the quiet windows of 5, 6, 7, 11 and 12 November, so the idle-fleet condition was never
true on those nights. For 8–10 November the execution units alone do not prove it, because
queued ordinary turns and App Server turns also count and are only in the ledger, which this
investigating session could not read.

The decision recorded nothing: the turn's row kept only its next attempt time, and no log line
named the condition that held it. That gap is why the cause is labelled best-explanation.

The 5 Nov repair (PR #512) was checked by a fixture that wrote the eligible account fields by hand
in a one-session ledger, so it never exercised the forecast pass or a busy fleet.

## Fix

- Quiet-only work no longer waits for an idle fleet, in the forecast pass or the claim. It needs
  only the quiet window (before the five-minute morning cutoff) and an account with room above the
  saved-work reserve. Its run is bounded by the quiet cutoff, not by the allowance window's reset.
  Generic banking keeps its idle-fleet and lapse-forecast conditions.
- Every banked turn stores why it is waiting (`saved_wait_reason`), shown as `waitingBecause` in
  `sessions saved list`, and the owner logs `banked_work_wait` whenever that reason changes.
- After each quiet window that passes without starting a quiet-only job, the agent that banked it
  is woken with the stored reason, the next window and the expiry; the last window before expiry
  says so, and an expiry without a start sends one final notice with the last recorded reason. It is an overdue event on the request that banked the job (found through a continuation's input ancestry), withdrawn if the request settles first. The reason kept after a window closes is the one that held the job during it.

## Acceptance scenario

- **Seed:** a quiet-only banked turn with an eligible account, and another session with an
  ordinary turn queued or running; a second quiet-only turn whose window passed with the reason
  "no allowance room" and a request that banked it.
- **Action:** claim the queue at 00:30 local; run the missed-window notice at 07:00 local.
- **Expected:** the quiet-only turn claims while the other work runs; generic banked work still
  waits; the asker receives exactly one notice naming the reason, the next window and the expiry.
- **Replayable offline:** yes (`bot/scripts/quiet-only-bank-fixture.ts`).
