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
   `agent_session_id` and exact evidence references. CASS is the leading
   candidate only after it can run index-only and dialogue-only; it is never the
   identity or communication authority.
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

The September 14 consultation makes CASS the leading implementation candidate,
not an approved authority. The local inspection used upstream commit
[`7c959c5`](https://github.com/Dicklesworthstone/coding_agent_session_search/tree/7c959c591e0d4568f3fc72a44689cdb6a448be40).
At that revision, normal indexing calls
[`capture_source_file`](https://github.com/Dicklesworthstone/coding_agent_session_search/blob/7c959c591e0d4568f3fc72a44689cdb6a448be40/src/indexer/mod.rs#L30492),
whose raw-mirror implementation preserves source content; CASS itself describes
that policy as storing
[verbatim source copies](https://github.com/Dicklesworthstone/coding_agent_session_search/blob/7c959c591e0d4568f3fc72a44689cdb6a448be40/src/privacy_exposure.rs#L176-L180).
Its normalized
[`MessageRole`](https://github.com/Dicklesworthstone/coding_agent_session_search/blob/7c959c591e0d4568f3fc72a44689cdb6a448be40/src/model/types.rs#L6-L14)
represents system and tool roles as well as user and assistant dialogue, while
[`SearchHit`](https://github.com/Dicklesworthstone/coding_agent_session_search/blob/7c959c591e0d4568f3fc72a44689cdb6a448be40/src/search/query.rs#L1616-L1648)
is organized around CASS source paths, line numbers, and internal conversation
records rather than this contract's catalog identity and replica-independent
evidence reference. It cannot decide whether a catalog node is live or
messageable.

A local read-only five-session sample found lexical OR retrieval at 5/5 top-one
and semantic paraphrase retrieval at 3/5 top-one and 5/5 top-three; retained
non-dialogue content contributed to the misses. That sample is directional, not
a benchmark: its generated corpus and result files were ephemeral and are not a
committed reproducibility artifact. The source facts above are confirmed at the
pinned revision; the measured ranking figures must be reproduced in a committed
evaluation before they can justify implementation selection. The index-only,
dialogue-only, identity, and evidence properties below are acceptance
requirements, not claims that unmodified CASS already supports them.

The acceptable CASS seam is therefore:

- index-only operation with no raw mirror;
- dialogue-only normalization or role inclusion;
- exact native session ID, role, and evidence locator in machine output;
- source completeness/freshness reporting;
- no Slack, Thinkering, capability, lineage, or communication ownership.

If those changes remain small and upstreamable, pin CASS behind the logical
search interface. If avoiding its archive/recovery model requires a broad fork,
reject it and compose a narrow normalizer with established lexical/vector
libraries. Do not bootstrap CASS as a second session platform.

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
7. **CASS ownership:** unmodified CASS violates the no-copy/dialogue-only
   requirements and cannot own capability or communication truth.
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
