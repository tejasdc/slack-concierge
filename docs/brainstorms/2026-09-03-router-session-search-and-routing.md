# Router session search and destination resolution

Status: design research; no runtime behavior has changed.

Date: 2026-09-03

## Decision summary

Concierge should own thread discovery because it is the only store that can map
searchable text to the exact Slack destination tuple `(channel_id, root_ts)`.
Provider transcripts are useful for resuming a known provider session, but they
are the wrong routing index: they are provider-specific, include tool/runtime
noise, lack an authoritative Slack destination for every record, and may be
compacted, cleaned, moved, or change format independently of Concierge.

The smallest reliable production design is:

1. Add a read-only `router-actions.sh threads search` contract backed by a
   Concierge-owned SQLite FTS5 projection over normalized Slack-visible turn
   text.
2. Search only when the incoming message contains an explicit or strongly
   implied resume signal. Require the proposed destination channel and the
   triggering `message_ts`; both are hard eligibility filters.
3. On an explicit resume signal, an unavailable, incomplete, empty, or
   ambiguous search must lead to clarification. It must never silently become a
   new thread.
4. Do not index raw `~/.codex` or `~/.claude` JSONL and do not add semantic
   search to the first implementation. The observed incident was an exact-text
   discovery failure, and FTS5 solves it without another model or lifecycle.
5. Keep QMD as the preferred semantic candidate, not as an approved runtime
   dependency. A real-corpus trial proved that its vector mode recovers useful
   paraphrases, but also exposed material host cost and index-ownership issues.
   Adopt it only after a labeled routing evaluation demonstrates a recall gap
   that FTS5 plus the clarification invariant cannot accept.

This is not an argument that semantic retrieval is unhelpful. It is an argument
that a correctness invariant and an owned exact-search path solve the incident;
semantic retrieval should earn the extra storage, memory, freshness, and failure
surface with measured routing examples.

## Incident this design must prevent

On 2026-09-03 a DM capture said, “I recently had a chat about hair loss and
shower filters.” The router correctly chose `#life-logistics`, but opened root
`1788420159.939949` instead of resuming root `1786558965.762069` from 2026-08-12.
The old thread predated the DM-router provider session, so current session
context could not expose it. A post-hoc SQLite query found both phrases in the
old thread in 37 ms.

The missing primitive was not a better router prompt. It was a sanctioned,
bounded lookup from topic text to an exact Slack root.

## What Concierge stores today

Concierge is not a Slack-workspace transcript archive and it does not copy every
provider event. It stores the durable boundary required to accept a Slack input,
run a provider turn, recover non-atomic delivery, and preserve exact
Slack/provider ownership:

- `sessions` maps a Slack channel/thread identity to a provider and provider
  session UUID (`bot/src/state.ts:110-121`).
- `turns` stores the user-facing input and result lifecycle
  (`bot/src/state.ts:124-134`), with later schema additions for canonical replay
  text, exact outbound text, and response TL;DR.
- `turn_steering_messages` stores each steering input plus its canonical replay
  form (`bot/src/state.ts:143-159`).
- `slack_user_input_claims` durably classifies each claimed Slack input before
  routing side effects (`bot/src/state.ts:162-181`).
- `replay_text` is not redundant with `user_text`: comparisons reconstruct only
  provider-accepted canonical user history, including steering, and reject
  unprovable history (`bot/src/state.ts:2435-2478`).
- `outbound_text` is not just another archive copy. It is the exact Slack
  delivery payload used after a process dies between provider completion and
  Slack acknowledgement (`bot/src/turn-recovery.ts:179-180`). It currently
  equals the provider reply plus Concierge's provider/CWD footer
  (`bot/src/turn-execution.ts:434-439`).
- `agent_text`, `response_tldr`, and root/thread projection rows support
  recovery, visible cumulative summaries, and exact fork previews
  (`bot/src/state.ts:3690-3713`, `bot/src/state.ts:5694-5752`,
  `bot/src/thread-summary.ts:4-31`).
- The Codex Remote mirror deliberately retains delivery/idempotency rows for
  externally initiated turns; it does not copy every App Server transcript
  item (`docs/architecture/PROVIDER-SESSIONS.md:65-77`).

The database therefore contains durable Slack-facing state and some intentional
boundary duplication. The provider stores contain the richer conversation and
tool transcript. They have different owners and failure modes.

### Measured production footprint

Read-only measurements against `/root/.local/state/concierge/state.db` at about
13:02 EDT on 2026-09-03:

| Measurement | Value |
| --- | ---: |
| SQLite main file | 10 MB |
| WAL at measurement time | 4 MB |
| Sessions | 134 |
| Turns | 573 |
| Visible Slack roots represented by Slack-user turns | 244 |
| Turn `user_text` | 402,177 bytes |
| Turn `replay_text` | 567,446 bytes |
| Turn `agent_text` | 1,333,705 bytes |
| Turn `outbound_text` | 1,336,357 bytes |
| Turn `response_tldr` | 128,050 bytes |
| Input-claim `user_text` | 403,358 bytes |
| Steering user + replay text | 78,010 bytes |
| Durable progress chunk JSON | 596,217 bytes |

The five turn text fields totaled 3,182,881 bytes across the August 7–31 data.
A straight-line text-only extrapolation is roughly 46 MB/year. That is not a
forecast—the mix of turn length and provider usage can change—but it establishes
the present order of magnitude. There is no general production deletion path
for `turns` or `sessions`; a case-insensitive whole-source search found zero
such deletes outside tests.

By comparison, the provider-native live transcript directories held:

| Store | August files | August bytes | Total observed |
| --- | ---: | ---: | ---: |
| `~/.codex/sessions` | 504 | 1,355,740,434 | 1.4 GB / 552 JSONL files |
| `~/.claude/projects` | 102 | 18,497,516 | 28 MB / 115 JSONL files |

The Codex numbers cover all local projects, not just Concierge. They show that
raw provider events—not the 10 MB Concierge ledger—currently dominate local
conversation storage. The workspace's transcript-archive policy creates
additional durable copies outside this repository. Changing that retention is
a separate ownership decision; routing should neither depend on nor duplicate
those archives.

### Storage conclusion

Do not delete or compact current turn fields as part of session search. Their
current consumers include recovery and replay, and the demonstrated storage
pressure is elsewhere. A later storage-specific change may normalize settled
payloads—for example, reconstructing a footer instead of retaining a second
near-copy—but it must first prove every lifecycle and historical consumer. It is
not necessary to make routing search viable.

## Retrieval corpus

Search should project only text that helps identify a Slack conversation:

- initial `turns.user_text`;
- accepted `turn_steering_messages.user_text`;
- delivered `response_tldr`;
- exact metadata: channel ID/name, visible root timestamp, source message
  timestamp, turn/steering identity, provider, provider session status, and
  last activity time.

Exclude:

- `replay_text`, because it contains provider-input wrappers, Slack identity,
  and attachment/link instructions;
- full `agent_text` and `outbound_text`, because the TL;DR is the routing-sized
  outcome and outbound text nearly duplicates the response;
- tool calls/results, thinking, operation previews, progress history, system
  prompts, and raw provider JSONL;
- the current triggering message and any root that did not exist before its
  supplied `message_ts`.

Today that normalized text is 539,076 logical bytes including sent steering—
roughly 15% of the five primary turn text fields. A disposable on-disk SQLite
projection with 1,097 input, steering, and TL;DR fragments occupied 1.1 MB:
about 745 KB for the fragment/metadata table and 319 KB for its FTS structures.
It is a small, rebuildable search view, not a second canonical transcript.

### FTS5 projection shape

Use a small `router_search_documents` table with one immutable fragment per
searchable source:

```text
router_search_documents
  id
  source_kind          turn_input | steering_input | delivered_tldr
  source_id            owning turn or steering row
  slack_channel_id
  slack_thread_ts      exact visible reply root
  slack_message_ts
  slack_message_ts_us  validated integer sort/filter key
  occurred_at
  content
```

An external-content FTS5 table indexes `content`. Source insertion and its FTS
projection occur in one SQLite transaction. A one-time backfill uses the same
projection function as live writes, so the historical and live shapes cannot
drift. Each accepted input or delivered TL;DR adds one bounded fragment; there
is no full-corpus rescan, idle poller, watcher, generated Markdown directory, or
second service.

Search joins FTS hits back to the authoritative session/channel rows, applies
eligibility before ranking, groups multiple fragment hits by visible root, and
returns the best snippet per root. FTS5/BM25 is the retrieval index; Concierge's
normal tables remain the authority for destination and resumability.

Run one parameterized FTS query per supplied concept. Normalize each concept to
Unicode word tokens and use escaped prefix tokens joined with `AND` inside that
concept (`shower* AND filter*`), rather than treating `"shower filter"` as an
exact phrase. Fuse the per-concept ranked lists after grouping by root. Order by
concept coverage first, reciprocal-rank contribution second, user-input hits
before TL;DR-only hits, and recency only as the last tie-breaker. Return the
matched concept list and score components so the router can inspect evidence;
never expose one opaque confidence number as proof of identity.

A disposable Bun/SQLite probe verified the runtime primitive against the live
data: FTS5 backfill over 567 Slack-user turns took 13.9 ms, and the incident
query (`hair AND shower AND filter`) with exact `#life-logistics` and
`root_ts < 1788420135.485139` filters took 0.33 ms. Both matching fragments
grouped to the intended August 12 root. A separate on-disk size probe produced
the 1.1 MB projection reported above. These are warm, single-run measurements,
not service SLOs; they establish that the bounded exact path is comfortably
inside the router's latency and storage budgets.

## Owned helper contract

Proposed shell interface:

```sh
router-actions.sh threads search <target-channel-name-or-id> \
  --before-ts <triggering-message-ts> \
  [--exclude-root-ts <source-root-ts>] \
  [--limit <1..10>] \
  -- <concept...>

# Example
router-actions.sh threads search life-logistics \
  --before-ts 1788420135.485139 \
  -- "hair loss" "shower filter"
```

Properties:

- read-only and credential-free;
- target channel and `--before-ts` are required;
- `--before-ts` is the Concierge-supplied `message_ts`, never `thread_ts` and
  never a provider session anchor;
- each argument after `--` is one router-selected concept, not raw FTS syntax;
  accept 1–8 bounded concepts, tokenize and quote them inside the helper, and
  bind the resulting FTS query as data;
- preserve Slack timestamps as strings in results, but validate and convert
  them to integer microseconds for ordering/filtering rather than comparing
  floating-point casts;
- channel names resolve through the current channel registry; an unknown or
  ambiguous name is an error rather than a global search;
- results include only roots in that exact channel whose first visible message
  predates the trigger;
- current root exclusion is explicit when the caller is already inside a
  thread;
- default limit 5, hard maximum 10;
- stable JSON on stdout, diagnostics only on stderr, nonzero exit on an
  unavailable or incomplete search;
- no posting, resuming, Slack API call, or routing decision occurs inside the
  search command.

Proposed result:

```json
{
  "concepts": ["hair loss", "shower filter"],
  "target_channel": { "id": "C0BNSAAR27K", "name": "life-logistics" },
  "before_ts": "1788420135.485139",
  "complete": true,
  "results": [
    {
      "channel_id": "C0BNSAAR27K",
      "channel_name": "life-logistics",
      "root_ts": "1786558965.762069",
      "date": "2026-08-12T18:22:45Z",
      "last_activity_at": "2026-08-12T20:16:07Z",
      "title": "Hair thinning since moving to New York — research request",
      "snippet": "...shower-head filter... chlorine... whether that matters for hair...",
      "matched_concepts": ["hair loss", "shower filter"],
      "matched_source": "turn_input",
      "matched_message_ts": "1786558965.762069",
      "resumable": true,
      "provider": "codex"
    }
  ]
}
```

The helper must not expose SQLite row IDs as routing identifiers. The stable
destination is the Slack `(channel_id, root_ts)` pair; provider/session metadata
is evidence only. `resumable` must use the current channel-mode/session resolver,
especially for `single-persistent` channels; a historical session row alone is
not proof of current routing ownership.

## Router decision contract

Destination resolution has two decisions: choose the channel, then choose
resume versus new within that channel.

1. Detect an explicit or strongly implied resume signal: “continue,” “the chat
   about,” “we discussed,” “last time,” “go back to,” or equivalent anaphora.
2. Resolve the likely destination channel using the router's existing channel
   context.
3. Extract a small set of distinctive topic concepts and call `threads search`
   with that channel and the exact supplied `message_ts`.
4. Resume only when the returned evidence identifies one clearly matching
   root. The router posts to that exact root; it never substitutes the newest
   root or a provider-session anchor.
5. If several roots remain plausible, ask a concise clarifying question naming
   the dates/topics.
6. If search fails, reports incomplete state, or returns no convincing match
   for an explicit resume signal, ask for clarification. Do not create a new
   thread merely because retrieval failed.
7. Messages that are clearly new work keep the current route-new behavior and
   do not pay search cost.

The last invariant—not a relevance threshold—is what prevents a repeat even
when the index is unavailable or wording is genuinely ambiguous.

## QMD evaluation

[QMD](https://github.com/tobi/qmd) is the strongest semantic candidate found.
Version 2.8.3 provides a library API, BM25, vector retrieval, typed query
documents, reciprocal-rank fusion, and optional local expansion/reranking. Its
[query syntax](https://github.com/tobi/qmd/blob/main/docs/SYNTAX.md) lets a
caller bypass generative expansion and provide explicit `lex` and `vec`
queries. The default full pipeline downloads approximately 300 MB of embedding
weights, 640 MB of reranker weights, and 1.1 GB of query-expansion weights.

### Production-corpus trial

A disposable exporter grouped the production data into 214 visible-thread
Markdown documents. Two corpus shapes were tested:

- concise: user text + delivered TL;DR, 509,443 logical source bytes before
  Markdown/metadata overhead;
- full: user text + full agent reply, 1,700,851 logical source bytes.

Measured on the current AX41 host using QMD 2.8.3:

| Operation | Result |
| --- | --- |
| BM25 query, concise corpus | August 12 root ranked first; 0.16 s, ~65 MB RSS |
| BM25 paraphrase with deliberately changed vocabulary | zero results |
| Default embedding attempt | Vulkan selected automatically; repeated `ErrorOutOfDeviceMemory`; exit 134 |
| Forced-CPU embedding backfill | 351 chunks / 211 remaining documents; 4m12s; ~1.32 GB peak RSS |
| Forced-CPU typed vector query, fresh process | August 12 root ranked first for literal and paraphrased queries; 2.1–2.5 s; ~614–632 MiB RSS |
| Forced-CPU typed vector query, same warm process | August 12 root remained first; subsequent queries took 29–46 ms while the process remained at ~623–632 MiB RSS |
| Forced-CPU typed lex+vec, no reranker | August 12 root ranked first; 2.51 s |

The exact BM25 query also returned the later duplicate, the incident report,
the source DM, and the old inbox capture with almost tied raw scores. QMD did
not know which rows existed at routing time or which channel was authoritative.
That confirms metadata eligibility must be enforced by Concierge rather than
left to semantic ranking.

The RAM figure is process memory, not per-query storage. The selected
[EmbeddingGemma](https://ai.google.dev/gemma/docs/embeddinggemma) GGUF occupies
333.6 MB on disk. Loading its 308-million-parameter model, a 2,048-token
embedding context, llama.cpp's native runtime, and Bun
produced a measured peak resident set of 647,512 KiB (632 MiB). The query vector
itself is only 768 float32 values, or 3,072 bytes. The 356 stored corpus vectors
occupy 1,093,632 raw bytes; they are not the source of the current RAM peak.

The first-query latency is likewise mostly model/runtime initialization rather
than corpus search. A second measurement issued three direct `searchVector`
calls through one QMD SDK store. The first took 2.11 s; the next two took 45.7
ms and 29.4 ms. A short-lived helper releases that RAM on exit. A persistent
process can amortize startup in exchange for keeping roughly 0.6 GB resident
while its embedding context is warm. QMD's current source defaults to unloading
idle contexts after five minutes while retaining loaded model weights unless
configured otherwise or the store closes.

The trial proves semantic value but does not by itself justify production
adoption:

- one incident is not a routing-quality benchmark;
- the safe configuration must force CPU on this host;
- a cold typed vector call costs about 2.1–2.5 seconds and 600+ MiB transient
  RSS, while a warm process trades that latency for resident memory;
- untyped `vsearch` downloaded the 1.28 GB expansion model in the trial, so the
  integration must use the SDK's direct lexical/vector methods rather than
  default CLI behavior;
- QMD's public update path rescans configured file collections. Making it the
  live source would introduce a generated corpus, an index-freshness lifecycle,
  and per-update work that grows with collection size.

If semantic misses become an observed problem, evaluate QMD against a labeled
set before integration. Use at least 30 real historical resume cues spanning
exact names, paraphrases, date hints, multi-turn topics, old-inbox cutover
threads, and near-duplicate roots. Compare FTS5, QMD vector-only, and explicit
lex+vec fusion on the same concise corpus. Record top-1 accuracy, recall@5,
false-resume count, p50/p95 latency, peak RSS, backfill time, incremental work,
and bytes. No automatic-resume policy is acceptable if the labeled set contains
even one false resume; ambiguity remains a clarification path.

### Growth behavior and a possible hybrid path

Corpus size and model cost scale differently. The approximately 0.6 GB QMD
process footprint is mostly fixed per loaded embedding model. Stored vector
bytes and cosine comparisons grow with the number of chunks. QMD currently
uses sqlite-vec; its [`vec0` search is brute-force](https://github.com/asg017/sqlite-vec/issues/25),
and QMD exact-scans scoped collections up to 20,000 vectors before using its
broader top-k path. That is comfortable for thousands of concise thread
documents but is not an engine for hundreds of gigabytes of raw transcripts.

At the current rate, the 244-root routing corpus would project to roughly 3,300
roots after one year, about 15 MB of FTS projection, and about 5,500 QMD-sized
chunks. Their 768-dimensional float32 vectors would occupy about 17 MB before
metadata. Even 10,000 one-vector-per-thread summaries require only about 31 MB
of raw vectors. The large growth risk comes from indexing full provider JSONL,
tool output, and repeated assistant text; that material is both expensive and
poor routing evidence, so neither FTS nor vector search should ingest it.

If the labeled evaluation earns semantic retrieval, the proportional design is
a cascade rather than QMD's full default pipeline:

1. Apply Concierge's exact channel, source-time, and current-root eligibility
   before accepting any result.
2. Run FTS5 for exact names, phrases, and identifiers.
3. Invoke direct QMD SDK vector search only when lexical evidence is absent or
   ambiguous. Do not load the query-expansion or reranker models; the Concierge
   router can compare the bounded candidate snippets itself.
4. Keep the SDK process warm only if measured resume-search frequency justifies
   about 0.6 GB of resident memory; otherwise accept the approximately two-
   second cold semantic fallback.
5. Fuse lexical and semantic ranks as candidate evidence. Neither cosine
   similarity nor QMD's relevance score is a calibrated probability that a
   Slack root is the intended destination. Ambiguity still asks the user.

At millions of chunks or a genuinely hundred-gigabyte routing corpus, replace
sqlite-vec's brute-force search with an ANN-capable engine and introduce explicit
retention/tiering. That threshold is far beyond thousands of concise thread
summaries and should not shape today's ownership boundary.

## Other tools considered

| Tool | What it actually provides | Fit for Concierge routing |
| --- | --- | --- |
| [Superpowers](https://github.com/obra/superpowers) | Coding-agent methodology and workflow skills. A whole-repository search at commit `b36e082` found seven non-test/doc transcript/session-search mentions, none implementing session retrieval. | Not a session-search product. The remembered tool was likely AgentMemory or claude-code-tools. |
| [AgentMemory](https://github.com/rohitg00/agentmemory) | Persistent observations, BM25/vector/graph retrieval, hooks, REST/MCP server, multiple ports, queues, consolidation, and dozens of tools. Its `/session-history` skill lists captured session summaries. | Much broader than destination resolution; duplicates lifecycle, memory, and service ownership Concierge already has. |
| [claude-code-tools](https://github.com/pchalasani/claude-code-tools) | Linear keyword scanners for Claude/Codex JSONL plus a Tantivy index over exported sessions and interactive resume tooling. | Useful manual transcript archaeology. Provider-file parsing, no authoritative Slack root mapping, and no semantic retrieval make it the wrong router backend. |
| [Hermes Agent session search](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/sessions.md) | Full messages in SQLite, FTS5 discovery, contextual windows/bookends, lineage dedupe, and reported 15–50 ms discovery. | Strong design reference for cheap exact discovery, but adopting the agent runtime would be disproportionate. |
| [OpenClaw memory search](https://github.com/openclaw/openclaw/blob/main/docs/reference/memory-config.md) | Built-in hybrid memory, optional session export, QMD backend, asynchronous indexing, visibility controls, bounded snippets, and transcript retention settings. | Useful evidence that transcript export, authorization, freshness, and retention are real subsystems—not a helper-script toggle. The platform is far broader than needed here. |
| Claude Code native sessions | Interactive session picker/search and direct resume of known IDs. [Official docs](https://code.claude.com/docs/en/sessions) say JSONL is internal and can change, local CLI retention defaults to 30 days, and the picker is provider/project oriented. | Cannot be Concierge's durable routing source and cannot return Slack `(channel_id, root_ts)`. |
| [sqlite-vec/custom embeddings](https://alexgarcia.xyz/blog/2024/sqlite-vec-metadata-release/index.html) | Direct incremental vector rows and metadata filtering are possible; the maintainer documents both metadata columns and manual prefiltered distance scans. Its [versioning contract](https://alexgarcia.xyz/sqlite-vec/versioning.html) also says bindings are not yet covered by semantic versioning. | Could eventually avoid QMD's file rescan, but would make Concierge own model download/inference, chunking, vector schema, fusion, and compatibility. Not earned by the current incident. |
| Zep/Graphiti or hosted vector DB | Long-term fact/entity memory, temporal graphs, or managed vector retrieval. | Wrong problem and unnecessary service/credential boundary. Routing needs exact thread provenance, not a reconstructed knowledge graph. |

## Retention and scalability policy

For the current personal, single-operator profile:

- Keep the Concierge operational ledger unless a dedicated retention design
  proves which settled fields can be removed without losing recovery, replay,
  fork, summary, or Slack identity behavior.
- The FTS projection follows the ledger's rows. It is derived and may be rebuilt
  transactionally; it does not create a second transcript corpus.
- Do not index raw provider JSONL. Provider live retention and permanent archive
  retention remain owned by their provider/backup systems.
- Expose on-demand diagnostics for database bytes, document count, FTS bytes,
  oldest/newest searchable input, and query latency. Do not add an idle monitor.
- Reconsider semantic retrieval when an actual resume cue is not recoverable by
  FTS5, or when a labeled evaluation shows an unacceptable recall rate—not when
  the database reaches an arbitrary size.
- Reconsider ledger compaction when measured database size or backup/restore
  time becomes operationally material. The present 10 MB database is not that
  condition.

## One coherent implementation acceptance contract

If this design is approved, the implementation is complete only when all of
the following ship together:

- FTS5 projection schema, deterministic historical backfill, and transactional
  live maintenance for turn inputs, accepted steering, and delivered TL;DRs;
- exact visible-root derivation shared with existing thread projection logic,
  including per-thread and single-persistent channel modes;
- the `router-actions.sh threads search` command and documented JSON contract;
- hard channel, source-time, and current-root eligibility filters;
- routing instructions that invoke the helper on resume signals and prohibit
  resume-signal-to-new fallback on empty/failed/ambiguous retrieval;
- focused state/search tests for insert, steering, summary, backfill idempotency,
  channel isolation, timestamp cutoff, old-inbox-to-current-router discovery,
  grouping, snippets, malformed queries, and zero-result behavior;
- a regression fixture for the August 12 / September 3 incident;
- one full local gate, one fresh-context review of the complete diff, and exact
  four-lane Slack sandbox acceptance proving the DM message resumes root
  `1786558965.762069` rather than creating a root;
- current architecture, router-helper runbook, and executable-authority docs
  updated in the same commit.

Semantic indexing, provider transcript retention changes, database compaction,
hosted embeddings, new services, and cross-channel global search are explicit
non-goals for that implementation.

## Research provenance

Local code audit:

- No LSP tool is exposed in this Codex environment, so compiler-backed
  reference navigation was unavailable. The audit used case-insensitive `rg`
  across all `bot/src` plus a verification search across the whole repository,
  followed by targeted source reads and read-only SQLite queries.
- The five relevant text-field names matched 96 source lines. The whole-repo
  delete search found only test-fixture cleanup; production source/scripts had
  zero `DELETE FROM turns|sessions` matches.
- Bun's in-memory SQLite accepted an FTS5 virtual table and returned a matching
  probe row before the production-data trial.
- External repositories were cloned read-only at their stated commits and
  searched across the complete relevant source/skill trees.

Readwise sweep terms: `session history search`, `agent conversation retrieval`,
`semantic search personal archives`, `local full text search embeddings`, `QMD
markdown search`, `Superpowers session history`, `transcript search RAG`, and
`BM25 hybrid search small corpus`. Relevant documents included:

- QMD — `01kfd5z0jfygts37tt43qszgpe`
- Hermes Agent — `01kjby66qkd0zvghp2k8zcv997`
- OpenClaw vs. Hermes — `01kpahswd0fhs516a6bcnxdsd4`
- Clawdbot/OpenClaw memory — `01kfywpjx6077j2ca63z7nq06p`
- Linus Lee on personal search — `01gsh0qpt5yrg977fk52hty3j6`
- DeerFlow memory — `01kms1wh6p3c77d25mmyekejrg`
- Zep long-term memory paper — `01jwyah4re82n6sc6v9rfke3cc`

The recurring useful distinction was exact/proper-noun retrieval versus
semantic “what was this about?” retrieval. That supports preserving a cheap
lexical primitive now and evaluating semantic retrieval separately instead of
making a vector index the source of routing truth.
