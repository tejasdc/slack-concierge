# Readwise and QMD search evaluation

Status: **research and design only**. This document changes no product,
installation, configuration, service, or deployment.

Date: 2026-09-14

## Decision

Keep Readwise Reader's hosted hybrid document search as the canonical retrieval
path for Readwise material. Do not replace it with QMD or build a bespoke search
engine now. Evaluate unmodified upstream QMD later only as a complementary
local/cross-corpus lane after the local Markdown source is complete, fresh,
deduplicated, and mapped to stable Reader document identities.

Duplicate source or derivative index storage is explicitly acceptable. The
decision is driven instead by corpus coverage, retrieval quality, citation
identity, freshness, query-time resource use, and ongoing ownership.

## Objective and requirements

The objective is to retrieve enough genuinely relevant prior reading and
annotation context to support an accurate answer, with stable source identity,
acceptable latency, and low operator failure.

The comparison must judge:

1. Recall and ranking for exact lookup, paraphrase, multi-document synthesis,
   highlight/note questions, and recent material.
2. Source completeness and freshness separately from ranking misses.
3. Stable Reader IDs/URLs for citations and deduplication.
4. Duplicate-result rate when one document has several local representations.
5. Median/p95 warm and cold latency, peak RSS, indexing/update cost, and
   operational failures.
6. Maintenance ownership for exports, watching, embedding, index repair, model
   compatibility, and vector scaling.

Storage capacity is reported for visibility but is not a selection constraint.

## Confirmed Readwise CLI architecture

The inspected `@readwise/cli` 0.5.9 is a thin remote MCP client, not a local
search engine:

- it connects to `https://mcp2.readwise.io/mcp`;
- it turns the server-advertised tool schemas into CLI flags;
- each command connects, calls one hosted tool, and closes;
- its local cache holds tool definitions, not documents, chunks, embeddings, or
  search results.

The observed installed package was about 28 MB and local calls used about
100–110 MB RSS. Observed Reader queries took roughly 1.3–2.1 seconds including
Node startup, network/TLS, hosted processing, and response parsing.

The public contracts expose:

- `reader-search-documents`: hosted hybrid search over Reader documents;
- `readwise-search-highlights`: vector search over highlights, optionally
  combined with fielded text predicates;
- `reader-get-document-details`: canonical Markdown fetch by stable Reader ID;
- `reader-export-documents`: asynchronous Markdown export with an incremental
  `last_updated` cursor.

Readwise's embedding model, chunks, lexical ranker, vector database, fusion,
reranker, freshness SLO, and evaluation corpus are proprietary and unknown.
Only the advertised hybrid/vector behavior is confirmed.

Official references: [Readwise CLI](https://docs.readwise.io/tools/cli),
[Readwise MCP](https://docs.readwise.io/tools/mcp),
[Reader search FAQ](https://docs.readwise.io/reader/docs/faqs/searching), and
[CLI source](https://github.com/readwiseio/readwise-cli).

## Confirmed QMD architecture and cost

QMD 2.8.3 at commit
[`dbfd0b4`](https://github.com/tobi/qmd/tree/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9)
is a local document-retrieval engine:

- SQLite FTS5/BM25 lexical search;
- local embeddings and sqlite-vec KNN scanning;
- query expansion/HyDE;
- reciprocal-rank fusion;
- cross-encoder reranking over up to 40 candidates;
- collection metadata, JSON output, and bounded source reads.

QMD points at existing Markdown directories. It also stores one content-hashed
text body plus FTS postings, chunks, vectors, and caches in SQLite. This
derivative copy is acceptable. Its current sqlite-vec path is brute-force KNN,
not a mature HNSW/IVF ANN index, so vector-query cost grows with chunk count
unless filtered or the vector layer changes.

Observed on a separate 305-document/1,207-chunk session corpus:

| Measurement | Observed value |
| --- | ---: |
| SQLite index | 13.1 MB |
| CPU embedding | ~19m48s |
| Embedding peak RSS | ~1.2 GB |
| First vector query | ~2.4s |
| Warm vector query | ~0.3–0.6s |
| Full expansion/hybrid/rerank query | ~4.3s average |
| Full-query peak RSS | ~4.2 GB |
| Model files | ~2.1–2.3 GB |

These measurements establish operating shape, not Readwise retrieval quality or
future-corpus scaling. In particular, the roughly 640 MB reranker figure is its
model weight file, not 640 MB of permanent new RAM or disk for every query.

## Current local Markdown is not the Reader corpus

The inspected `/root/workspace/vault/Readwise` tree contained 2,748 Markdown
files totaling about 54.2 MB, split between summaries/highlights and full
document content. Those representations repeat titles, metadata, and summaries
without being byte-identical, so indexing the whole tree can give one Reader
item multiple retrieval identities and overweight repeated content.

Reader's current non-Feed Library contained 2,146 documents. The local
full-content map contained at most 1,861 current Reader IDs (86.7%). A complete
comparison of all 1,674 Inbox IDs found only 1,414 locally: 260 were missing.
The Obsidian plugin had ten queued refreshes and the newest Markdown was roughly
five hours stale at inspection time. Its hourly behavior runs only while
Obsidian is open; it is not a continuously supervised canonical export.

Therefore a QMD result miss today is ambiguous: it may be a ranking miss, a
missing source document, a stale export, or a duplicate-representation problem.
Replacing Reader search before separating those causes would optimize the wrong
layer.

## Retrieval evidence

Eight deliberately seeded paraphrase smoke tests against Reader hybrid search
returned the expected document at rank 1 in seven cases and rank 5 in one. This
proves semantic/paraphrase capability; it is selection-biased and does not
estimate production recall or establish superiority over QMD.

FTS5 and QMD full search solve different query shapes. FTS5 uses an inverted
index and is usually milliseconds for names, identifiers, quotations, and
distinctive terms. QMD may generate/expand the query, embed it, scan vectors,
fuse lexical/vector candidates, and rerank them. The extra seconds may improve
paraphrase recall but do not guarantee higher precision.

One external QMD issue reported better recall for vector/hybrid modes than BM25
on a 217-page wiki, while full reranking reduced several metrics. It is useful
evidence that every mode must be evaluated, not proof for this corpus. See
[QMD issue #627](https://github.com/tobi/qmd/issues/627) and
[sqlite-vec ANN issue #25](https://github.com/asg017/sqlite-vec/issues/25).

## Option tradeoff

| Option | Wins | Losses / ownership | Decision |
| --- | --- | --- | --- |
| **Readwise hosted search** | Canonical complete Reader corpus, service-managed freshness, hybrid document search, vector highlight search, stable IDs, no local index operation. | Network/vendor dependence and proprietary ranking internals. | Keep as canonical for Reader material. |
| **Upstream QMD over a corrected export** | Offline/local control, transparent BM25/vector/expansion/reranking, useful cross-corpus search over documents Readwise does not own. | Operator owns complete export, freshness, canonical-file selection, identity mapping, embeddings, model/native compatibility, brute-force vector scaling, and repair. | Evaluate as an augmentation only after the source contract is corrected. |
| **Fork QMD** | Maximum retrieval customization. | Owns upstream merges plus model, native dependency, schema, fusion, and repair changes; no measured blocker requires it. | Reject now. |
| **Build a custom engine** | Exact local behavior. | Rebuilds ingestion, hashing, chunking, FTS, vectors, models, fusion, reranking, metadata, evaluation, observability, and repair. | Reject absent a measured unbridgeable requirement. |

## Smallest decision-changing evaluation

1. Produce one complete timestamped Reader export with one canonical Markdown
   file per Reader document and stable Reader ID/URL metadata.
2. Write 40–60 real past research questions before inspecting rankings,
   stratified across exact lookup, paraphrase, synthesis, highlights/notes,
   recency, and known misses.
3. Judge relevant Reader IDs before running the systems.
4. Compare Reader hybrid, highlight vector where applicable, QMD BM25, QMD
   vector, QMD hybrid without reranker, QMD full, and a deduplicated Reader+QMD
   union.
5. Measure Recall@5/10, MRR, nDCG@10, source support, freshness misses,
   duplicates, cold/warm median and p95 latency, peak RSS, update time, and
   operator failures.

A proposed—not universal—adoption bar is that QMD should add at least ten
percentage points of judged Recall@10 or recover at least 20% of genuine Reader
misses without duplicates or stale false positives erasing the gain. Otherwise
it has not earned the additional operational owner.

## Composition contract

Use `reader-search-documents` for broad Readwise retrieval,
`readwise-search-highlights` when annotations or quotations matter, and
`reader-get-document-details` only for shortlisted evidence. Preserve stable
Reader IDs and URLs throughout.

If QMD later passes the evaluation, point it at the corrected canonical export,
retain Reader identity in its mapping, and union/deduplicate candidates by
Reader ID/URL. Fetch final online evidence from Reader when available. QMD is
especially plausible for cross-corpus material outside Readwise—project docs,
session transcripts, meetings, and notes—but that is augmentation, not evidence
that it should replace Reader's own search.
