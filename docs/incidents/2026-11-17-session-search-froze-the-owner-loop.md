---
failure: Every session search blocked Concierge's single owner loop for 1-3 seconds, stalling his Inbox, sends and receipts.
date: 2026-11-17
fix_commits: []
cause_status: confirmed
---

# Session search froze the owner loop

## What was seen

The outside monitor reopened its slowdown condition at 14:58 ET on 2026-11-17 with `owner_slow_reads`
and 13 s of loop blocking in five minutes, all of it `POST /sessions/v1/search`. At 19:54:05-19:54:13Z
six searches each logged `owner_event_loop_lag` of 1.0-2.7 s. Every search in the preceding three hours
took over 1 s, the worst 9.3 s. A baseline taken the same evening ran three searches at once and
measured owner lag of 771, 413 and 543 ms, with two further 2.0 and 3.0 s lags on unrelated tasks
queued behind them. Because one loop serves every request, each search stalled his Inbox, sends and
receipts for as long as it ran.

This is the third return of the same symptom. 2026-10-12 (2ece67b7) moved historical routing and the
prepared word read into the sealed search subprocess and bounded the Inbox index warm-up; that was
treated as closure on the strength of three searches in a quiet window showing no owner lag, which
proved those reads had moved, not that a search was cheap.

## Cause

Confirmed from the owner's own storage instrumentation and from reproducing each half.

Two independent costs, both synchronous on the owner loop, neither of them the phases already moved:

1. **Meaning ranking.** `MeaningIndex.ranked` (`bot/src/meaning-index.ts`) scored every indexed row
   against the query vector in one uninterruptible loop: 138,499 passages x 512 dimensions, about 71
   million multiply-accumulates, then a Map over every row and a sort. Reproduced at 101-145 ms on an
   idle machine and 178-318 ms under load. `searchVector` had the same scan and was called
   synchronously from `bot/src/request-history.ts`. The cost grows with his history.
2. **Result assembly.** After the off-loop phases returned, `SessionOwner.search` still resolved every
   hit to a session, resolved meaning hits, read the peer catalogue, ran `sessionMutuals`, resolved
   archive candidates and built a full session view per returned result on the owner's own connection:
   1,308-1,941 storage calls per search, 2,116 and 13,389 in the worst samples.

The decisive evidence that this was neither one slow query nor disk waiting: `cpu_ms` matched `lag_ms`
almost exactly (2,327 ms CPU for 2,067 ms lag) while the slowest single statement was 64-66 ms.

## Fix

Meaning ranking yields to the loop between time-bounded steps, keeping its result identical by
capturing the published row count once and replacing `Array.sort` with a stable merge that preserves
tie order. `searchVector` and its request-history caller became asynchronous for the same reason.

The ledger assembly moved into the existing private read-executor pool on the archive lane, where
interactive app reads pass its backlog and it may hold only one of the two readers. The owner keeps
peer federation, the meaning phase and the only writes: an archive candidate that needs creating or
updating returns as pending, the owner writes exactly those and asks once more, which is skipped
entirely in the steady state. If the executor is unavailable, refuses or times out, the owner answers
from the original in-owner path and logs `session_search_executor_fallback`.

The executor fetches the owner's meaning result over the owner's existing private local socket, so
meaning still overlaps the word, routing and archive phases as it did before; serialising it instead
cost a measured 602 ms per search.

`session_search_slow` now reports `executor_ms`, `owner_ms`, `meaning_embed_ms` and `meaning_rank_ms`,
so the next return of this symptom can be split without reproducing the investigation.

## Acceptance scenario

- **Seed:** a meaning index of order 10^5 passages at 512 dimensions, a ledger with enough sessions
  that a search returns its full result window, and a read-executor pool.
- **Action:** run several session searches at once while other requests arrive.
- **Expected:** search answers are byte-identical to the pre-change answers, including ordering, ties,
  evidence, coverage and addresses; no single synchronous step of a search holds the owner loop for
  more than about 10 ms; and an unavailable executor still returns the same answer.
