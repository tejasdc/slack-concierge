# Router session search

Concierge owns historical Slack destination discovery. The DM/inbox router
chooses a channel, then uses `router-actions.sh threads search` for an explicit
or strongly implied resume signal. Candidate evidence is never an automatic
routing decision. Empty, incomplete, unavailable, ambiguous, or non-resumable
evidence requires clarification; it does not authorize a new root. Clearly new
work retains the ordinary route-new behavior without search.

The [helper runbook](../runbooks/ROUTER-ACTIONS.md) owns the CLI/JSON contract.
The [reviewed design and evaluation](../brainstorms/2026-09-03-router-session-search-and-routing.md)
explain the observed August 12 / September 3 misroute and OR/BM25 decision.

## Corpus and write ownership

`router_search_sources` is a SQL view of the authoritative ledger, limited to
ordinary Slack-user `turns.user_text`, provider-acknowledged (`sent`) steering
`user_text`, and `response_tldr` with `delivery_status='delivered'`. Steering
and delivered summaries remain eligible when their owning turn is synthetic;
the synthetic initial prompt itself is excluded.
Each source becomes one `router_search_documents` row, unique by source kind
and source ID. Its turn owns deletion through a foreign key. An external-content
`router_search_fts` table indexes only content. Three document triggers maintain
FTS inside the same transaction; they create no separate application writer.

`state.ts` owns mutations. `startTurn` and `acquireSessionTurn` project the input
inside their acceptance transactions. `markTurnSteeringMessageSent` projects
the exact acknowledged steering row atomically with its status transition.
`markTurnResponseDelivered` projects the TL;DR before committing delivery.
Projection failure rolls back the source transition. Replay preparation,
progress, heartbeats, and provider completion before delivery add no content.

Startup creates and backfills derived state transactionally once per projection
version. Historical and live writes use the same source projector; the version
marker commits with backfill. Current-version startup does not rebuild. Exact
legacy Slack association refreshes only the affected turns' source metadata in
the association owner's transaction. Unproven identities are omitted and make
their eligible search scope incomplete, never silently valid.

`rebuildRouterSearchIndex(db)` reconstructs derived state from the ledger through
the state connection, without changing ledger content or ownership. Recovery
uses that operation at an explicit stopped-service maintenance boundary. It
first restores FTS from its external content so missing postings cannot break
the deletion triggers, then replaces all documents from the ledger in that same
transaction ([SQLite's rebuild contract](https://www.sqlite.org/fts5.html#the_rebuild_command)); the
read helper never migrates or repairs. No replay wrappers, full assistant
responses, outbound payloads, provider JSONL, tools/runtime output, unrelated
Slack history, generated Markdown corpus, embeddings, or QMD state is indexed.

## Slack identity and temporal eligibility

`slack-thread-identity.ts` shares visible-root derivation with thread-summary and
status queries: explicit turn root, then exact input-claim root. Legacy
per-thread rows use their session's thread root. Legacy single-persistent rows
retain the existing visible-message fallback, never the shared provider anchor.
Steering uses its own explicit/claimed root before its owning turn's root.
Exact Slack association can replace a legacy fallback.

The module's read-only reply-session resolver is shared by normal admission and
search metadata. Current channel mode governs ordinary replies into historical
roots; explicit fork/comparison lineage retains isolation. `resumable` requires
an agent-auto channel and a current non-archived owner with a provider UUID.
A running owner may queue a reply through the existing FIFO. Historical session
existence alone does not prove current resumability.

Search requires an exact managed channel and triggering `message_ts`. Both the
source message and visible root must strictly predate that cutoff; an optional
excluded root is matched exactly. Timestamps stay strings in results and use
validated integer microseconds for comparison, without floating-point casts.
Delivered TL;DRs use the latest confirmed Slack delivery-chunk timestamp,
not the input, status card, provider anchor, or local wall clock.

Completeness is checked against eligible ledger sources in the same read
transaction as retrieval. Missing documents/FTS document rows, changed
metadata/text, invalid timestamps, and a missing backfill marker fail closed.
Hit joins revalidate exact source identities. Titles and activity come only
from pre-cutoff sources. Unknown/ambiguous channel names never widen scope.

## Retrieval and cost

Each of 1–8 bounded concepts becomes quoted Unicode word prefixes ANDed within
the concept; concepts are ORed into one bound FTS expression. Hits group by
visible root. BM25 ranks first, user-input evidence next, recency last for ties.
Output includes a bounded best snippet, matched concepts, and explicit score
components. Corpus-relative scores are not probabilities or identity proof.

Default output is five roots, maximum ten; `has_more` reports additional
matching roots. `complete` describes projection integrity, not exhaustive
output beyond that limit or certainty about intent. The router assesses
ambiguity from evidence.

Each source-acceptance mutation projects one source. Legacy association grows
with affected turns' source count. One-time backfill/rebuild grows with the
approved corpus. On-demand queries check eligible channel sources, then use FTS
and bounded candidate-evidence reads. Output, concepts, and snippets are
bounded; database work grows with eligible history/hits. Idle cost is zero.
There is no service, watcher, poller, scheduler, retry loop, or dashboard cache.

`threads stats` exposes document count, oldest/newest source time, database page
bytes, and compressed FTS payload bytes. Bun lacks `dbstat`, so the clearly
labeled payload count excludes B-tree/page overhead. Search reports query
milliseconds. These diagnostics run only on demand.

## Guidance and acceptance

`provider-input.ts` supplies this conditional router contract beside every real
input's exact Slack identity, including steering. It reaches existing provider
sessions without editing another project's instructions. Attachment guidance
preserves both new-post and confirmed-resume paths.

Focused tests cover transaction rollback, the incident root, source mutation
and delivery timing, legacy backfill/association, channel modes, eligibility,
grouping/snippets, malformed input, incomplete state, and actual read-only CLI
execution. The `router-search` sandbox case creates historical and newer
unrelated core roots before starting a cold DM router. It proves one exact
historical reply with the same provider session, then empty/failed/ambiguous
retrieval with clarification and zero destination work. API/ledger evidence,
authenticated lane-browser captures, and zero-unsettled proof bind acceptance
to the controller's exact source/run.

Slack assigns sandbox timestamps. The deterministic fixture asserts production
root `1786558965.762069`; real Slack acceptance records the equivalent sandbox
root and both identities without contacting production Slack.
