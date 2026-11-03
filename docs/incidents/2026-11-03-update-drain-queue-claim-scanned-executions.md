---
failure: While an update held the drain gate, every queue claim scanned the whole executions table to decide which runs survive a restart, holding the owner for up to 14 seconds of each minute on a busy evening.
date: 2026-11-03
fix_commits: []
cause_status: confirmed
---

# Concierge slowed to a crawl for the two minutes each update installs

## What was seen

The outside monitor opened `owner_loop_blocked` at 05:21 UTC on November 3 (incident f5720950,
reopened 5), with 30,282 ms of owner event-loop lag in five minutes and no slow route: the
`send`, `history` and `inbox` routes were idle or fast. The owner journal shows the lag starting at
05:19:39.8 UTC and ending with the restart at 05:21:42, 55 `owner_event_loop_lag` records adding to
27.2 s. In 40 of them the slowest piece was the queue-claim transaction (`claimNextQueuedTurn`,
30–90 ms each), whose slowest statement carried fingerprint `28603160c985914d`. The update runner
(`concierge-deploy-112a3cf7`) had claimed the drain gate at 05:19:38 UTC; the drain lasted 122 s.
After the restart the lag records fell to four in two minutes.

The same shape appears in every busy update window over the previous four days: with the gate
held, queue-claim lag of 1–14 s per minute, roughly in proportion to how many sessions were
sending and finishing work (11 runs were active that night); quiet updates showed none.

## Cause

Fingerprint `28603160c985914d` is the SHA-256 prefix of the survival proof's query in
`execution-survival.ts` (`provenRunKinds`), hashed from the installed bundle. It reads
`SELECT DISTINCT provider || '/' || supervisor FROM executions WHERE adopted_live=1 AND state='released'`.
The only index on `executions` covers open states, so this is a full table scan with a temporary
sort: 9,743 rows spread over 62,659 pages (245 MB) in the November 2 backup, 22 ms warm on an idle
machine and 50–100 ms inside the busy owner.

The queue runs that query inside every claim transaction, but only while `deployment_drain` is set
(`currentClaimSurvivability`), which is why it is invisible outside update windows. The queue pump
claims until a claim returns nothing, and it is woken by every execution change; with a dozen runs
streaming, finishing and being answered, claims ran several times a second, each paying the scan on
the owner's single thread. The receipts' `deploymentHold` reads the same proof per input while the
gate is held.

## Fix

A partial index `executions_survival` on `(provider, supervisor)` restricted to exactly the proof's
predicate (`adopted_live=1 AND state='released'`), created at startup beside the table's other
upgrades. The proof names it with `INDEXED BY` when the ledger has it, because the ledger carries no
planner statistics; a ledger an older owner last opened still answers by the scan. Bun's planner
reports `SCAN executions USING COVERING INDEX executions_survival`; every other `executions` query
keeps its plan (`executions_open`, the primary key, or the scans they had).

## Acceptance scenario

- **Seed:** a ledger with thousands of released executions and a dozen sessions receiving and
  finishing work; an update claims the drain gate.
- **Action:** the queue claims turns while the gate is held for about two minutes.
- **Expected:** no `owner_event_loop_lag` record names the queue-claim transaction with the survival
  query as its slowest statement; the outside monitor's five-minute lag stays below its
  `owner_loop_blocked` threshold for an update window as busy as November 3.
- **Replayable offline:** yes (plan check with `bun:sqlite` on the table's schema; timing needs a
  ledger of realistic size).
