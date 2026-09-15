# Agent-session discovery, identity, and communication ownership

Status: **design consultation only**. This brief defines the contract that the
agent-communication and Thinkering session-management designs should compose
with. It changes no runtime behavior and authorizes no implementation,
installation, restart, migration, or deployment.

Date: 2026-09-14

## Decision summary

Make the logical agent-session branch—not a Slack thread, transcript path,
search document, provider alias, or UI entry—the durable unit of continuity.
Give every discovered session one
Thinkering-owned immutable `AgentSession.id` (called `agent_session_id` at API
boundaries). Bind that identity to an exact
provider-native identity when one exists, to zero or more transcript replicas,
to explicit lineage edges, and optionally to Slack and live-runtime bindings.

The five owners remain separate:

1. Provider stores and import pipelines own raw transcripts.
2. Thinkering core owns the canonical session catalog, `AgentSession.id`,
   cross-source lineage, and the transport-neutral addressed-request contract.
   It stores metadata and evidence locators, not another transcript.
3. The current runtime coordinator owns admission and recovery for each live
   session. Concierge remains that owner for sessions it already manages and
   owns their Slack bindings/projection; provider adapters supply native runtime
   capability evidence. No session has two admission writers.
4. A replaceable search backend owns only a rebuildable dialogue index keyed by
   `agent_session_id` and exact evidence references. No backend has yet earned
   selection. Episodic Memory is the closest current functional fit; CASS has
   the broadest provider ingestion inspected; QMD has the richest document
   retrieval stack. Each misses a different required boundary, described below.
5. Thinkering's application/UI layers own the primary discovery and
   session-management experience. Their cards, filters, attention state, and
   local cache are projections, not provider continuity or live capability
   proof.

Agents follow one explicit sequence: search by requirements, decisions, topic,
or demonstrated expertise; inspect bounded source-grounded context; inspect the
exact node's lineage and current capabilities; then address one exact
`agent_session_id`. Search ranking never chooses a communication target. This
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

1. One immutable catalog identity names one logical session branch.
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

The catalog identity is a Thinkering-owned opaque UUID:

```text
agent_session_id
```

It is independent of Slack, any particular Thinkering client or sync replica,
provider host, transcript path, title, and mutable transcript content. The
catalog records aliases and bindings rather than packing them into the ID:

```text
provider_identity
  provider_id                 codex | claude-code | chatgpt | ...
  provider_account_scope      stable local profile/account namespace
  native_session_id           exact provider conversation/session ID

slack_binding[]               channel_id + visible root_ts + binding status
runtime_binding[]             managed adapter + host/profile + provider ID
source_replica[]              registered transcript/export artifacts
lineage_edge[]                parent/child relationship with proof
```

For Concierge-created Claude and Codex sessions, the exact provider UUID becomes
the native identity when it is durably bound. For an imported export, use the
provider's conversation ID inside that export when present. If a format has no
stable upstream ID, persist a catalog UUID at first import and retain an import
manifest alias. A path, timestamp, title, or whole-file content hash may support
deduplication but must not alone define logical identity.

The uniqueness boundary is the provider identity within its stable
account/profile scope. This prevents accidental collision between two accounts
while allowing a Mac live file, its AX41 archive copy, and a later re-export to
resolve to the same `agent_session_id`.

Bindings are zero-to-many. One shared provider session may be projected through
several Slack roots, and historical roots may no longer own current admission.
Each Slack binding therefore records whether it is a historical association, a
current projection, or an eligible admission surface. There is no canonical
Slack root implied by `agent_session_id`. Every Slack-projected request retains
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
  agent_session_id
  source_replica_id
  provider_event_id?          preferred when the format supplies one
  role                        user | assistant
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

The catalog may retain a bounded display snippet and hashes/locators. It must not
retain the complete transcript. The search backend may retain the minimum
rebuildable postings, vectors, and bounded stored fields required for retrieval,
but no second raw transcript archive.

## Search corpus and retrieval contract

The indexed corpus is the genuine human-agent dialogue:

- initial user requests and every steering/follow-up input;
- supplied or locally generated voice transcripts, including audio-only inputs;
- user-visible assistant commentary and final answers;
- explicit artifact, document, issue, and commit references surfaced in that
  dialogue;
- optional derived session summary, requirement, decision, and expertise facets,
  each linked to one or more `evidence_ref` values.

It excludes system/developer prompts, tool calls and results, hidden reasoning,
runtime operations, Slack/router envelopes, skill/plugin catalogs, attachment
instructions, replay wrappers, and duplicated cumulative summaries already
represented by their underlying dialogue. Search-source normalization, not the
ranker, owns this boundary.

The logical read interface is UI-neutral:

```text
search_sessions(query, filters?, before?, limit?) -> candidates
get_session_context(agent_session_id, evidence_refs?, bounds) -> context
describe_session(agent_session_id) -> identity, lineage, capabilities, bindings
```

Each candidate includes the exact `agent_session_id`, provider, date/title,
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

1. The matched user or assistant event and adjacent genuine dialogue turns.
2. The session opening request or earliest available goal statement.
3. Relevant requirement/decision/expertise facets with exact evidence refs.
4. The most recent user-visible outcome relevant to the query.
5. Referenced durable artifacts or commits without replaying tool output.
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
  target_agent_session_id
  source_input_ref
  source_action_id
  sender_actor
  source_agent_session_id?
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
supplies its `source_agent_session_id`, which the coordinator validates against
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
  binding to `agent_session_id` before admission. Session-addressed callers do
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
`agent_session_id`, source input, and selected interaction/projection context.
Its ordinary `resume <channel> <root>` path is not the durable identity contract
for newly discovered sessions and should become a Slack adapter, not the core
addressing model. This brief composes with the
[September 11 observation-led communication proposal](https://github.com/tejasdc/slack-concierge/blob/63c92a9b10445947f4a5f18dc418157e7d625802/docs/plans/2026-09-11-agent-communication.md)
and the continuing design discussion in
[the agent-session communication thread](https://tejazz.slack.com/archives/C0BNN5K4JSJ/p1789154481755879).

## Thinkering integration boundary

The request that Thinkering become the primary session-management surface is a
product decision this contract supports:

- Thinkering core owns `AgentSession.id`, catalog metadata, explicit lineage,
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
revalidates the exact session ID through the session coordinator and asks the
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

The objective is not “install the strongest search engine.” It is: find the
correct logical session from requirements, decisions, topics, and demonstrated
expertise; inspect enough cited dialogue to judge it; then address that exact
session independently of Slack. The backend is judged on:

1. Claude, Codex, archived Mac/AX41, and future ChatGPT-export coverage.
2. Genuine user/assistant dialogue including voice transcripts, without system
   prompts, tool traffic, router envelopes, or cumulative-summary duplication.
3. Lexical and semantic recall, bounded fuller context, exact native session ID,
   role, and evidence location in machine output.
4. No second raw-transcript archive, because the existing append-only archive
   already owns preservation.
5. A replaceable integration seam rather than identity, lineage, capability, or
   communication ownership.
6. Low operational and fork-maintenance cost for a single operator.

No inspected option meets all six requirements unchanged:

| Option | Where it wins | Where it loses | Decision consequence |
| --- | --- | --- | --- |
| **Episodic Memory unchanged** | Already parses Claude, Codex, Cursor, OpenCode, and OMP into user/assistant exchanges; exposes semantic plus text search, multi-concept search, `session_id`, source path/line ranges, sidechain metadata, and a conversation reader. This is the closest current match to dialogue retrieval and evidence context. | Its sync deliberately copies conversations into its own archive; it does not currently ingest ChatGPT exports; source discovery is harness-specific; its evidence remains archive-path/line based; it does not own live capability or cross-provider catalog identity. | Evaluate first for functional fit, but do not adopt unchanged while a second archive is forbidden. Determine whether upstream will accept registered external archives/no-copy ingestion and a provider adapter; do not maintain a private fork merely to defeat its archive invariant. |
| **CASS unchanged** | Broadest inspected connector coverage (23 agents in its current contract), incremental indexing, lexical and semantic retrieval, robot output, health/diagnostics, and source `view`/`expand`. | Raw preservation is a core recovery feature; the default corpus includes system/tool/developer messages; current search JSON omits normalized role and internal provider `external_id`; identity is path/internal-record oriented; it owns an archive/recovery model we already have. | Use unchanged only if CASS is intentionally chosen to replace—not duplicate—the existing transcript archive. That is a larger ownership migration with no current justification. |
| **CASS with “index-only/dialogue-only” changes** | Could reuse CASS's connectors and retrieval while conforming to the desired ownership split. | There is no confirmed general index-only setting. Removing raw mirroring discards a documented CASS recovery guarantee and touches its archive-first indexing, coverage, doctor, and reconstruction paths. Dialogue filtering and output fields are additional changes. This is a real upstream feature or maintained fork, not configuration. | Do not call this the leading candidate. Consider it only if upstream accepts a small coherent mode and its maintenance surface is measured; otherwise reject it. |
| **QMD over normalized dialogue documents** | Mature document retrieval composition: BM25, vectors, query expansion, reranking, collection context, JSON output, document fetch, and line-bounded reads. It is content-source agnostic and can search globally or by collection. | QMD does not parse agent transcripts, identify genuine roles, understand sessions/forks, expose provider IDs, or report live capabilities. We would own normalization and identity mapping. It stores document content in SQLite, so it still duplicates the normalized dialogue even if it does not mirror raw JSONL. Local model loading also adds query-time RAM/latency. | Treat QMD as a retrieval library/backend, not a session system. It is attractive only if the normalizer/catalog is required regardless and its measured recall gain justifies its model and storage cost. |
| **claude-code-tools / Tantivy search** | Directly indexes Claude and Codex JSONL without creating another raw archive; emits native session UUID, provider, project, timestamps, and snippets; lexical search is cheap and operationally simple. | It has no semantic retrieval or ChatGPT connector; its searchable Claude corpus includes tool inputs/results; result evidence is session-level and path-based rather than exact role/event identity. | Keep as the lowest-complexity lexical baseline. It does not satisfy the complete discovery contract but establishes how much a more complex backend must improve recall. |
| **Thin normalizer plus FTS/vector libraries** | Exact ownership fit: read the existing archive, retain only genuine dialogue and precise evidence, add no raw mirror, and choose independent lexical/vector components. | We would own every provider parser, import migration, dedup rule, indexing lifecycle, and retrieval API—the largest long-term maintenance burden. | Last resort only after the existing-library evaluation demonstrates a concrete unbridgeable gap. Feature mismatch alone is not permission to build it. |

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
existing transcript archive already supplies raw preservation, which is why the
same CASS mirror is redundant here unless CASS replaces that owner.

The local five-session sample made the duplication concrete: CASS's raw mirror
was 95,993,374 bytes and its SQLite archive was 21,512,192 bytes, excluding the
82,512,810-byte lexical index, 9,766,262-byte vector index, and 91,335,811-byte
downloaded model. These figures describe that sample, not projected production
growth.

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
contributed 751,840 bytes. That does not prove a universal ranking improvement,
but it quantifies the cost/noise that a dialogue-only evaluation must test.

CASS also already stores an internal provider `external_id` on a conversation.
The problem is narrower: current search/session JSON does not expose that ID,
and an unscoped provider ID cannot by itself merge replicas or address
cross-provider/imported history. A separate Thinkering `agent_session_id` buys
one stable foreign key across provider/account/host bindings, live/archive/export
replicas, formats with no native ID, and explicit lineage. It does not improve
search quality and it adds catalog/dedup/migration state. If this were only
read-only search over one provider with globally stable IDs, the correct design
would use `(provider, account_scope, native_session_id)` and omit the extra UUID.
The UUID is justified here only by the broader cross-provider durable-addressing
requirement; every native ID remains an exact alias/binding rather than being
discarded.

### Current recommendation

Retract the earlier ranking of CASS above the alternatives. The evidence did not
justify it. The current evaluation order is:

1. Use Episodic Memory as the first functional comparison because it already
   implements the nearest dialogue/search/context shape.
2. Compare CASS unchanged for connector breadth and archive/recovery value, not
   against an imaginary configuration mode.
3. Compare QMD and claude-code-tools as retrieval-quality and low-complexity
   baselines respectively.
4. Select nothing until the same representative corpus measures session-level
   top-one/top-three recall, exact evidence completeness, indexing/query
   latency and peak RAM, raw/index/model bytes, supported-source coverage, and
   required upstream/fork changes.
5. Prefer the existing product that meets the acceptance matrix with no private
   fork. Build a thin normalizer only if the evaluation identifies a requirement
   none of the products can expose through a narrow upstreamable seam.

The prior five-session CASS result—lexical OR at 5/5 top-one and semantic
paraphrase at 3/5 top-one, 5/5 top-three—is directional only. The generated
corpus and result files were ephemeral, so it cannot choose a backend. A
committed, reproducible, representative evaluation is required before any
implementation recommendation.

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

1. A global metadata-only Thinkering session catalog with immutable
   `AgentSession.id` / `agent_session_id`.
2. Source replica registration and exact evidence resolution across live,
   archived, Mac-imported, and future ChatGPT-export material.
3. Dialogue-only hybrid discovery and bounded evidence context over those
   sources.
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
   stores that content in its index. None may silently become a second raw
   archive or own catalog, capability, or communication truth.
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
- system/tool/router text cannot win a dialogue-only search result;
- context explains why a session matches without dumping the full transcript;
- a pre-fork match displays distinct descendants and never picks the newest
  branch implicitly;
- a source file move from live storage to an archive preserves evidence
  resolution through a verified replica;
- a Thinkering action revalidates capability and targets exactly one immutable
  session ID;
- a session-addressed message steers only with a current exact interaction
  reference; otherwise it enters the ordinary queued-turn path;
- Slack and Thinkering inputs receive service-issued source input identities,
  and retrying the same source-input/action pair cannot create a second request;
- duplicate/ambiguous communication retries resolve to one recorded request and
  at most one admitted provider effect;
- the existing per-session FIFO, exact-root live steering, Slack projection,
  Stop/fork boundaries, and fail-closed router behavior remain intact;
- the Thinkering catalog and runtime coordinators retain metadata/evidence
  locators only, with no copied raw transcript corpus;
- full-corpus search reports freshness/completeness and meets a judged retrieval
  evaluation for requirements, decisions, and expertise queries.

## Composition guidance

The agent-communication design should replace “known Slack thread” with “exact
messageable `agent_session_id`,” retain request/reply provenance and idempotency,
and let Slack-root addressing remain an adapter. Thinkering's application/UI
should consume catalog identity, search, context, lineage, and capabilities; it
should never infer them from card state. The search design should return catalog
IDs and evidence refs, not Slack destinations or contact decisions.

That division lets an agent discover a relevant archived Mac or ChatGPT session,
learn from it, and cite it without pretending it can talk back. When a live
managed session really is available, the same discovery result can lead to one
explicit, exact, durable communication request independent of where Tejas chose
to view it.
