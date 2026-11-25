# What banked work may spend: one quantity instead of three knobs

**Status:** design, with the live numbers it was derived from. Implementation and scenario
verification to follow in this document.

Tejas, 2026-11-25, after the repair that made banked work able to run at all:

> "we need to prioritize things that are expiring solar than later, right? Like, you know, if
> something is expiring on Wednesday, you know, we need to like exhaust that account before we move
> on to like, you know, an account that could be existing on Thursday … And a lot of like other,
> like, you know, heuristics that needs to be applied here. lets make sure that's like, you know,
> it's well designed."

## What is already right, and what the ordering question really was

Two different orderings exist and both are defensible:

- **His own work** ranks accounts by `lapsePressure` — allowance left divided by hours until that
  week ends — so a nearly-full week ending in 15 hours outranks a nearly-empty one ending in three
  days.
- **The bank** takes, among accounts it is allowed to spend, the window whose reset is soonest by
  the clock. That is his sentence exactly: Wednesday before Thursday. It is right for the bank
  because the bank runs one job at a time, so taking the allowance that vanishes soonest loses the
  least.

So the ordering was not the defect. What kept his soonest-expiring account out of the bank was the
admission rule, and the first thing verification established is that **keeping it out is correct**.

## The measurement that killed the obvious fix

Live, 2026-11-25 19:0x UTC, with the tapered-reserve idea applied as a test:

| Account | Window | Used | Left in window | His measured rate | Flat 25% says | Taper says |
| --- | --- | --- | --- | --- | --- | --- |
| hey@tejas.nyc | Weekly | 79% | 29.1 h | **2.1%/h** | 0% spendable | 16.7% spendable |
| tejas@chann.app | Weekly | 6% | 103.1 h | none | 69% | 78.7% |
| tejastej.dc@gmail.com | Weekly | 0% | 156.1 h | none | 75% | 76.8% |
| tejastej.dc@gmail.com (Codex) | Weekly | 0% | 107.1 h | none | 75% | 84.1% |

The obvious fix was to taper the held-back share as a window runs out: hold a quarter early in the
week, almost nothing in its last hour. On the first row that is plainly wrong. At 2.1% of the week
per hour with 29 hours left, his own work is on course to want 61% — three times the 21% that
remains. A taper would have handed the bank 16.7% of allowance he is going to spend himself.

**His Wednesday allowance is not going to waste. He is going to use it.** The bank's refusal of that
account is already correct, through the forecast condition repaired earlier today, not through the
reserve.

## The invariant

One quantity replaces the flat reserve, the two-hour trigger and the one-hour floor:

> **Spendable = allowance left in this window − what his own work is expected to use before it
> resets.**

Banked work may start only where that is positive, and only on the window whose reset is soonest.
Everything the three knobs were approximating falls out of it:

- Near a reset, expected use is small, so almost all the remainder is spendable — which is what the
  two-hour trigger was crudely imitating.
- Early in a window, expected use is large, so little is spendable — which is what the flat reserve
  was crudely imitating, except that the reserve was equally strict at both ends.
- An account his own work is projected to exhaust yields nothing, at any point in the window.
- It is computed **per window** — weekly and five-hour alike — and the binding answer is the
  smallest, so a five-hour window near its limit stops banked work even when the week looks open.
  (This is the gap ChatGPT Pro named: weekly surplus never establishes five-hour safety.)

## Two evidence regimes, because a missing rate is not a zero rate

**Where a rate exists**, expected use is that rate times the hours remaining, and the existing
forecast already computes both. This is the strong case and it governs.

**Where no rate exists** — which is the live state of three of the four windows above, because an
account nobody is spending produces no rate — the honest answer is that future demand is unknown.
A zero observed rate over 56 minutes says very little about the next six days. So the fallback is
the reserve, tapered by how much of the window remains:

    held back = reserve_percent × (time left ÷ window length)

That gives 23% on a fresh untouched week and a fraction of a percent in a window's last hour, which
is the shape the flat reserve should always have had. It is deliberately a fallback, not the rule:
it protects against a horizon we cannot see, and it yields to a real projection the moment one
exists.

Both regimes keep today's refusal of a **stale or failed reading**, which is what the account-room
check already enforces by reporting no percentage at all for a reading it cannot trust.

## What this does not promise

It does not promise that banked work can never be the reason his own work waits. Spending shared
allowance can always do that: if 60 units remain, the bank spends 30, and his next request needs
40, he waits. What it does promise is that the bank only spends what his *observed* behaviour says
he will not reach, and that a running banked job is still stopped at the line on the first reading
that shows it arriving there. The honest strong version remains a measured entitlement, as recorded
in `docs/incidents/2026-11-25-banked-work-never-ran.md`; this design is the evidence-based first
half of it, and it changes the sizing from a round number to his own usage.

## The scenarios to verify, on the real system

Each row is a state the chooser must land correctly. "Verified" is filled in by exercising the real
owner, not a hand-written stand-in: the last repair of this feature was proved by a fixture that
wrote the eligible-account fields by hand, and the bank then sat dead for weeks
(`2026-11-12-quiet-only-banked-job-never-started.md`).

| # | Situation | Expected |
| --- | --- | --- |
| 1 | One account, week 0% used, reset six days out, no rate | Taper fallback: ~23% held, the rest spendable |
| 2 | One account, week 79% used, reset 29 h out, rate says it exhausts first | Nothing spendable; reason `window_runs_out_first` |
| 3 | Same account one hour before its reset, rate near zero | Almost everything spendable |
| 4 | Weekly open, five-hour window at 80% used | Nothing spendable; the five-hour window binds |
| 5 | Two accounts both spendable, resets Wednesday and Thursday | Wednesday chosen |
| 6 | Wednesday account projected to exhaust, Thursday account open | Thursday chosen, and the reason on the Wednesday one says why |
| 7 | Every reading stale | Nothing spendable; reason `stale_usage_reading` |
| 8 | Nothing in the bank | No choice made, nothing logged |
| 9 | A banked run crossing the line mid-run | Asked to yield at the boundary, request stays open, continuation queued |
| 10 | His own work arrives while a banked job runs | His work is not blocked by it; the banked job yields at its next boundary |

Rows 2, 5, 6 and 7 are reproducible against live readings as they stand today. Rows 1, 3, 4, 9 and
10 need either a seeded window or a wait for a real one, and the record must say which it was.

## Implementation and verification (2026-11-25)

`bankedSpendablePercent` in `bot/src/saved-work.ts` is the one predicate: the forecast pass admits
an account only when it is positive, and the running-job check in `bot/src/banked-upkeep.ts` yields
at zero or below. Window length comes from one table (`windowLengthHours`: `5-hour` 5 h, weekly
168 h, Codex's `N-minute allowance`). The account-room check now only refuses a stale, failed or
used-up reading; how much of the room is spare is the spendable question. The claim in
`bot/src/state.ts` reads only `saved_account` and `saved_boundary_ms`, which the forecast pass
writes from that predicate, so it needed no change. No new wait reason: `window_runs_out_first`
covers "his own work is projected to use it", with its words widened to say so, and the
`banked_work_wait` log line now carries each account's spendable percentage.

Checked by a disposable harness (not committed) that copied the live usage report's readings and
measured rates into a throwaway ledger and ran the real forecast pass, claim and running-job check.
It wrote no eligible-account field by hand.

| # | How | Seen |
| --- | --- | --- |
| 1 | Seeded: 0% week, 144 h left, no rate | 78.6% spendable; chosen |
| 2 | Live: hey@ week 79%, measured 1–2%/h, 29 h left | −7.9% then −37.8% (rate rose between readings); not chosen; `window_runs_out_first` |
| 3 | Seeded: 79% week, rate 0.5%/h | 1.5 h out: 20.3% spendable, chosen. 1 h out: 20.5% spendable but refused by the unchanged one-hour floor for generic work, and the reason reads `window_runs_out_first` |
| 4 | Seeded: week 10%, five-hour 80% | With a 10%/h rate: −10%, refused. With no rate: 4.5 h out −2.5%, refused; **3 h out +5%, admitted on the five-hour window** |
| 5 | Live: chann (resets Nov 30) and gmail (Dec 2) both spendable (78.7%, 76.8%) | chann chosen; the real claim took the turn |
| 6 | Live: hey@ resets soonest but projected to exhaust | chann chosen; the log line shows hey@'s negative spendable |
| 7 | Live readings aged 10 minutes | Not chosen; `stale_usage_reading` |
| 8 | Empty bank | Pass changed nothing |
| 9 | Live: chann job running, then its rate raised to 30%/h | No yield at 78.7%; yield requested at −2993% with `allowance_boundary`; continuation queued |
| 10 | Live: his ordinary turn queued while the banked job runs | His turn claimed; a second banked job held by the one-unattended rule |

What did not survive contact:

- **A banked job's own spending counts as his rate.** The rate is measured from the account's
  readings, which include the banked run itself. A quiet-only job on a fresh account (6% used,
  100 h left) that spends 3%/h makes spendable −206% within minutes and is stopped. Generic banked
  work is less exposed because it only starts in the last two hours (3%/h × 2 h = 6%). Until the
  rate excludes banked usage, overnight quiet-only work will stop itself shortly after it starts
  on any account early in its week.
- **Row 4 holds only with a rate or more than 4 h left.** With no rate the fallback holds
  25% × (hours left ÷ 5) of a five-hour window, so at 80% used with 3 h left 5% is spendable.
- **The two-hour trigger and the one-hour floor were kept**, as the implementation brief said,
  though this design says the spendable quantity replaces them; row 3 inside its last hour is
  refused by the floor and reported with a reason that no longer fits.
