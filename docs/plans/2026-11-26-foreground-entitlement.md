# What stays held for his own work: a measured entitlement, apart from the forecast

**Status:** built, released and observed on the live owner (2026-11-26); the live observation
is recorded at the end. Owner: concierge:10580, on request `9afe7b3c` from concierge:3633.
Closes the open item in `2026-09-23-saved-work-scheduled-and-banked.md` ("2026-11-25 — the two
release conditions") and in `docs/incidents/2026-11-25-banked-work-never-ran.md`.

## The problem in one example

The bank protected his work with a percentage floor and, since 2026-11-25, with "what is left minus
what his own work is projected to use". Neither is a promise about what he will need. With 60 units
left, a bank that spends 30 leaves 30 above a 25 floor, and a request of his needing 40 waits. And
the projection had a hole: where no rate existed — three of four windows on 2026-11-25, because an
unspent account produces no rate — the reserve was substituted for it, so a *missing forecast* was
again standing in for his protection. ChatGPT Pro's answer (concierge:10569, its sections 2A–2D)
named the fix: an amount of five-hour and weekly allowance reserved for his own work, the bank
bounded above it, and the forecast kept to its own question.

## The rule

Two questions, answered separately; the smaller answer is what one banked run may spend, in percent
of one account's window, and admission turns it into the run's ceiling as before.

1. **Forecast** — will this account's window be spent anyway before it resets? Left minus measured
   rate × hours left. With no rate it has no answer and contributes nothing. (`bankedSpendablePercent`)
2. **Protection** — how much must stay free for him? Always answered. (`foreground-entitlement.ts`)

The protection is **pooled**: his conversations are not pinned to an account (only banked work
binds, `provider-account-choice.ts`), so he waits only when every account his work can launch on is
out. The bank may spend what the pooled room exceeds his entitlement by:

- **Weekly hold** = his busiest day × days until the bank's window resets (at least one whole day,
  because his work comes in bursts inside a day), never more than his whole week. Both figures come
  from the rolling seven-day usage report the owner already refreshes every five minutes: the week's
  estimated use on every account of the provider, minus standing routines' own scheduled turns.
- **Refills count from their instant.** Another account whose week resets before the horizon gives
  back the share it has used now; the hold is checked just before each refill and at the horizon.
- **Five-hour hold** = one whole account's five-hour window, whenever any account in the pool has
  one. It does not shrink with time: it is the next burst, which can come at any hour.
- **Unmeasured** (no fresh week report for that provider): hold one whole account's window.
- The saved-work **held-back setting** (default 25) stays, as a minimum under the measured hold, so
  the control he has on thnkr.ing still means what its label says.

A running banked job yields when its account reaches its ceiling (unchanged) **or** when pooled room
reaches the hold — his own work on other accounts is invisible to a ceiling on the bank's account.
Both are levels, so the job's own spending cannot stop it early (the −206% trap of 2026-11-25). A
continuation that inherits its predecessor's ceiling skips the forecast but not the protection.

## The evidence the numbers rest on

Rolling week ending 2026-11-26 05:02 UTC (`sessions usage --by-session --period week`):

| | Claude (server pool) | Codex |
| --- | --- | --- |
| Estimated weekly use, all accounts | 115% of one account's week (hey@ 102, chann 7, gmail 6) | 21% |
| Standing routines' own turns | 3.6% | 2.8% |
| **His own work's week** | **111.4%** | **18.2%** |
| **Busiest local day** (Nov 22) | **26.5%** | 8.9% (floor of 25 binds) |
| Daily range | 6.6–26.5% | 0–8.9% |

So the starting entitlement on Claude is 26.5% of an account for any horizon up to a day, 53% for two
days, and his full 111% from about four days out. The Claude pool on the server is two accounts
(hey@tejas.nyc and tejastej.dc@gmail.com; tejas@chann.app is not launchable there).

**Five-hour windows: nothing to measure.** No account reports one today: Anthropic removed it from
Ultra accounts on 2026-10-30, and Codex currently reports only its week. His five-hour demand has
never been observed, so the hold is the smallest figure that keeps a burst of his runnable — one
whole account kept free — and it costs nothing while no window exists. It is labelled unmeasured
in code and here; when a five-hour window returns, its readings make a measured figure possible.

**Banked sessions are subtracted.** The first version left them in, reasoning that a larger hold errs
toward him. The independent review showed the loop: a bank spending 30% in a day raises the busiest
day to 30%, the hold to most of the week, and the bank then blocks itself (and a running job could
yield on its own spending at the next report refresh). Sessions with a banked turn saved within the
week plus the waiting setting are now subtracted from the week (one indexed read per five-minute
report). The report has no per-session day, so the busiest day is scaled by his share of the week;
that spreads the bank's spending evenly across days and can understate his busiest day slightly
(seeded: 24.6 instead of 26.5), which the held-back minimum of 25 covers on these numbers.

**What the evidence does not show.** One week is one week. Use outside Concierge (the Mac,
claude.ai, the phone) is in the meter but not in the attribution, so it lands in "his own work",
erring toward him.

**Quiet-only banked work is bound by the same hold.** It spends the same allowance, so it gets the
same protection; with a stale week report it can still spend what exceeds one whole account's
window (16% of the pool today).

**One horizon.** Admission and the running-job check both size the hold to the soonest reset among
the account's windows, so a job admitted with room is not judged a moment later against a different
hold (review finding).

## What it beat

| Option | Wins | Loses |
| --- | --- | --- |
| Keep the flat 25% floor | simplest | not sized from anything; per account, so it ignores that his work moves between accounts; the 60/30/40 example |
| Keep 2026-11-25's rate-or-tapered-reserve | uses real rates | a missing rate becomes a reserve, which is the forecast standing in for protection; a low overnight rate holds almost nothing for the morning |
| Per-account entitlement (hold his week on every account) | no pooling assumption | holds about twice what he can use on a two-account pool; the bank would almost never run, which is the 2026-11-25 failure again |
| A fixed protected account for foreground work | simplest real reservation | wastes that account's allowance whenever he is quiet; ChatGPT Pro's own caveat that spare accounts still absorb his overflow |
| **Pooled, measured hold (built)** | sized from his week; matches how dispatch actually routes him; always answers | one week of evidence; five-hour figure unmeasured |

ChatGPT Pro's strongest counter-argument was that a complex rule which only appears to reserve
capacity can be worse than a conservative one. The answer here is that every input is a level
Concierge already trusts for dispatch (fresh readings, launchable accounts), the hold errs upward
wherever the evidence is incomplete, and each refusal names which question refused it
(`held_for_his_work` versus `window_runs_out_first`; `banked_work_wait` logs both halves).

## What it still does not promise

That banking can never be the reason he waits. A day busier than his busiest observed day can still
outrun the hold. What it promises is narrower and true: the bank leaves, across every account his
work can use, at least his busiest day for each day left in the window it spends, and stops the
moment it would not.

## Verification

Disposable harness (not committed) running the real `foregroundNeed` and `foregroundProtection` on
the live week report and the live levels at 2026-11-26 05:05 UTC:

| Case | Seen |
| --- | --- |
| hey@ (84% used, resets in 20 h) | held 26.5, pooled 116, spendable 89.5 → ceiling 100: its lapsing 16% is all spendable |
| gmail (0% used, resets in 146 h) | held 111.4, hey@'s refill credited at 20 h → spendable 88.6 |
| Same, before refill credit was added | spendable 4.6 — the bank would have sat idle on a fresh week; fixed |
| Week report unavailable | held 100, spendable 16 |
| Codex, one account, no five-hour window | held 25 (floor), spendable 75 |
| Codex with a five-hour window at 30% | spendable −30: the single account's five-hour window is never banked |
| His own work spends the pool to 15 with 10 h left | spendable −11.5 → running job yields, queued job `held_for_his_work` |
| No launchable account | spendable −100 |

## Live observation after the release (2026-11-26)

Release `48e25d74` installed at 05:34 UTC; the startup built `banked_turns_by_saved_at` on the live
ledger. A one-line Haiku item was banked through the agent entrance (request `b974efe9`,
concierge:10609, turn 35659) at 05:35. The owner's `banked_work_wait` line for it, seconds later:

- protection measured from the live week: held 110.8% for a six-day horizon, 25.6% for the
  one-day horizon; pooled weekly room 115; no five-hour window anywhere (five_hour null)
- tejastej.dc@gmail.com: forecast 100 (no rate), protection 89.2 → admitted with ceiling 89.2%
- hey@tejas.nyc: forecast −6.4 (his measured rate spends it before its reset) → not chosen

The turn was claimed at 05:35:09, ran on tejastej.dc@gmail.com, and answered its request.
