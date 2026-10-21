---
failure: Session searches took 9-28 seconds while the new meaning index was still reading old conversations.
date: 2026-10-07
fix_commits: [6f9d7fe5]
cause_status: confirmed
---

# Session search was slow while the meaning index caught up

## What was seen

After session search by meaning went live on 2026-10-07 (856becf3), whole searches by the Inbox router and agents
took 9-28 s while the background index was catching up on archived conversations; embedding one query took 3.7 s
live at 01:08 UTC (21:08 EDT).

## Cause

Confirmed from the commit. `MeaningIndex` (`bot/src/meaning-index.ts`) sent the archive catch-up to the embedding
engine in 24-passage batches. The single llama.cpp engine processes requests in order, so a search's one-query embed
waited behind whatever indexing batch was in flight, and the catch-up kept a batch in flight almost continuously.

## Fix

6f9d7fe5: indexing embeds 4 passages per request (`INDEX_BATCH`) and, before each, waits while any search is in flight
(`searching` counter around the query embed), so a query waits for at most one small batch.

## Acceptance scenario

- **Seed:** a meaning index with a large uncaught-up backlog (thousands of archive passages) and the real or a stub
  embedding engine whose cost scales with batch size.
- **Action:** run session searches while the catch-up is running.
- **Expected:** each query embed starts within one small batch's time (well under a second on the server) and whole
  searches return in their normal time; the catch-up still progresses between searches.
- **Replayable offline:** yes (stub embedding server with a per-passage delay; scratch index database)
