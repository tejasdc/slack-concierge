---
failure: Concierge's prepared search store grew to 21 GB by keeping three copies of every text, tool output included, and helped fill the server's root disk to 99%.
date: 2026-11-12
fix_commits: []
cause_status: confirmed
---

# The server's root disk reached 99% with a 24 GB presentation file

## What was seen

On November 12 the root disk reached 99% and the 50 GB free-space floor alert fired.
`presentation.db`, created October 8, was 24.2 GB and growing about 0.7 GB a day. A read-only
`dbstat` at 07:10 UTC: `prepared_search_text_data` 7.49 GB, `prepared_search_documents`
7.14 GB, `prepared_search_text_content` 3.29 GB, `prepared_search_short_content` 2.58 GB,
`prepared_search_short_data` 0.53 GB; everything else under 1.2 GB; free list near zero.

## Cause

The search store kept each text as the original, a lower-cased copy, and the trigram index's
own content copy, and the short-substring index stored its token string again. It also indexed
every tool call and result, which thnkr.ing's archive index already holds and the owner's search
already merges. Nothing removed freed pages either: SQLite keeps them in the file.

## Fix

One copy of each text (external-content trigram index, contentless short index), dialogue
only, a paced move from the old tables that never grows the file, and free pages returned to
the filesystem by hole punching. See [prepared search](../architecture/PREPARED-SEARCH.md).

## Acceptance scenario

- **Seed:** a presentation file in the old layout with tool and assistant documents.
- **Action:** run the worker's search upkeep to completion.
- **Expected:** old tables gone, only dialogue indexed, the same searches answer (including
  short terms), a newer catch-up version survives the backfill, the file's allocated bytes fall
  to a fraction, integrity check passes, freed pages are reused normally afterwards.
- **Replayable offline:** yes (`bot/scripts/prepared-search-upkeep-check.ts`).
