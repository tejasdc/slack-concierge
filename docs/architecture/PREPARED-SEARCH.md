# Prepared word search and its size budget

The presentation worker keeps a word index of Concierge's own record inside
`presentation.db`, so the owner's session search answers without scanning the ledger.
It is derived data: everything in it can be rebuilt from `state.db`.

## What is indexed, and where everything else is found

| Evidence | Indexed here | Found through |
| --- | --- | --- |
| Accepted inputs (his words, agent requests) | yes | this index |
| User and assistant messages | yes | this index, and the archive index |
| Session titles, summaries, projects | yes | this index |
| Tool calls and tool results | **no** | thnkr.ing's archive index over provider transcripts |

The owner's search runs this index and the archive search side by side and merges them, and
passes "include tool evidence" to the archive. Tool output was 2–3 copies of the largest
documents in the system, already present in the archive index; keeping it here only cost disk.
A tool result from the last few minutes appears in tool-evidence search once the archive index
reads its transcript.

Should the two indexes merge into one? Not now. They read different sources with different
owners: this one reads the owner ledger (including inputs and Inbox posts, which no transcript
holds) and must stay inside Concierge; the archive reads provider transcripts on disk from both
machines, including sessions Concierge never ran. The division above removes the overlap that
mattered (tool output) without coupling the two owners.

## One copy of each text

| Table | Holds |
| --- | --- |
| `search_documents` | the only copy of each indexed text, plus its reference metadata |
| `search_text` | FTS5 trigram index reading `search_documents.text` as external content |
| `search_short` | contentless FTS5 index of one- and two-character substrings (“AI”) |
| `search_meta` | readiness and backfill position |

The November 2026 layout stored each text three times (original, lower-cased copy, the trigram
index's own content copy) and the short index stored its token string again. Trigram matching
is case-insensitive by itself, so the lower-cased copy is gone; a long-term match needs no
second check, and short terms beside long ones are checked in `search_short` by row.

## Size budget

Expected size ≈ 3.5 × the indexed dialogue text (one copy, a trigram index about twice the
text, the short index and metadata). Growth follows dialogue volume only. The worker logs
`presentation_search_size` hourly (document count, file bytes, free bytes, bytes the
filesystem actually holds). Freed pages above 256 MiB are returned to the filesystem by punching
holes in free-list pages (`bot/src/sqlite-free-pages.ts`): metadata-only I/O, never a
`VACUUM`, because a multi-gigabyte rewrite on this host stalls the ledger's fsyncs
([2026-10-23 record](../incidents/2026-10-23-ledger-snapshot-copy-stalled-the-owner.md)).

## Moving from the old layout

`bot/src/prepared-search-upkeep.ts` runs between the worker's catch-up batches:

1. **Release the old tables** at 32 MiB/s of rows: the old documents table in process, the old
   FTS5 storage tables through the system `sqlite3` shell with defensive mode off for that one
   connection (Bun's SQLite refuses writes to FTS5 storage tables). Small committed steps mean
   no long read of every page and no dirty-data backlog. Without the shell the old index is
   dropped whole.
2. **Backfill** the new tables at 4 MiB/s of text: every owner message's latest version, then
   every input, then every session. Catch-up keeps indexing new changes meanwhile; a backfilled
   version never replaces a newer one (`ordinal`).
3. **Ready**: search answers again. Until then it says “Search is being prepared.” and the
   archive search still answers.
4. **Return** the free pages left by step 1 to the filesystem.

The old tables are emptied first so the new index reuses their pages and the file never grows
during the move. Checks: `bot/scripts/prepared-search-check.ts`,
`bot/scripts/prepared-search-upkeep-check.ts` (both in the release build).
