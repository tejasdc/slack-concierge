# Thinkering-first agent-session interface

Status: **design consultation only.** This brief reconciles the earlier Slack
session-management proposal with Tejas's decision that Thinkering is the primary
control surface. It authorizes no implementation, activation, provider-session
resurrection, or Slack change.

## Design question

How can Tejas address any durable working context—live, idle, offline, or imported—
without having to know whether the runtime must steer, queue, resume, fork, or
reconstruct it?

The interaction is a system, not a feed. Its form must expose identity, lineage,
capability, attention, and results. A chronological list of messages cannot carry
that responsibility by itself.

## Decision

Thinkering should own the canonical agent-session catalog, primary session UI,
branch lineage, per-user attention state, and transport-neutral interaction
contract. Provider runtimes continue to own native execution and native
transcripts. Slack Concierge becomes one adapter over the same session service,
not a second session manager.

The earlier private `#agent-sessions` proposal remains valid as an optional Slack
projection. It is no longer the canonical surface or the place where session
identity, ordering, archive state, or recovery truth originates.

This is already aligned with Thinkering's own design: an `AgentSession` is a
first-class Dialog object; the app is the control surface; remote runtimes attach
as adapters; and native provider transcripts remain authoritative rather than
being copied wholesale into the notes database.

## The ownership boundary

| Concern | Owner | Explicit non-owner |
| --- | --- | --- |
| Stable `AgentSession` identity, lineage relations, title, summary, project/intent links, archive state | Thinkering core and application layers | Slack messages, provider thread IDs, search results |
| Primary list/detail/conversation experience, filters, ordering, drafts, local read state | Thinkering UI and sync projection | Concierge and provider adapters |
| Per-session event order, addressed-request admission, result obligations, exact run ownership, crash recovery | One transport-neutral session coordinator per `AgentSession` | Individual clients or notification handlers |
| Native execution, steering/resume support, tool events, native transcript, runtime availability | The selected provider/runtime adapter | Thinkering UI and Slack transport |
| Imported transcript bytes and immutable provenance | Source/archive owner; remote-box transports laptop archives | Search index or reconstructed session |
| Discovery over titles, summaries, requirements, decisions, evidence excerpts, capabilities, and lineage | A rebuildable Thinkering index | Canonical session history |
| Slack message identity, reactions, Block Kit rendering, and Slack delivery recovery | Concierge's Slack adapter | Thinkering domain state |
| User attention entries, read/dismissed generations, archive/restore commands | Thinkering application layer | Provider lifecycle status |

The physical runtime can evolve without changing this contract. Initially,
Concierge's existing durable provider orchestration may sit behind the runtime
port for sessions it already owns, while Thinkering's native Codex/Claude adapters
serve sessions they own. That does not permit two writers: each session binding
names exactly one current runtime coordinator, and handoff must advance ownership
durably before another coordinator can accept work.

## Canonical identity

### One address identifies one branch

`AgentSession.id` is the provider-neutral address callers use. It identifies one
specific branch of continuity. It never means “whichever branch is newest,” and
it never changes to point at another branch.

A lineage family is derived from explicit relations:

```text
AgentSession
  id
  lineage_root_id
  parent_session_id?        # another AgentSession
  fork_point_event_id?
  derivation                # native | fork | reconstruction | import
  project_id?
  work_intent_id?
  title
  summary_revision
  catalog_state             # active | archived
```

A fork or reconstruction creates a new `AgentSession.id` and an immutable
`derived-from` relation. The source session is not rewritten. The UI may group
the family and label a preferred branch, but the interaction API never accepts a
mutable family pointer as a target.

### Provider and transport identities are bindings

Native and surface identities map onto the canonical session:

```text
ExternalSessionBinding
  agent_session_id
  adapter_kind              # codex | claude | chatgpt-import | slack | ...
  adapter_instance          # account/installation/host namespace
  external_session_id
  external_branch_id?
  source_revision?
  capability                # live | resumable | offline | imported-readonly
  fidelity                  # native | reconstructed-role-history | summary-only
```

The binding key is unique within its adapter instance. A Slack root, Codex thread,
Claude session, and imported ChatGPT conversation can all refer to one logical
lineage without any of their IDs becoming the product's canonical address.

Re-import is idempotent against exact source identity and revision. A changed
export adds a source revision; it does not silently replace retained evidence or
create a duplicate logical session.

### Discovery returns evidence, not identity guesses

Thinkering owns a bounded discovery interface over live and imported sessions:

```text
DiscoverSessions
  query                     # requirements, decision, expertise, project, title
  before_event_id?
  project_id?
  capability_filter?

SessionCandidate
  agent_session_id
  title
  current_summary
  matched_evidence[]        # exact source/event pointers plus short excerpts
  capability
  fidelity
  lineage_context
  last_meaningful_event
```

The index may rank candidates, but it cannot choose one merely because it ranked
first. A caller sends only after selecting one exact `agent_session_id`; an
ambiguous result requires clarification. Search freshness and corpus coverage are
visible facts. A bounded context lookup can add exact surrounding events without
copying a full native transcript into the search index or starting a provider.

This gives an agent a principled way to find “the session where Tejas established
the synchronization invariant” rather than requiring a title or provider ID, while
preserving an audit trail for why that session was selected.

### Continue, compact, rewind, fork, and import

- **Continue** appends to the addressed `AgentSession`.
- **Compact** records a context checkpoint inside that session. It is lossy model
  context, not a new canonical history and not a branch.
- **Rewind** is represented as a fork from an exact event. Later source events
  remain retained even if a provider's local UX describes them as dropped.
- **Fork** creates a child session with a new address and exact parent/fork point.
- **Import** first creates an immutable source-backed, read-only session. It is not
  described as resumed merely because its visible messages were recovered.
- **Reconstruction** creates a runnable child of an imported/offline session. Its
  fidelity and omitted state are visible. It never inherits an unproven claim to
  provider-native tool state, hidden context, credentials, filesystem, attachments,
  compaction state, or execution environment.

When a caller addresses an imported session, the coordinator may automatically
construct a read-only consultation child if the available evidence is sufficient.
A request with mutation authority must not silently cross that fidelity boundary;
it returns an attention-required decision unless an exact runnable binding and
environment are proven.

## Transport-neutral interaction contract

Callers describe the communication they want, not provider lifecycle mechanics:

```text
AddressedRequest
  request_id                # stable idempotency identity
  target_session_id         # exact AgentSession.id
  sender_actor
  sender_session_id?        # durable return address for an agent caller
  reply_to_interaction_id?
  content_parts[]           # text plus immutable attachment/source references
  requested_effect          # consult | propose | mutate
  return_expectation        # none | reply | settlement
  after_interaction_ids[]   # exact semantic dependencies, when needed
```

There is deliberately no Slack channel, provider session ID, host path,
`resume`, `steer`, `fork`, or `import` verb in this boundary.
`requested_effect` describes the requested outcome and selects capability checks;
it never grants authority that the sender does not already possess.

Acceptance returns:

```text
AddressedReceipt
  interaction_id
  target_session_id
  accepted_event_id
  disposition              # recorded | needs-selection | needs-confirmation
```

`recorded` proves only that the request and any return obligation are durable. It
does not claim provider acknowledgement or task success.

Each session has one append-ordered event stream. Relevant durable events include:

```text
request.recorded
request.admitted
provider_input.acknowledged
result.available
request.failed
request.parked_ambiguous
attention.required
session.archived
session.restored
```

Progress text, typing, connection state, and viewers may use a lossy awareness
stream. They must never advance a durable request or result cursor.

Clients observe durable events using a monotonic cursor. Thinkering syncs them into
its local projection; Slack translates them into app-owned messages and reactions;
an agent caller receives correlated results through its durable session mailbox.
The same event is not copied into provider history until the coordinator admits it
as exact input.

## What happens below the interface

The coordinator resolves the addressed request from known facts:

| Target condition | Runtime disposition |
| --- | --- |
| Exact native turn is active and accepts steering | Deliver as ordered steering and wait for provider acknowledgement |
| Native session is idle and resumable | Resume it with the new input |
| Session is busy under another owned turn/branch | Queue through the existing per-session FIFO |
| Native owner is temporarily offline but recoverable | Retain the request and expose unavailable/waiting truth; do not reconstruct prematurely |
| Imported/read-only target and request is consultation-only | Materialize a clearly labeled reconstructed child when evidence is sufficient |
| Imported/read-only target and request may mutate state | Require a confirmed runnable environment/capability before execution |
| Target or branch identity is ambiguous | Return `needs-selection`; ranking is never identity proof |
| Provider submission outcome is ambiguous | Park the same request identity for recovery; never create a replacement request |

The caller always receives the resolved child session address when a reconstruction
or fork was necessary. The abstraction hides lifecycle commands, not lineage or
fidelity.

## Asynchronous reply, result, and failure

An addressed request with `return_expectation = settlement` atomically records a
return obligation with the target request. The sender session may stop running;
the obligation survives independently.

When the exact target interaction settles, the target coordinator emits one
correlated result or failure event. The return delivery owner appends it to the
sender session's mailbox and to Tejas's attention projection. If the sender was
durably waiting on that interaction, the coordinator may admit a continuation
below the interface; otherwise the result remains available without waking an
idle provider merely to say that a result exists.

This preserves the useful distinction from the observed agent exchange:

- a substantive direct reply may arrive before the target turn finishes;
- a settlement obligation guarantees one eventual result/failure disposition even
  if the recipient forgets to send a final handoff;
- an explicit dependency can unblock later work;
- none of these events automatically subscribes to all future activity in a
  thread or generates a reciprocal reply loop.

Cross-session communication is not a distributed transaction. The sender first
records its outbound intent and return obligation; the target applies the stable
request once and records a receipt in its own ordered stream. Causation and
correlation IDs join the two streams without inventing global message order.

## Recovery contract

- Persist request intent and return obligation before any transport or provider
  side effect.
- Reuse `request_id` and `interaction_id` across retries; a new ID means new work.
- Distinguish durable recording, runtime admission, provider acknowledgement,
  execution settlement, result projection, and notification acknowledgement.
- Retry only a definite rejection or a side effect with provider-supported
  idempotency. Park ambiguous submissions rather than risking a duplicate turn.
- Replay and synchronization rebuild projections only. They never invoke a model,
  repeat a tool effect, or manufacture a notification.
- A dead coordinator can be replaced only after its lease/ownership is proven
  expired. The replacement resumes from the session event cursor.
- Result delivery failure does not demote a confirmed provider result. It leaves a
  separate undelivered attention/transport projection to recover.

This is the minimum durable-workflow component the revised requirement earns. It
does not require a general broker, a global event order, or a recurring transcript
scanner. The event names define a logical contract, not a mandate for a new event
database: Thinkering should extend its existing Operation/receipt history and the
current runtime's durable records where those already own the fact.

## Attention, Done, Stop, and Archive

These are four different semantics:

| User concept | Scope | Effect |
| --- | --- | --- |
| Attention | Per user, per event generation | Projects `needs-input`, `result-ready`, `failed/parked`, or another meaningful event into the working set |
| Done / dismiss | Current attention generation | Removes the management entry after the current event has been handled; preserves session, lineage, transcript, and run state |
| Stop | Exact active run | Requests cancellation through the owning runtime; never archives or dismisses the session and cannot target a stale successor |
| Archive | Whole `AgentSession` branch | Sticky, recoverable catalog exclusion; preserves all history and lineage and does not imply provider deletion |

New meaningful activity after Done creates a new attention generation and returns
the session to the working set. Archive is intentionally stronger: an addressed
request to an archived session is retained but cannot start a new provider turn
until the exact session is restored. Automatic result delivery to an archived
sender remains durable without silently resurrecting its provider.

Archive while a run is active should be unavailable. “Stop and archive” may be a
composed UI operation, but it remains two explicit effects with independent
outcomes.

Typing, viewers, and live progress previews are ephemeral awareness. Active-run
ownership and admission, needs-input, result-ready, failure, ambiguous recovery,
Done, Stop intent, and Archive are durable facts or projections. Do not compress
them into one mutable `status` field.

## Thinkering UI contract

Thinkering can now provide the control surface that Slack could not:

- a stable working set ordered by meaningful attention and user preference rather
  than message chronology;
- concise title, project/intent, current summary, capability/fidelity, lineage, and
  latest meaningful state on each entry;
- a full session detail/conversation surface addressed to the exact branch;
- filters for live, waiting, needs attention, reconstructed, and archived sessions;
- explicit Stop, dismiss, archive/restore, and branch navigation;
- paged transcript inspection from the authoritative source, with promoted
  requirements/decisions/evidence as separate referenced objects;
- no full transcript or long request in the management list.

The list and attention projections are replaceable views over canonical objects.
Editing a title or summary does not move or rewrite session history. Ordering is a
projection concern and can improve without changing session identity.

## Slack becomes an adapter

The dedicated private Slack channel is an optional compact client of the same
contract:

- one Concierge-authored root binds an exact `AgentSession.id`;
- its title, summary, state reaction, and source link project Thinkering state;
- its thread submits `AddressedRequest` and projects progress/results;
- `:white_check_mark:` invokes the same `DismissAttention` command;
- deleting the Slack root removes only that Slack projection;
- Slack chronology is not treated as canonical ordering;
- Concierge DM routing receipts and capture traffic never become sessions;
- no dedicated Slack agent is required.

This preserves all earlier requirements—conversation through an entry, concise and
improvable titles/summaries, emoji actions, Done without session deletion, optional
ordering, cross-channel visibility, and freedom from routing-history pollution—
while making them available in a surface unconstrained by Slack.

Slack-specific failures cannot corrupt canonical session or attention state. A
failed Slack update remains a failed adapter projection; Thinkering still shows
the authoritative event. Conversely, a Slack reaction is only a requested command
until Thinkering durably accepts it.

## Preserved requirement mapping

| Earlier requirement | Thinkering-first answer |
| --- | --- |
| Find old and current sessions without recency noise | Searchable session catalog and explicit working-set projection |
| Know which session, latest state, and what needs attention | Exact branch address plus event-derived attention |
| Avoid Slack Threads/Activity ordering and routing pollution | Thinkering is primary; Slack is an optional clean projection |
| Talk to the existing agent through the management entry | Session composer submits to exact `AgentSession.id`; runtime resolves lifecycle |
| Mirror progress and responses across channels | Every client projects the same session/run events using cursors |
| Good titles and summaries, no full transcript in the list | Editable projections backed by authoritative paged history and evidence |
| Emoji states/actions | Slack adapter bindings invoke transport-neutral commands |
| Mark Done and remove only the management entry | Dismiss current attention generation; preserve session and lineage |
| Optional ordering | A Thinkering projection, never delete/repost message chronology |
| Sessions reconstructed from laptop and ChatGPT exports | Immutable imported session plus explicitly labeled runnable child branch |
| Automatic result/failure notification | Durable exact-interaction return obligation and sender-session mailbox |
| Safe restart/recovery | Per-session ordered log, one coordinator, stable identities, parked ambiguity |

## Non-goals and pressure tests

- Thinkering does not copy every provider transcript into its semantic note store.
- Search does not decide session identity or branch selection.
- A summary-only reconstruction is not called a native resume.
- A transport notification is not execution success.
- Done is not Archive; Archive is not Stop; Stop is not provider-session deletion.
- A fork never rewrites its parent.
- A provider adapter cannot become a second canonical session catalog.
- Slack parity is not a constraint on Thinkering's UI.
- The first delivery need not adopt a general workflow engine, CRDT for session
  events, or globally ordered message bus.

The most important acceptance pressure test for a future implementation is not a
happy-path chat. It is: address a historical imported session from one client,
resolve it to an honestly labeled child branch, disconnect the UI after provider
acknowledgement, settle the run, recover the result obligation exactly once, and
observe the same lineage/result/attention state in Thinkering and the Slack adapter
without replaying the model effect.

## Research basis

The design composes four stateful shapes: one ordered event stream per session,
durable workflow for request/result obligations, ephemeral awareness for live
progress, and a durable agent thread for continuity. Thinkering's local-first
client is a projection over provider-run and addressed-interaction effects owned by
the session coordinator, not another runtime writer.

Relevant Readwise sources:

- Anthropic, “Scaling Managed Agents: Decoupling the brain from the hands” —
  separates durable session log, replaceable harness, and execution environment;
  Reader ID `01knr94a5xajcxkbz8jrpfpzmp`.
- Kyle Mathews, “Introducing Electric Agents” — frames addressability,
  observability, subscription, and forkability as consequences of an accessible
  session log; Reader ID `01ktdd6wv3tx2y63970g7x9x4v`.
- Ramp, “Why We Built Our Own Background Agent” — demonstrates multiple clients
  projecting the same session rather than creating one session per surface;
  Reader ID `01ketw057gd73mwj54ah3vw4d8`.
- OpenAI, “App Server” — distinguishes Thread, Turn, and Item while allowing many
  UIs to observe one authoritative runtime; Reader ID
  `01kqrbgw7rdcn5x159ws6fjq4g`.
- Nader Dabit, “How to Build a Custom Agent Framework with PI” — documents a
  parent-linked JSONL session tree and explicit branching; Reader ID
  `01khsxknq4b7qasdw561svd283`.
- Thariq, “Using Claude Code: Session Management & 1M Context” — distinguishes
  continuation, rewind, compaction, clean sessions, and subagents as different
  context decisions; Reader ID `01kpa0vkby308fzpvx8arp254j`.

Related local designs:

- [Slack attention and session-management surfaces](2026-08-24-slack-agent-attention-and-progress.md)
- [Thinkering's AgentSession and adapter boundary](https://github.com/tejasdc/thinkering/blob/2b69a93396fb1e94227bb2fac8607f0069936a66/docs/design.readme.md#agents-history-and-interpretations)
- [Thinkering product requirements](https://github.com/tejasdc/thinkering/blob/2b69a93396fb1e94227bb2fac8607f0069936a66/docs/requirements.md)
