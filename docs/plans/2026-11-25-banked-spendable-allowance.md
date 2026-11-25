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

`bankedSpendablePercent` in `bot/src/saved-work.ts` is the one quantity: per included window, what
is left minus what his own work is expected to use before that window resets; the smallest window
binds. With a measured rate, expected use is rate × hours left. With none, the reserve is held, and
only a window of a day or longer tapers it by the share still to run: the taper rests on the work he
could still fit in shrinking as the window closes, which is true of a week and false of a five-hour
window, where one burst can take the lot with three hours left. Window length comes from one table
(`windowLengthHours`).

**The spend is bounded at admission, not re-judged while running.** Admission stores a ceiling on
the turn (`saved_ceiling_percent`): the account's tightest used percentage at admission plus the
spendable percentage then. The running-job check in `bot/src/banked-upkeep.ts` yields when the
tightest used percentage reaches that ceiling and never measures a rate. The first version re-judged
the running job against the measured rate, which includes the job's own spending: a 3%/h job on a
fresh week read as −206% spendable and stopped itself within minutes. A level cannot be polluted
by who moved it, and his own work arriving mid-run reaches it sooner, so the bank yields earlier. A
running turn admitted before the ceiling existed has none and yields once, so its continuation is
admitted with one. A waiting admitted turn keeps its ceiling through drift under half a point.

**A continuation inherits its predecessor's ceiling while the window is the same one.** A yield is
a pause in one job, not a new job (the November 12 record settled that for the request side), so
re-admitting would re-decide a settled question on worse evidence: a rate the paused job moved.
Admission stores, beside the ceiling, the account, window and the reset instant of each included
window (`saved_ceiling_window_json`); the continuation copies it (`saved_inherited_ceiling_json`).
While every reset instant still matches within the forecast module's five-minute tolerance, the
continuation resumes on that ceiling without re-admission, or waits (`waiting_for_reset`) if the
account is already at it. If any window reset during the pause, the inheritance is dropped and the
continuation is admitted from scratch: an inherited 84% ceiling would otherwise let it spend most
of a fresh week.

The account-room check refuses only a stale, failed or used-up reading. The claim in
`bot/src/state.ts` reads only `saved_account` and `saved_boundary_ms`, which the pass writes from
the same quantity, so it needed no change. Wait reasons: `window_runs_out_first` (words widened to
"his own work is projected to use it") and a new `too_close_to_reset` for his one-hour floor, which
stays because a job that cannot finish before the reset wastes the work. The `banked_work_wait` log
line carries each account's spendable percentage and the ceiling.

Checked by a disposable harness (not committed) that copied the live usage report's readings and
measured rates into a throwaway ledger and ran the real forecast pass, claim and running-job check.
It wrote no eligible-account field by hand. Every row was re-run after the ceiling change.

| # | How | Seen |
| --- | --- | --- |
| 1 | Seeded: 0% week, 144 h left, no rate | 78.6% spendable; chosen; ceiling 78.6% |
| 2 | Live: hey@ week 79%, measured 2%/h, 29 h left | −37.7%; not chosen; `window_runs_out_first` |
| 3 | Seeded: 79% week, rate 0.5%/h or none | 1.5 h out: 20.3% spendable, chosen, ceiling 99.3%. 54 min out: ~20.6% spendable, refused, `too_close_to_reset` |
| 4 | Seeded: week 10%, five-hour 80% | No rate, 3 h or 4.5 h left: −5%, refused. 10%/h: −10%, refused. All `window_runs_out_first` |
| 5 | Live: chann (resets Nov 30) and gmail (Dec 2) spendable (78.7%, 76.8%) | chann chosen; the real claim took the turn |
| 6 | Live: hey@ resets soonest but projected to exhaust | chann chosen; the log line shows hey@'s negative spendable |
| 7 | Live readings aged 10 minutes | Not chosen; `stale_usage_reading` |
| 8 | Empty bank | Pass changed nothing |
| 9 | Live: chann job running, ceiling 84.7% | Its own spending (3%/h, +1 point, rate-spendable −215%): no yield. Tightest weekly at the ceiling: yield requested, `allowance_boundary`; continuation queued |
| 10 | Live: his ordinary turn queued while the banked job runs | His turn claimed; a second banked job held by the one-unattended rule |

Pause-and-continue, run after the inheritance change on the same live readings (all rows above
were re-run too, with the same results):

| Case | Seen |
| --- | --- |
| Yield at the ceiling (row 9), continuation in the same week | Inherited; not chosen; `waiting_for_reset` |
| Paused by a Concierge update at ceiling 84.7, then its own pace reads 3%/h (fresh spendable −215%) | Inherited 84.7; chosen; the real claim took it |
| Same pause, but the week reset meanwhile (reset +7 days, 0% used) | Inheritance dropped; admitted afresh on the account now resetting soonest, ceiling 76.8 |
