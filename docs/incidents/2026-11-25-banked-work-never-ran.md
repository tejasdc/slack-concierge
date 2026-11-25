---
failure: Generic banked work could never start, because it required a forecast that an unspent allowance cannot produce and an idle fleet this machine never has; all three items in the bank expired unused while two Claude accounts sat at 0% and 6% of their weeks.
date: 2026-11-25
fix_commits: [807c5b3f]
cause_status: confirmed
---

# Banked work could never start

## What was seen

Tejas, 2026-11-25 13:17 ET: "we haven't been doing a lot of tasks lately. Can you make sure some
of our banked tasks are being worked on, so we're not spending and wasting a lot of weekly
resets?"

The bank held exactly three items, every one of them generic (not quiet-only), every one queued
and past its expiry:

| Turn | Session | Banked | Expired | Recorded wait |
| --- | --- | --- | --- | --- |
| 22395 | concierge:8751, Spend Anthropic API credits through Claude cloud agents | Nov 5 | Nov 12 | `no_allowance_room` |
| 10721 | concierge:7199, Gemini conversations reachable like ChatGPT's | Oct 21 | Oct 28 | none recorded |
| 10702 | concierge:7196, Autocorrect that learns | Oct 21 | Oct 28 | none recorded |

The live allowance at that moment: `hey@tejas.nyc` 75% of its week (resets Nov 26), 
`tejas@chann.app` 6% (resets Nov 29), `tejastej.dc@gmail.com` 0% (resets Dec 2). So the newest
item claimed there was no account with allowance left while two accounts had almost a whole week
each. No banked item has ever run on this server.

## Cause

Two conditions, each independently fatal, in `reconsiderBankedWork` and mirrored in the queue's
claim.

**The lapse forecast asked for the opposite of what it meant.** The intended condition is the
design's: "the forecast says the window reaches its reset unspent." The code required a *positive*
projection — `window.source!=='unknown' && !window.runsOutBeforeReset`, or the provider's own
`willLastToReset===true`. The forecast's source is "unknown" precisely when there is no projected
exhaustion, and an account nobody is spending produces no rate and therefore no projection. The
condition could only be satisfied by an account climbing fast enough to project an exhaustion that
nonetheless lands after the reset. An untouched account — the only kind whose allowance actually
lapses — can never satisfy it. Claude lost the other escape on 2026-11-01, when account usage
moved to reading each account's own login (PR for `claudeWindowsFromOwnLogin`), which returns
`willLastToReset: null` for every window.

**The idle fleet is never idle.** Generic banked work also required that no other session had a
running turn and no ordinary turn was queued anywhere. The 2026-11-12 record
(`2026-11-12-quiet-only-banked-job-never-started.md`) had already established that standing agents
run through every quiet window on this server, and removed the condition for quiet-only work for
that reason. Generic work kept it, and it also counts *queued* turns fleet-wide, so a single
waiting item anywhere holds the entire bank.

Together these mean the bank was a one-week death row: with `wait_days` at 7, every banked item
was guaranteed to expire unused.

**The expiry notice hid it.** An expired banked turn does raise one question for Tejas, and all
three were sitting open in his Needs attention. But the sentence was only "This banked work found
no safe allowance window. Start it now, schedule it, or drop it," with no reason and no account,
so three defect reports read as three ordinary full weeks.

## Fix

- The lapse condition is now the design's: a fresh reading whose window is not forecast to run out
  before it resets. Staleness is still refused, through the account-room check, which reports no
  percentage at all for a reading that is not fresh.
  **What that condition establishes, stated honestly:** the capacity is safely expendable — fresh
  reading, above the reserve, nothing projected to consume it before its reset. It does not
  establish that the allowance *would* have lapsed. A missing projection is missing information,
  not a forecast of surplus, and `source==='unknown'` covers both "no model ran" and "the observed
  rate is zero". Nothing in the system may report that it proved the allowance would lapse.
- No banked work waits for an idle fleet, in the forecast pass or in the claim.
- **What is guaranteed, and what is not.** Guaranteed: a quarter of the chosen account's tightest
  window stays unspent, because that account is only a candidate above the reserve and because a
  running banked turn is asked to yield (`allowance_boundary`) on the first reading that shows it
  reaching the floor. Not guaranteed: that banked work can never be the reason his own work waits.
  Between admission and the floor the bank can consume allowance a later request of his needed —
  60 units left, the bank spends 30, 30 remain above a 25 floor, and his next request needs 40.
  That was equally true under the idle-fleet gate, since idleness at admission says nothing about
  his arrival ten minutes later; it is a property of spending shared allowance at all, not of this
  change. The remaining protections are the reserve, the choice of the account whose allowance
  lapses first, and the timing: outside his quiet hours generic banked work runs only in the two
  hours before that window resets.
- **Open, with an owner.** A sized foreground entitlement — an amount of five-hour and weekly
  allowance reserved for his own work, with banked spending bounded above it — is the protection
  that would make the stronger promise true. ChatGPT Pro (gpt-6-pro) recommended exactly that when
  consulted on this change (request `3eb0cd46-3e2c-43e6-a4d3-ba2b438112eb`, concierge:10569), and
  it needs a number: today's 25% is a percentage floor, not a measured entitlement. This session
  (concierge:3633) owns that follow-up. Until it exists, the reserve is a bound on what remains,
  not a promise about what he will need.
- Two new recorded reasons so this cannot be mislabelled again: `window_runs_out_first` (an
  account had room, but his own work is forecast to spend it before the reset) and
  `stale_usage_reading`. `no_allowance_room` now means only what it says.
- The expiry question carries the last recorded reason.

## Recovery

All three banked items were started by hand at 18:3x UTC on 2026-11-25 and ran. Their three stale
questions in Needs attention clear when each session declares its outcome.

## Acceptance scenario

- **Seed:** a generic banked turn whose provider has one account with a fresh reading, its week at
  0% used, its reset more than an hour away; another session with an ordinary turn queued; no
  usage history for that window, so the forecast's source is "unknown".
- **Action:** run the forecast pass, then claim the queue inside the two hours before that reset.
- **Expected:** the turn is given that account, records `eligible_not_claimed` rather than
  `no_allowance_room`, and claims while the other work is queued. A second run with the window
  forecast to run out before its reset records `window_runs_out_first` and does not start; one
  with every reading stale records `stale_usage_reading` and does not start.
- **Replayable offline:** not yet; the live check was three real banked items on this server.

## Found while proving it: the watch meant to confirm the fix woke on its own first run

The live proof for this repair is one real banked item (turn 35489, concierge:10580) that
reproduces the defect on the installed release and should be given an account once the fix
installs. The watch registered to confirm that fired 88 seconds later with exit code 1, before the
release could even start: a command watch wakes its session when the command **exits**, reporting
the code, and the check exited immediately because the condition was still false. The condition
itself was sound and had been exercised in all three directions first — false now, passing on a
seeded pass, refusing a broken read — but its *shape* was wrong for the primitive.

The check now polls inside itself and returns only when the condition holds, so the watch's single
wake means what it says, and the rule is written down in
[watches](../architecture/WATCHES.md#writing-a-condition-that-can-actually-pass) beside the two
condition mistakes already recorded there.
