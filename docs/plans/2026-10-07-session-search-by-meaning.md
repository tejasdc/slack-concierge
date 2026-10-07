# Session search by meaning

Status: built 2026-10-07 (session concierge:4063, requests 47004c17 and df5cedd4 from the Inbox).

## The problem in his words

Tejas, 2026-10-07: "our search doesn't do semantic search … a better session search that not just
you, but other agents can also use to … find all of it in sessions … talk to." And, on the same
job: "We already had a bunch of sessions on … semantic search … what was selected, what was not
selected … The fresh session should be aware of it."

## How search worked before this change

`sessions search` joins the 1–8 quoted concepts into one string and splits it on spaces. Three
readers then run, and their results are merged:

- **This machine's ledger** (`SessionOwner.search`): a message matches only when it contains
  every word of the query. The ledger is scanned newest first and the scan stops at the limit, so
  results are ordered by how recent the matching message is, not by relevance. The asking
  session and the Inbox (which relays everything) come first for almost any query.
- **The transcript archive** (Thinkering's SQLite FTS5 index over both machines' Claude, Codex
  and ChatGPT transcripts): it also requires every word in one message, ranked by BM25.
- **The peer** (the Mac) runs the same ledger search when it is awake.

What this missed on 2026-10-07, measured live:

| Query | What came back |
| --- | --- |
| "QMD", "EmbeddingGemma", "semantic search" | None of the September sessions that designed and evaluated semantic search (concierge:1447 and the Sept 9 build). |
| "search freezes" | 9.2 s, and not the sessions that fixed tonight's search crash (4014/4018/4020). |
| "provider account switching" | Found the Claude account sessions only because their messages share those exact words. |

## What earlier sessions decided, and why

**September 3–9, 2026: Codex session concierge:1447 in #slack-concierge** wrote
[the router search brainstorm](../brainstorms/2026-09-03-router-session-search-and-routing.md)
and [its implementation record](2026-09-09-router-session-search-implementation.md)
(commits 02f491a, 8a3135a, 5e756c0 and 724732b).

- **Chosen:** a Concierge-owned SQLite FTS5 projection over turn text, with OR/BM25 ranking. The
  incident it fixed was a failure to find exact text.
- **Evaluated:** QMD 2.8.3 with EmbeddingGemma-300M, on 71 real held-out routing cases.
  - Adding meaning raised recall@5 from 63.4% to 76.1%. When the wording differed, meaning alone
    found the right thread 63.6% of the time, against 27.3% for words alone.
  - Neither method picked the single right thread reliably.
- **Not chosen then**, with these reasons:
  - QMD's generated-file corpus and its storage and freshness lifecycle did not fit Concierge's
    incremental ledger.
  - It used 0.6–1.2 GiB of resident memory.
  - It had no filter by message time.
  - There were no real cross-thread routing mistakes yet to justify the cost.
  - It needed CPU mode, because the automatic Vulkan path embedded 15 documents and then failed.
- **Prescribed for later:**
  - a Concierge-owned vector path;
  - CPU only;
  - no query expansion and no reranker model;
  - lexical and vector ranks fused, never a probability;
  - never index raw provider JSONL, tool output or repeated assistant text ("both expensive and
    poor routing evidence").
- The memory estimate for that path was about 31 MB of vectors for 10,000 short documents.

**September 14–15, 2026: the same session, then Thinkering's native sessions build**
([plan](https://github.com/tejasdc/thinkering/blob/main/docs/plans/2026-09-14-native-agent-sessions.md)).

- **Compared:** CASS, Episodic Memory, QMD, claude-code-tools and a custom index. CASS was
  provisionally recommended, then not adopted: its search results omit the message role and the
  native session ID.
- **Rejected:** QMD, because its document projection loses branch and message boundaries.
- **Built:** a disposable SQLite FTS5 reader over role-labelled dialogue, with a separate tool
  lane. The plan said: "semantic retrieval remains a replaceable reader capability."

**What has changed since then:**

- Slack is retired. Sessions are native, and the Inbox routes all of his work through
  `sessions search`.
- The cross-session mistakes the September design was waiting for now exist: work routed to the
  wrong session and piling onto whichever session matched (session 4053's job tonight).
- Tejas asked for meaning search directly.
- Tonight's freezes add a hard constraint: nothing on the search path may read a transcript or
  scan the ledger at length (session 4053, relaying session 4014).

## What was built

The September design's own "Concierge-owned vector path", with the same model it chose:

- **Engine:** llama.cpp's `llama-server` running EmbeddingGemma-300M Q8_0, CPU only, as a child
  process of Concierge started on first use. The model is pinned by revision and SHA-256 and
  installed by `bot/scripts/install-meaning-engine.sh` on every deploy. The installer does
  nothing when the engine is already in place.
- **What is embedded** (512 of 768 dimensions, stored as int8):
  - each session's title;
  - every human or agent request, input and final reply. A request counts toward the session it
    was sent to, not toward the Inbox that sent it.
  - every distinct prompt in the transcript archive, read from Thinkering's index database
    without opening any transcript file.
  - Never tool output, and never assistant streaming text.
- **Where the vectors live:** in a separate database next to the ledger, `meaning-index.db`. The
  ledger gets no new index.
- **Indexing:** small pages on a timer. It catches up within a minute of new work, and title
  changes are checked once a minute.
- **A query:**
  1. one embedding call (about 0.2 s once the engine is warm);
  2. a scan of the in-memory matrix;
  3. the best-matching passage counts for each session;
  4. archive matches resolve to the native session when the transcript belongs to one here, or
     else through the existing archive retention path.
- **Ranking:** word matches and meaning matches are fused by reciprocal rank (k=60). A session
  both find rises.
- **What callers see:** each result says `match: {words, meaning}`, and coverage reports whether
  meaning search was available and whether the index is still catching up.
- **The Mac:** it has no engine. Its search says so and matches words only. Its sessions are still
  found by meaning through the server's archive, which holds the Mac's transcripts.

## Options weighed

| Option | Finds different wording | Cost | Freshness | Why chosen or not |
| --- | --- | --- | --- | --- |
| Word ranking only (OR/BM25, per session) | No | none | immediate | Fixes ordering, not meaning; the Sept evaluation measured its ceiling. |
| Local EmbeddingGemma via llama.cpp, fused with words | Yes (+13 to +36 points recall in Sept) | one process; about 0.5–1.3 GB while loaded; a one-time archive catch-up | about a minute | **Chosen**: private, no credential, the Sept-preferred model, and no QMD lifecycle. |
| QMD as before | Yes | its own corpus files and lifecycle | its own scans | Rejected in Sept for lifecycle mismatch; still true. |
| Hosted embeddings (OpenAI, Voyage) | Yes | a new key, plus his private dialogue sent to a third party | immediate | Rejected: privacy and a new credential for a gain the local model provides. |
| A model reranks candidates on each search | Yes | seconds per search, and it spends allowance | — | Rejected, as in Sept: the router compares the bounded candidates itself. |

## Known limits

- Similarity is not a probability. The router still judges ownership from title, project and
  dialogue, and still clarifies when it is unsure.
- The first catch-up over about 37,000 archive prompts takes on the order of an hour at low
  priority after install. Until then, coverage says so.
- The Mac's own live sessions are matched by words only until their transcripts reach the
  archive.
