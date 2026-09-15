# Agent-session discovery, identity, and communication ownership

Status: **design consultation only**. This brief defines the contract that the
agent-communication and Thinkering session-management designs should compose
with. It changes no runtime behavior and authorizes no implementation,
installation, restart, migration, or deployment.

Date: 2026-09-14

## Decision summary

Make the logical agent-session branch—not a Slack thread, transcript path,
search document, provider alias, or UI entry—the durable unit of continuity.
Use the exact native `(provider, account_scope, native_session_id)` as its
immutable `AgentSession.key` whenever the provider supplies one. Mint a
Thinkering synthetic key only for an ID-less import or a genuinely new
reconstructed session. Bind that key to zero or more transcript replicas,
explicit lineage edges, and optional Slack/live-runtime bindings.

The five owners remain separate:

1. Provider stores and import pipelines own raw transcripts.
2. Thinkering core owns the canonical session catalog, `AgentSession.key`,
   cross-source lineage, and the transport-neutral addressed-request contract.
   It stores metadata and evidence locators. It need not minimize bytes elsewhere
   or forbid a search product from keeping the transcript copy its own recovery
   model requires.
3. The current runtime coordinator owns admission and recovery for each live
   session. Concierge remains that owner for sessions it already manages and
   owns their Slack bindings/projection; provider adapters supply native runtime
   capability evidence. No session has two admission writers.
4. A replaceable search backend owns its private index, normalized corpus, and
   any source mirror required for its integrity/recovery, keyed back to
   `agent_session_key` and exact evidence references. Those copies may be large;
   storage capacity is not a selection constraint for this personal system.
   The backend still does not own canonical identity, live capability, lineage,
   or communication admission. No backend has yet earned final selection.
5. Thinkering's application/UI layers own the primary discovery and
   session-management experience. Their cards, filters, attention state, and
   local cache are projections, not provider continuity or live capability
   proof.

Agents follow one explicit sequence: search by requirements, decisions, topic,
or demonstrated expertise; inspect bounded source-grounded context; inspect the
exact node's lineage and current capabilities; then address one exact
`agent_session_key`. Search ranking never chooses a communication target. This
ownership split adopts the
[Thinkering-first session-interface contract](2026-09-14-thinkering-first-agent-session-interface.md)
and supplies the more exact discovery/evidence seam it needs.

## Stateful shape and invariants

This is a composition of three stateful shapes, not one aggregate:

- The `AgentSession` node is a durable agent thread. A live provider binding
  supplies native tools, turns, steering, checkpoints, and resumable continuity;
  an imported node records historical continuity without claiming a live agent.
- Messages accepted into one session form an ordered stream. Existing
  per-session FIFO remains the one admission boundary.
- Thinkering's UI may keep a local-first projection for responsive navigation,
  but reconciliation never grants a stale card permission to resume or contact
  a session; the session coordinator revalidates adapter capability.

The invariants are:

1. One immutable session key names one logical session branch.
2. Transcript replicas, Slack roots, and UI entries are bindings or projections;
   none can silently become the canonical identity.
3. A discoverable session is not necessarily resumable or messageable.
4. Search and context may read source material; they do not mutate it.
5. A communication request addresses one exact session node and carries one
   stable operation identity. Retries recover that operation rather than choose
   another node.
6. Forks remain distinct sessions connected by proven lineage. Copies of the
   same transcript are replicas, not forks.
7. A source-grounded claim about requirements, decisions, or expertise carries
   exact evidence. Generated labels are aids, never authority or permission.

## Canonical identity

Do not add a surrogate UUID to sessions that already have a durable native
identity. The canonical key is a tagged value:

```text
agent_session_key
  native
    provider_id                 codex | claude-code | chatgpt | ...
    provider_account_scope      stable local profile/account namespace
    native_session_id           exact provider conversation/session ID

  synthetic
    synthetic_session_id        Thinkering-owned opaque UUID
    reason                      id_less_import | reconstruction
```

This key is independent of Slack, any particular Thinkering client or sync
replica, provider host, transcript path, title, and mutable transcript content.
Thinkering catalogs bindings around it:

```text
slack_binding[]               channel_id + visible root_ts + binding status
runtime_binding[]             managed adapter + host/profile + provider ID
source_replica[]              registered transcript/export artifacts
lineage_edge[]                parent/child relationship with proof
```

For Concierge-created Claude and Codex sessions, the exact provider UUID is the
native identity when it is durably bound. For an imported export, use the
provider's conversation ID inside that export when present. If a format has no
stable upstream ID, persist a synthetic catalog UUID at first import and retain
an import-manifest alias. A path, timestamp, title, or whole-file content hash
may support deduplication but must not alone define logical identity.

The uniqueness boundary is the provider identity within its stable
account/profile scope. This prevents accidental collision between two accounts
while allowing a Mac live file, its AX41 archive copy, and a later re-export to
resolve to the same `agent_session_key`.

A universal surrogate UUID would provide a uniform-looking foreign key, but it
would not improve retrieval, replica deduplication, bindings, or lineage when
the native tuple already supplies a stable endpoint. It would add a mapping and
identity-migration state for every session. The synthetic branch exists only
for the operations the native tuple cannot represent. Search reports this key;
it never assigns or changes it.

Bindings are zero-to-many. One shared provider session may be projected through
several Slack roots, and historical roots may no longer own current admission.
Each Slack binding therefore records whether it is a historical association, a
current projection, or an eligible admission surface. There is no canonical
Slack root implied by `agent_session_key`. Every Slack-projected request retains
the exact selected binding and visible root; the service never infers a return
conversation from provider-session identity alone.

Ambiguous imports do not merge. They remain separate catalog nodes with an
explicit possible-duplicate relation until exact native identity or operator
evidence resolves them.

## Exact source evidence

Search results must point back to the evidence that produced them. A durable
evidence reference contains:

```text
evidence_ref
  agent_session_key
  source_replica_id
  provider_event_id?          preferred when the format supplies one
  role                        user | assistant | tool | system | developer | other
  ordinal                     stable event order within the logical session
  source_locator              JSONL record/byte range or export record locator
  text_hash                   verifies the normalized matched event
  observed_source_version     source generation/hash used by retrieval
```

`source_replica_id` identifies a registered live file, archive file, or export
record. A current filesystem path is a resolvable location for that replica, not
the evidence identity. The resolver may choose another verified replica when a
live file moves or ages into the archive.

For append-only live transcripts, event identity plus ordinal/text hash remains
stable while the enclosing file grows. When the provider has no event ID, the
normalizer assigns the ordinal and text hash deterministically. If neither the
original nor a verified replica can resolve the evidence, context reports it as
unavailable; it never substitutes similar text from another session.

The catalog may retain a bounded display snippet and hashes/locators instead of
becoming a transcript store itself. A search backend may retain complete raw or
normalized copies when that makes ingestion, evidence resolution, or recovery
more reliable. Such a copy must preserve source provenance and have an explicit
ingest/repair direction; it does not become the canonical session identity or a
second runtime writer. Duplicate bytes are acceptable. Ambiguous authority or
two-way mutation is not.

## Search corpus and retrieval contract

The searchable representation must preserve enough of a session to understand
what Tejas and the agent actually did, not merely recognize its title. Its
primary dialogue lane contains:

- every genuine user request, steering/follow-up input, and correction;
- every supplied or locally generated voice transcript, including audio-only
  inputs;
- user-visible assistant commentary and final answers, not only delivered
  TL;DRs;
- explicit artifact, document, issue, and commit references surfaced in that
  dialogue;
- optional derived session summary, requirement, decision, and expertise facets,
  each linked to one or more `evidence_ref` values.

A separately tagged secondary lane may retain and search tool calls/results,
runtime operations, and non-boilerplate system/developer material. That material
often proves which code, command, error, or artifact was actually involved, so
discarding it globally would weaken implementation and expertise discovery. It
must remain distinguishable by role/source and should not displace clearly
relevant human-agent dialogue in the default ranking. The caller may request or
boost it for diagnostic or implementation-detail queries.

Normalization excludes transport/provider/Slack/router envelopes, replay and
attachment wrappers, repeated skill/plugin catalogs, hidden reasoning, and
duplicated cumulative summaries already represented by their underlying turns.
These are representational duplicates or control material, not session content.
The backend must expose matched role/source so callers can explain which lane
produced a result.

The logical read interface is UI-neutral:

```text
search_sessions(query, filters?, before?, limit?) -> candidates
get_session_context(agent_session_key, evidence_refs?, bounds) -> context
describe_session(agent_session_key) -> identity, lineage, capabilities, bindings
```

Each candidate includes the exact `agent_session_key`, provider, date/title,
workspace/project when known, matched roles and concepts, exact evidence
references, source completeness/freshness, lineage summary, and current
capabilities. Search supports global discovery first; provider, project, date,
source kind, and capability are optional filters.

Hybrid retrieval supplies candidates:

- lexical retrieval protects exact requirements, names, identifiers, and quoted
  decisions;
- semantic retrieval broadens recall for paraphrases and expertise queries;
- results collapse duplicate message hits and transcript replicas at the session
  node, never across distinct fork nodes;
- scores are corpus-relative evidence, not confidence that a session is the
  desired communication target.

The backend reports whether its source inventory and index are complete for the
requested scope. Stale, partial, or unavailable retrieval remains usable only
when clearly labeled; it cannot authorize an automatic contact decision.

## Context sufficiency before contact

Search snippets alone are insufficient for agent-to-agent discovery. Context for
a plausible candidate should return, within a bounded token budget:

1. The matched event and adjacent genuine dialogue turns, with its role/source.
2. The session opening request or earliest available goal statement.
3. Relevant requirement/decision/expertise facets with exact evidence refs.
4. The most recent user-visible outcome relevant to the query.
5. Referenced durable artifacts or commits, plus bounded relevant tool evidence
   when it is necessary to establish what the session actually did.
6. Omissions, unavailable evidence, source freshness, and whether more context
   exists.

The caller may ask for another exact evidence window, but must not receive an
unbounded transcript dump by default. The adequacy test is behavioral: an agent
should be able to state why this session is relevant, what it previously decided
or delivered, and what remains uncertain before sending a message.

The present `threads context` command does not satisfy this contract. It returns
only accepted input, acknowledged steering, and delivered cumulative TL;DR
fragments from Concierge's routing projection. It omits full assistant dialogue,
voice-only transcript material, imported sessions, and provider evidence
locators.

## Live and imported-session capabilities

Capabilities are independently derived facts, not one `status`:

| Session class | Search | Source context | Native contact or reconstruction | Live controls |
| --- | --- | --- | --- | --- |
| Concierge-managed live Claude/Codex session | Yes | Yes | Yes, through exact managed binding and FIFO | Current Stop/fork/retry rules when applicable |
| Discovered live provider session not managed by Concierge | Yes | Yes | No by default; may expose `attachable` only when an adapter proves exact native identity and environment | None until explicitly attached |
| Managed session marked archived/unavailable | Yes | Yes while source evidence remains | No native contact; a consultation request may create a labeled reconstructed child when evidence is sufficient | None |
| Imported Mac Claude/Codex transcript | Yes | Yes | No native contact by import alone. Exact live identity may restore a binding; otherwise a consultation request may create a labeled reconstructed child | None by import alone |
| Imported ChatGPT export | Yes | Yes | No native contact. A consultation request may create a labeled reconstructed child; future native ChatGPT contact is a separate adapter decision | None |
| Partial or corrupt import | Clearly labeled partial candidate at most | Only verified windows | No | None |

The catalog should expose booleans/reasons such as `searchable`,
`context_available`, `resumable`, `messageable`, `consultable`,
`reconstructable`, `forkable`, `stoppable`, and `attachable`, plus fidelity,
reason, and the evidence time at which each was derived. Thinkering may render
these compactly but must not infer one capability from another.

An imported transcript is historical knowledge, not a sleeping agent. The
system cannot contact a ChatGPT export or an archive copy. An addressed request
whose explicit effect is `consult` may authorize the coordinator to create a
read-only, source-cited reconstructed child when the evidence is sufficient; the
receipt must return that child's new identity and fidelity. A mutation request
cannot cross this boundary without a separately proven runnable environment and
required confirmation. Neither path is described as a native resume.

## Lineage and branch selection

Lineage is a graph of logical sessions. Proven edge kinds include:

- `forked_from` with exact provider/Concierge branch-point evidence;
- `reconstructed_from` when a consultation child is materialized from an
  imported or unavailable session's source-backed context;
- `continued_from` when a new working session is explicitly created from another
  session without claiming native continuity;
- `supersedes` only when the user or owning workflow records that relationship.

Replica and possible-duplicate relations are source/catalog relations, not
conversation lineage. Text similarity never creates a lineage edge.

Search may visually group nodes by lineage but must return each branch's exact
identity and evidence separately. Communication always names one node. If a
query matches common pre-fork history and several descendants are addressable,
the caller sees their branch points, dates, latest outcomes, and capabilities and
selects one. “Newest,” “currently active,” and “same Slack channel” are not valid
implicit branch-selection rules.

Following an imported node to an existing live descendant is permitted only when
the caller explicitly asks for the current continuation and one proven lineage
path identifies it. Otherwise the imported node remains non-messageable. A new
`consult` request may create a reconstructed child under the rule above, but it
cannot silently select one of several existing descendants.

The current `sessions.parent_session_id` and `parent_message_idx` cover
Concierge-managed fork ancestry. They do not establish lineage for external
provider forks, imports, re-exports, or cross-provider continuations; the broader
catalog graph is proposed work.

## Session-addressed communication

The transport-neutral session coordinator should accept the durable session
identity rather than requiring the caller to know a Slack destination. The
Thinkering-first design's `AddressedRequest` needs these exact provenance fields:

```text
AddressedRequest
  request_id
  target_agent_session_key
  source_input_ref
  source_action_id
  sender_actor
  source_agent_session_key?
  target_interaction_ref?
  reply_to_interaction_id?
  content_parts[]
  cited_evidence_refs[]
  requested_effect             consult | propose | mutate
  return_expectation           none | reply | settlement
```

The session coordinator records the request before asking the one current
runtime coordinator to resolve native capability. For Concierge-managed
sessions, Concierge remains that runtime owner and serializes admitted work
through its existing target-session owners. The immutable request retains the
durable target session identity, the source session identity when an agent sent
it, any reply relationship, the sender's exact input/action provenance, the
selected projection or interaction context, requested effect/fidelity, and
exact cited evidence.

`source_input_ref` is a service-issued, Slack-independent identity for the exact
accepted input that authorized the send. `source_action_id` is unique within
that input, preserving the current `(source input, action ID)` idempotency
boundary. A Slack-originated operation derives the source input from the exact
channel/message timestamp already admitted by Concierge. A Thinkering-originated
operation first admits an authenticated operator input and receives its opaque
`source_input_ref`; it does not manufacture a Slack message. A peer agent also
supplies its `source_agent_session_key`, which the coordinator validates against
that input rather than trusting caller prose. `request_id` remains the stable
transport-neutral request identity; the coordinator enforces that one
`(source_input_ref, source_action_id)` pair cannot name two request IDs.

Live steering remains narrower than session addressing. A message may steer
only when `target_interaction_ref` proves the exact currently running turn or
its exact selected surface/root and the existing steering controller accepts
it. The Slack adapter derives that context from the addressed visible root; a
Thinkering live-session view receives an opaque current interaction reference
from the session coordinator and revalidates it at send time. Without that exact
context—or when it has gone stale—the request becomes an ordinary new turn
admitted or queued under the target session's existing FIFO. Session identity
alone never selects an active turn to interrupt.

Slack is then an optional projection:

- If the request selected an eligible Slack binding, existing publication may
  mirror the addressed input and output at that exact root with provenance.
- If Thinkering is the primary surface, its conversation view renders the same
  request/result identities without manufacturing a Slack root.
- A Slack-originated `resume` becomes an adapter that resolves the exact Slack
  binding to `agent_session_key` before admission. Session-addressed callers do
  not perform the reverse lookup themselves.

The proposed transport-neutral receipt's `recorded` disposition proves durable
request/return-obligation recording only; later `request.admitted`, provider
acknowledgement, and completion are separate events. On the current Slack helper,
only `status=admitted` proves its existing combined publication/input-admission
contract. An unresolved receipt is inspected by its same request ID; retry does
not mint a new action or target. Peer communication cannot grant missing human
authorization or transfer repository/resource ownership.

The in-progress agent-communication design's proposed `reply <request_id>` is
compatible: `reply_to_request_id` can derive the exact return
`agent_session_key`, source input, and selected interaction/projection context.
Its ordinary `resume <channel> <root>` path is not the durable identity contract
for newly discovered sessions and should become a Slack adapter, not the core
addressing model. This brief composes with the
[September 11 observation-led communication proposal](https://github.com/tejasdc/slack-concierge/blob/63c92a9b10445947f4a5f18dc418157e7d625802/docs/plans/2026-09-11-agent-communication.md)
and the continuing design discussion in
[the agent-session communication thread](https://tejazz.slack.com/archives/C0BNN5K4JSJ/p1789154481755879).

## Thinkering integration boundary

The request that Thinkering become the primary session-management surface is a
product decision this contract supports:

- Thinkering core owns `AgentSession.key`, catalog metadata, explicit lineage,
  and the transport-neutral coordinator contract.
- Thinkering's application/UI layers query the catalog/search interfaces and own
  presentation, user-curated working sets, attention/done state, filters, branch
  navigation, and the explicit “contact/continue” action.
- One current runtime coordinator owns capability, admission, provider execution,
  and recovery for each live binding. Concierge keeps that authority for the
  sessions it already manages and owns their Slack adapter/projection.
- The search backend supplies candidates/evidence only.
- Provider/import stores retain the raw history.

Thinkering's “Done” or hidden state must remain per-user projection state. It
does not archive, delete, or make the underlying agent session non-messageable.
A stale Thinkering cache may display the last known state, but every action
revalidates the exact session key through the session coordinator and asks the
current runtime adapter for live capability.

This composes directly with the merged
[Thinkering-first session-interface design](2026-09-14-thinkering-first-agent-session-interface.md),
which supersedes the Slack-primary surface recommendation in the earlier
[session-management brainstorm](2026-08-24-slack-agent-attention-and-progress.md).
The older document remains valuable for projection, notification, and
attention-state lessons; the dedicated channel can be an optional secondary
projection if still desired. It must not become another identity or transcript
store.

## Search-backend boundary

### Decision objective and requirements

The optimization function is not “minimize storage” or “install the strongest
search engine.” It is to minimize the time from “I remember a session where we
did or decided X” to a correctly identified session, enough exact evidence to
understand and distinguish it, and a safe action on that exact session when it
is genuinely live.

Hard requirements:

1. Cover Claude Code and Codex across Mac and AX41 live/archive sources, plus
   future ChatGPT exports. Global search discovers the project/provider; those
   are optional filters, not prerequisites.
2. Preserve every genuine user input, follow-up, steering correction, and voice
   transcript, plus every user-visible assistant response—not only roots or
   TL;DRs.
3. Retain role-aware access to useful tool/runtime evidence for implementation
   queries without allowing boilerplate envelopes, system prompts, or duplicated
   summaries to swamp normal dialogue retrieval.
4. Retrieve by requirements, decisions/rationale, topics, artifacts, and
   demonstrated expertise using lexical and, where it proves value, semantic
   signals.
5. Return provider/project/date/title, exact session key, matched role/source,
   exact evidence locator, completeness/freshness, and bounded surrounding
   context sufficient to distinguish similar candidates.
6. Preserve distinct forks, continuations, reconstructed consultations, and
   duplicate replicas; never choose a branch merely because it is newest or
   highest-scoring.
7. Distinguish live/resumable/messageable sessions from imported historical
   evidence and revalidate capability before contact.
8. Keep canonical identity, lineage, live capability, authorization, and
   communication admission outside the replaceable search backend.
9. Remain reliable for the actual single-operator corpus as it grows to
   thousands of sessions and potentially hundreds of gigabytes. Scaling claims
   require measured cardinalities and algorithmic explanation.

Selection preferences and constraints:

- Prefer a maintained open-source product and a small adapter/upstreamable seam
  over a private fork or owned provider-parser/indexing system.
- Duplicate raw or normalized storage is acceptable—even at tens or hundreds
  of gigabytes—when it improves preservation, provenance, or recovery. Report
  capacity for awareness, not as the optimization objective.
- Query-time RAM, latency, and failure modes matter only when they impair
  interactive use or host stability.
- Semantic sophistication is valuable only when the representative evaluation
  shows better session-level discovery than cheaper lexical retrieval.
- Keep current Concierge FTS fail-closed and narrow for Slack routing; the new
  discovery corpus must not weaken that operational guarantee.

No inspected option meets every hard requirement unchanged:

| Option | Where it wins | Where it loses | Decision consequence |
| --- | --- | --- | --- |
| **Current Concierge FTS/router context** | Already deployed, deterministic, cheap, global across Concierge-managed Slack roots, and fail-closed for routing. | It indexes only accepted turn inputs, acknowledged steering inputs, and delivered cumulative TL;DRs. It omits full assistant dialogue, broad tool evidence, imported/archive-only sessions, provider-native identity, semantic retrieval, and general session context. | Keep as the operational routing baseline and fallback. It cannot satisfy the requested cross-session understanding/discovery contract. |
| **Episodic Memory unchanged** | Already parses Claude, Codex, Cursor, OpenCode, and OMP into paired user/assistant exchanges; exposes semantic plus text search, multi-concept search, `session_id`, source path/line ranges, sidechain metadata, and a conversation reader. Its private archive makes its indexed evidence durable. This is the closest current match to dialogue-shaped retrieval and bounded context. | It does not currently ingest ChatGPT exports; source discovery is harness-specific; text search is tokenized AND-like rather than a strong lexical ranker; evidence remains archive-path/line based; it does not own live capability or cross-provider catalog identity. | Strongest dialogue-oriented comparator. Its copied archive is acceptable, not a blocker. Adopt unchanged only if provider/import coverage and measured ranking are sufficient; otherwise prefer a narrow upstream adapter/output seam over a fork. |
| **CASS unchanged** | Broadest inspected connector coverage (23 agents in its current contract, including advertised Claude, Codex, and ChatGPT support), incremental lexical and semantic retrieval, robot output, source `view`/`expand`, health/diagnostics, and a content-addressed hash-verified mirror tied directly to reconstruction and parser correction. | The default corpus includes a large proportion of system/tool/developer material; current search JSON omits normalized role and internal provider `external_id`; identity is path/internal-record oriented; and its archive/index machinery is broader than a pure search library. | Provisional evaluation leader for source breadth and lowest parser ownership now that duplicate storage is acceptable. Its retrieval can be evaluated unchanged, but its current result contract cannot meet exact identity/evidence requirements without a stable adapter join or additive output fields. Its recovery mirror is a benefit or neutral cost, not a reason to reject it. |
| **CASS with custom “index-only/dialogue-only” changes** | Role-aware retrieval or richer result fields could close a measured ranking/explainability gap while retaining CASS's connectors. | There is no confirmed general index-only setting. Removing raw mirroring discards a documented recovery guarantee and changes archive-first indexing, coverage, doctor, and reconstruction paths. Strict dialogue-only indexing can also hide useful tool evidence. Any private change creates fork maintenance. | Reject index-only: it buys nothing under the corrected storage requirement and loses recovery. Consider only narrow role-aware filtering/weighting or result-field changes after an evaluation proves they are necessary, and prefer upstreamable changes. |
| **QMD over a normalized session projection** | Mature document retrieval composition: BM25, vectors, query expansion, reranking, collection context, JSON output, document fetch, and line-bounded reads. It is content-source agnostic and can search globally or by collection. | QMD does not parse agent transcripts, identify roles, understand sessions/forks, expose provider IDs, or report live capabilities. We would own normalization, source watching, deduplication, identity mapping, and evidence translation. Local model loading adds meaningful query-time RAM/latency, and its current sqlite-vec path scans vectors rather than providing a proven large-corpus ANN strategy. | Treat QMD as a retrieval engine, not a session solution. Choose it only if measured hybrid/semantic quality materially beats session-native products enough to justify owning the missing ingestion/catalog layer. Copied normalized content is not a negative by itself. |
| **claude-code-tools / Tantivy search** | Directly indexes Claude and Codex JSONL; emits native session UUID, provider, project, timestamps, and snippets; lexical search is cheap and operationally simple. | It has no semantic retrieval or ChatGPT connector; its searchable Claude corpus includes tool inputs/results without the required role-aware session view; result evidence is session-level and path-based rather than exact role/event identity. | Keep as the lowest-complexity lexical baseline. It does not satisfy the complete contract, but establishes how much semantic retrieval and richer context must improve actual discovery. |
| **Thin normalizer/catalog plus FTS/vector libraries** | Maximum control over provider identity, role-aware fields, exact evidence, lineage integration, ranking, and context shape. It can preserve all source material and present dialogue/tool lanes exactly as required. | We would own every provider parser, import migration, dedup rule, watcher, index lifecycle, ranking composition, and retrieval API—the largest maintenance and correctness burden. Existing libraries already solve large parts of this. | Last resort only after the existing-product evaluation demonstrates a concrete unbridgeable requirement. Do not bootstrap a bespoke session-search system merely because customization is possible. |

The alternative inspections used Episodic Memory commit
[`7e06519`](https://github.com/obra/episodic-memory/tree/7e06519357777badd7a115d2014a7ef845904310),
QMD 2.8.3 commit
[`dbfd0b4`](https://github.com/tobi/qmd/tree/dbfd0b4736aeaf761d1a16ca8e424f071df8feb9), and
claude-code-tools commit
[`ee0f309`](https://github.com/pchalasani/claude-code-tools/tree/ee0f3099c05c50141feff2559193c0af1fb81ec7).
Episodic Memory's current
[schema](https://github.com/obra/episodic-memory/blob/7e06519357777badd7a115d2014a7ef845904310/docs/SCHEMA.md)
stores paired user/assistant dialogue, native session ID, archive path, and line
ranges. Its
[architecture](https://github.com/obra/episodic-memory/tree/7e06519357777badd7a115d2014a7ef845904310#how-it-works)
also explicitly copies source conversations to its own archive before indexing.

QMD resource cost is measured, not merely described as “heavier.” On the prior
305-document/1,207-chunk local session corpus, its SQLite index was 13.1 MB,
embedding took 19m48s at roughly 1.2 GB peak RSS, a first vector query took about
2.4 seconds, warm vector queries took 0.3–0.6 seconds, and a full
expansion/hybrid/rerank query averaged about 4.3 seconds with roughly 4.2 GB peak
RSS. Its three model files total roughly 2.1–2.3 GB. These measurements are a
small-corpus operating-cost sample, not a quality result or future-scale
forecast; the representative evaluation must measure recall and cost together.

### What CASS actually provides

The CASS inspection used upstream commit
[`7c959c5`](https://github.com/Dicklesworthstone/coding_agent_session_search/tree/7c959c591e0d4568f3fc72a44689cdb6a448be40).
Its differentiated value is broad provider parsing plus an integrated local
archive, lexical/vector indexes, agent-oriented machine output, context
expansion, and diagnostics. It does not provide the Thinkering session catalog,
Slack-independent communication identity, live capability truth, or the exact
evidence contract above.

The raw mirror is not unexplained cache overhead. CASS treats SQLite as its
archive of record after ingestion and treats provider logs as pruneable upstream
inputs. Its
[recovery runbook](https://github.com/Dicklesworthstone/coding_agent_session_search/blob/7c959c591e0d4568f3fc72a44689cdb6a448be40/docs/planning/RECOVERY_RUNBOOK.md#archive-ownership-and-trust-boundaries)
uses content-addressed, hash-verified pre-parse source bytes to rebuild after
source deletion, database/index failure, or a future parser correction. Normal
indexing captures those bytes
[before connector parsing](https://github.com/Dicklesworthstone/coding_agent_session_search/blob/7c959c591e0d4568f3fc72a44689cdb6a448be40/src/indexer/mod.rs#L30473-L30523).
Removing the mirror means CASS can no longer make that recovery promise. Our
existing transcript archive also preserves source bytes, so the two copies
overlap in capacity. They do not provide identical behavior: the CASS mirror is
content-addressed, hash-verified, captured before parsing, and integrated with
CASS coverage manifests, diagnostics, parser correction, and reconstruction.
That coupling is useful even when another archive exists. Because duplicate
storage is acceptable for this personal system, there is no product reason to
remove the mirror or require CASS to replace the existing archive.

The local five-session sample makes capacity concrete: CASS's raw mirror
was 95,993,374 bytes and its SQLite archive was 21,512,192 bytes, excluding the
82,512,810-byte lexical index, 9,766,262-byte vector index, and 91,335,811-byte
downloaded model. These figures describe that sample, not projected production
growth, and they do not count against CASS in the option ranking.

CASS does parse roles internally:
[`MessageRole`](https://github.com/Dicklesworthstone/coding_agent_session_search/blob/7c959c591e0d4568f3fc72a44689cdb6a448be40/src/model/types.rs#L6-L14)
distinguishes user, agent, tool, system, and other. That is not the same as
proving “genuine dialogue”: a provider's user-role envelope or injected message
may still require source-specific exclusion. Current
[`SearchHit`](https://github.com/Dicklesworthstone/coding_agent_session_search/blob/7c959c591e0d4568f3fc72a44689cdb6a448be40/src/search/query.rs#L1616-L1648)
does not serialize the role, so an integration cannot enforce or explain the
dialogue policy from search output. Role output is therefore necessary but not
sufficient; the parser/normalizer must also classify genuine dialogue.

The same sample contained 10,890,732 normalized message bytes. Tool and
developer rows contributed 10,138,892 bytes (93.1%); user and agent rows
contributed 751,840 bytes. This is not a storage objection and it does not prove
a universal ranking problem. It is evidence that representative tests must
measure whether default ranking is swamped by control/tool material and whether
role-aware weighting or filtering improves session-level recall without hiding
useful implementation evidence.

CASS also already stores an internal provider `external_id` on a conversation.
The problem is narrower: current search/session JSON does not expose that ID.
An unscoped provider ID is insufficient, but the exact
`(provider, account_scope, native_session_id)` tuple is a stable endpoint for
replicas, bindings, and lineage edges. A universal Thinkering UUID would not
improve search and would add mapping/dedup/migration state. Therefore the native
tuple remains canonical wherever available; the catalog mints a synthetic key
only for an ID-less import or reconstruction. CASS should expose its stored
external ID so the adapter can construct the native key directly.

### Current recommendation

The previous recommendation was driven by a false constraint: minimizing
duplicate transcript bytes. Remove that constraint rather than compensating for
it with an index-only CASS fork or switching reflexively to another product.
The corrected recommendation is:

1. Evaluate **CASS with its archive/recovery model unchanged** as the
   provisional retrieval leader. Its broad provider ingestion (including
   advertised ChatGPT support), integrated lexical/semantic search, context,
   machine interface, diagnostics, and source-bound recovery eliminate more
   custom ownership than any other inspected option. Accept its archive copy.
2. Evaluate **Episodic Memory unchanged** as the strongest dialogue-oriented
   comparator. It may rank and explain conversational sessions better out of
   the box, but its narrower provider/import coverage must be measured rather
   than assumed away. Accept its archive copy too.
3. Evaluate **claude-code-tools/Tantivy**, **QMD over a normalized projection**,
   and **current Concierge FTS** as the low-complexity lexical, high-capability
   retrieval-engine, and deployed routing baselines respectively.
4. Do not build an index-only CASS mode. The complete contract needs CASS's
   already-stored role and external/native session ID exposed to machine
   consumers. Prefer two additive upstream output fields and, if measured
   ranking requires it, an optional role filter. If an adapter can join those
   fields through an existing stable session endpoint, that is also sufficient;
   do not fork merely to expose them or reduce storage.
5. Select the winner only after the same representative corpus measures
   session-level top-one/top-three recall, context sufficiency, exact evidence
   completeness, indexing/query latency and peak RAM, supported-source coverage,
   recovery behavior, and required upstream/fork changes. Storage bytes are
   reported for capacity planning, not optimized as a product objective.
6. Prefer the unchanged existing product that passes. Build a thin
   normalizer/catalog search implementation only if every product fails a named
   acceptance criterion that cannot be closed through a narrow upstreamable
   seam.

This is a recommendation to continue the feature through a comparative
evaluation, not to pause it indefinitely. The immediate decision is not “CASS
versus Episodic Memory” in the abstract; it is whether unchanged CASS's broader
coverage and unchanged Episodic Memory's stronger dialogue representation each
meet the same observed discovery tasks.

Until that comparison exists, do not claim semantic retrieval automatically
beats lexical search, that dialogue-only always improves results, or that a
larger recovery archive is harmful.

The comparison should therefore measure:

1. Session-level top-one/top-three recall for requirement, decision, topic,
   implementation-detail, and expertise queries.
2. Whether the returned evidence is enough to distinguish similar sessions and
   select the correct branch.
3. Coverage and fidelity across live/archive Mac and AX41 Claude/Codex sessions
   and future ChatGPT exports.
4. Indexing latency, interactive query latency/peak RAM, recovery behavior, and
   maintenance/upstream changes.
5. Capacity bytes for operational awareness, without treating duplication as a
   failure.

The original generated CASS sample and result files were ephemeral. Its
lexical-OR 5/5 top-one and semantic-paraphrase 3/5 top-one, 5/5 top-three results
are directional only, not sufficient to select the backend.

### Independent Claude Code Opus opinion

A fresh Claude Code Opus session received the requirements, option inventory,
and observed evidence above without receiving or inspecting this design. It was
asked for an independent recommendation, not a review. Its conclusion aligned
on the core backend choice and sharpened four boundaries:

1. **Choose CASS plus a separate small catalog**, retaining CASS's raw mirror.
   Additively expose `role` and `external_id` in machine output and optionally a
   role filter; reject index-only. CASS wins over QMD today because multi-format
   connector ownership is a known recurring cost while QMD's superior retrieval
   architecture has not yet demonstrated superior retrieval on this corpus.
2. **Treat QMD as the strongest retrieval-quality challenger**, not the leading
   session product. Episodic Memory is the strongest dialogue-shaped challenger
   but fails current ChatGPT coverage; Tantivy is a cheap lexical baseline;
   custom search is the highest-maintenance fallback; current Concierge FTS
   should remain deliberately narrow and unextended.
3. **Partition by role rather than deleting tool evidence.** Default natural-
   language discovery to user/assistant turns; retain labeled opt-in tool
   content for error, command, artifact, and implementation queries; exclude
   boilerplate system/developer prompts and runtime envelopes from default free-
   text retrieval. It identified unlabeled hits—not raw byte share—as the
   confirmed interpretability failure. The 93.1% tool/developer byte share is a
   hypothesis about ranking noise until top-result role composition is measured.
4. **Use native identity first.** The native provider/account/session tuple is
   already sufficient for replicas, lineage endpoints, bindings, and live
   addressing. Mint a synthetic catalog key only where no stable native ID
   exists. A universal surrogate UUID would add mapping state without improving
   retrieval or identity.

The independent opinion is conditional on one major unverified claim: CASS's
advertised ChatGPT connector must ingest a real export with correct roles,
timestamps, and usable evidence locators. It recommends a 300–500-session frozen
corpus, at least one real ChatGPT export, and 25–40 queries written from memory
before inspecting results. Measure recall@1/@5 and MRR by query category,
top-ten role composition, whether machine output alone identifies the session,
and AX41 p50/p95 latency and peak RSS under normal load. Precommit decision
rules: CASS fails if real ChatGPT ingest fails; QMD earns owned normalization if
it beats CASS by at least 15 recall@5 points on rationale/expertise queries; a
difference below 10 points favors CASS's lower ownership cost; and tool/system
rows above 30% of top-ten hits make role filtering a prerequisite. These numeric
thresholds are proposed evaluation rules, not measured results.

## Confirmed current behavior

The following are current, source-backed facts rather than proposals:

- Concierge's `sessions` table is keyed by Slack channel/root/provider and stores
  `agent_session_uuid`, status, and a limited parent session/message relation.
- One provider session admits at most one running/delivering turn; later accepted
  inputs remain durable FIFO work.
- An input into the exact visible root of a live turn may enter that turn's
  ordered steering path; session identity by itself does not select live
  steering.
- `router-actions.sh resume` addresses an exact Slack channel/root. There is no
  session-addressed send command.
- `threads search` discovers only Concierge-managed Slack roots. Its corpus is
  `turn_input`, acknowledged `steering_input`, and delivered cumulative TL;DR.
- `threads context` exposes only that same bounded routing corpus and exact Slack
  resumability metadata.
- Raw Claude/Codex transcripts already exist in provider live stores and the
  laptop/AX41 archive pipelines; they are not copied into the current router FTS
  projection.
- Provider-session forks created by Concierge retain parent session/message
  metadata and exact provider-specific fork boundaries where supported.
- The conversational session-management channel and agent-to-agent `reply`
  contracts are design branches, not deployed runtime behavior.

Current authorities: [provider sessions](../architecture/PROVIDER-SESSIONS.md),
[router search](../architecture/ROUTER-SEARCH.md),
[routed requests](../architecture/ROUTED-REQUESTS.md), and the
[router helper](../runbooks/ROUTER-ACTIONS.md).

## Proposed changes

This consultation proposes, but does not authorize:

1. A global metadata-only Thinkering session catalog keyed by exact native
   provider identity, with synthetic UUIDs only for ID-less imports or
   reconstructions.
2. Source replica registration and exact evidence resolution across live,
   archived, backend-copied, Mac-imported, and future ChatGPT-export material.
3. Role-aware hybrid discovery and bounded evidence context over complete
   human-agent dialogue plus relevant tagged tool/runtime evidence.
4. Explicit capability/fidelity reporting that separates search, context,
   native resume/send, consultation reconstruction, fork, stop, and attach.
5. A broader proven lineage graph for managed, imported, and cross-provider
   continuations.
6. Session-addressed communication with exact source/target identities,
   exact source-input-scoped idempotency, reply correlation, live-steering
   context, and existing turn/session FIFO admission.
7. Thinkering core as catalog/coordinator-contract owner and its UI as the
   primary discovery/management surface, with Slack as an optional
   binding/projection.

## Conflicts and required design updates

The composing designs must resolve these conflicts explicitly:

1. **Slack-first identity:** current session and routed-request contracts require
   a Slack destination. The requested core identity is Slack-independent.
   Shared sessions can also have several visible Slack roots, so a future
   session-addressed request must retain its exact selected surface rather than
   derive one from the provider session.
2. **Insufficient search corpus:** the current three-source FTS is adequate only
   as a fail-closed Slack-root routing fallback, not as cross-session knowledge
   discovery or context.
3. **Primary surface:** the earlier session-management brainstorm recommends a
   dedicated Slack channel; this request names Thinkering as primary. The merged
   Thinkering-first design resolves this at the design level, but no runtime has
   changed.
4. **Catalog ownership:** the merged Thinkering-first design makes Thinkering
   core the canonical identity/lineage owner. Any communication or search draft
   that makes Concierge or CASS the global catalog must change; Concierge stays
   authoritative for its live runtime records and Slack bindings.
5. **Imported contactability:** imported Claude/Codex transcripts and ChatGPT
   exports are discoverable evidence, not automatically resumable agents. An
   explicit consultation effect may produce a new, labeled reconstructed child;
   it does not make the imported node native or messageable.
6. **Lineage scope:** current parent fields describe Concierge-created forks,
   not all imported/external branches or explicit continuations.
7. **Backend ownership:** unmodified CASS and Episodic Memory both create their
   own raw archives, while QMD requires a normalized document projection and
   stores that content in its index. Those copies are explicitly acceptable and
   may own backend-local recovery. They may not become canonical session
   identity, lineage, live capability, or communication truth. Every copy needs
   source provenance and a defined ingest/repair direction.
8. **Expertise claims:** search can surface demonstrated relevant work with
   citations. It must not convert topical similarity into authority,
   authorization, or a guarantee that the current live session retains that
   context.

None of these conflicts requires another broker, transcript database, Slack app,
or idle polling service. They require one identity owner, one current runtime
writer per live session, and honest boundaries.

## Acceptance criteria for a later implementation

A future approved implementation is complete only when it proves all of these
together:

- one Mac live transcript and its AX41 archive copy resolve to one session;
- one provider session associated with several Slack roots preserves those
  roots separately and never invents a canonical return thread;
- an imported ChatGPT conversation is searchable/contextual but cannot be
  natively sent to or resumed; a consultation creates a distinct, fidelity-
  labeled child and returns that exact identity;
- an audio-only request and later assistant decision are both discoverable with
  exact evidence;
- role-aware ranking prevents boilerplate system/router/tool material from
  displacing a clearly relevant dialogue match, while an implementation-detail
  query can still retrieve bounded tagged tool evidence;
- context explains why a session matches without dumping the full transcript;
- a pre-fork match displays distinct descendants and never picks the newest
  branch implicitly;
- a source file move from live storage to an archive preserves evidence
  resolution through a verified replica;
- a Thinkering action revalidates capability and targets exactly one immutable
  session key;
- a session-addressed message steers only with a current exact interaction
  reference; otherwise it enters the ordinary queued-turn path;
- Slack and Thinkering inputs receive service-issued source input identities,
  and retrying the same source-input/action pair cannot create a second request;
- duplicate/ambiguous communication retries resolve to one recorded request and
  at most one admitted provider effect;
- the existing per-session FIFO, exact-root live steering, Slack projection,
  Stop/fork boundaries, and fail-closed router behavior remain intact;
- the Thinkering catalog and runtime coordinators retain only the state needed
  for their ownership boundaries, while a replaceable search backend may retain
  a provenance-bound raw or normalized recovery corpus without acquiring
  identity or runtime authority;
- full-corpus search reports freshness/completeness and meets a judged retrieval
  evaluation for requirements, decisions, and expertise queries.

## Composition guidance

The agent-communication design should replace “known Slack thread” with “exact
messageable `agent_session_key`,” retain request/reply provenance and idempotency,
and let Slack-root addressing remain an adapter. Thinkering's application/UI
should consume catalog identity, search, context, lineage, and capabilities; it
should never infer them from card state. The search design should return exact
session keys and evidence refs, not Slack destinations or contact decisions.

That division lets an agent discover a relevant archived Mac or ChatGPT session,
learn from it, and cite it without pretending it can talk back. When a live
managed session really is available, the same discovery result can lead to one
explicit, exact, durable communication request independent of where Tejas chose
to view it.
