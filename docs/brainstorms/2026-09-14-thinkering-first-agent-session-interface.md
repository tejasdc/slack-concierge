# Thinkering-first agent-session interface

Status: **design consultation only.** This brief incorporates Tejas's premise
challenge to the earlier Slack-primary recommendation and preserves that source
verbatim below. It authorizes no implementation, activation, provider-session
resurrection, capture-route change, notification change, or Slack change.

## Design question

How can Tejas address any durable working context—live, idle, offline, or imported—
without having to know whether the runtime must steer, queue, resume, fork, or
reconstruct it?

The interaction is a system, not a feed. Its form must expose identity, lineage,
capability, attention, and results. A chronological list of messages cannot carry
that responsibility by itself.

## Revised decision

Thinkering should own the canonical agent-session catalog, primary session UI,
branch lineage, per-user attention state, and transport-neutral interaction
contract. Provider runtimes continue to own native execution and native
transcripts. Slack Concierge becomes one adapter over the same session service,
not a second session manager.

Do not build the private `#agent-sessions` channel as the primary surface. It may
remain a later optional projection, but it has not earned a place in the initial
design. Retain Slack initially for the things it presently does better than
Thinkering: notification delivery and the existing Slack-bound capture and source
threads. Slack is an adapter during that transition, not the session backend.

This is already aligned with Thinkering's own design: an `AgentSession` is a
first-class Dialog object; the app is the control surface; remote runtimes attach
as adapters; and native provider transcripts remain authoritative rather than
being copied wholesale into the notes database.

This conclusion is 88% confident. The canonical surface and ownership split are
well supported by current code and product requirements. The main uncertainty is
the desired notification and capture cutover policy, which is a user-experience
choice rather than an architecture fact and remains in the consolidated questions.

## Objective and requirements used for the comparison

The objective is to minimize the time and attention required to find the right
durable agent session, understand what it needs, continue the exact branch, and
recover its result across phone and laptop—while making agent work a native part
of Thinkering's note, project, intent, evidence, and change history.

The surface must:

1. represent one stable session branch independently of Slack chronology;
2. show a user-curated working set ordered by meaningful attention, not every new
   message or routing receipt;
3. support concise, editable titles and summaries without destroying or copying
   the full authoritative transcript into each card;
4. allow conversation, Stop, Done, archive/restore, fork, retry/recovery, and
   branch navigation against the exact current identity;
5. discover live and imported sessions by requirements, decisions, topic,
   artifacts, and demonstrated experience, with exact source evidence;
6. preserve provider-native execution and transcript fidelity, including honest
   labels for imported or reconstructed sessions;
7. survive disconnection and surface one eventual result or failure without
   replaying a model or tool effect;
8. remain usable on iPhone and laptop, with trustworthy attention delivery;
9. accept text and eventually the file/audio inputs Tejas already uses;
10. keep Slack, Thinkering, provider, capture, and archive ownership explicit so
    no two systems can admit work or claim canonical history for one session.

## Surface alternatives

Measured facts below are from Slack Concierge commit `0c93667` and Thinkering
commit `5d3b674` on 2026-09-14. Future effort is intentionally not expressed as
hours: no implementation plan or measured task decomposition exists yet. All
relative future implementation and maintenance costs in this comparison are
architectural hypotheses until a reviewed plan measures them; the current code,
configuration, route, dependency, and upstream-capability observations are facts.

| Alternative | Where it wins | What it loses or duplicates | Maintenance owner | Decision |
| --- | --- | --- | --- | --- |
| Do nothing: current Slack Threads/Activity/App Home plus provider-native clients | Zero new work. Slack already provides mobile/desktop notification delivery, search, files, clips, and familiar replies; native provider clients retain their own high-fidelity sessions. | No cross-provider session identity, lineage, imported-session discovery, durable Done semantics, note links, or stable attention ordering. Tejas continues to reconstruct work across feeds and clients. | Existing Concierge, Slack, and provider maintenance only. | Valid if the session-management problem is not worth solving; it does not meet the stated objective. |
| Dedicated private Slack channel with existing Concierge | Smallest new Slack-native projection; conversation and notifications stay in a mature client. | Slack message order still drives the visible list, a projection root can be mistaken for identity, note/session relationships remain external links, and it duplicates a catalog Thinkering needs anyway. Concierge DM would add routing-history pollution; a dedicated Slack agent would add OAuth and lifecycle ownership without removing these limits. | Concierge owns every projection/control edge and Slack API change. | Reject as primary. Keep only as a possible secondary projection if actual use later demands it. |
| Provider-native UI or upstream orchestration product | Codex/Claude retain native tools, checkpoints, compaction, and transcript fidelity. Products such as Pi supply a session tree and agent loop; Symphony shows that a task tracker can be an agent control plane. | No one upstream surface spans current Concierge sessions, both providers, ChatGPT/laptop imports, Thinkering notes, or Tejas's attention semantics. Replacing current runtimes with Pi would create a provider/runtime migration, not merely solve navigation. | The upstream product plus local integration adapters. | Use native runtimes below the interface; do not make any one of their UIs the canonical cross-provider surface. |
| Thinkering management UI with Slack as conversation **backend** | Defers a new message store and preserves Slack notifications, clips, files, and clients. | Creates two authorities: Thinkering owns session objects and attention while Slack owns the message chronology and retention. Every send, branch, archive, import, and result needs a Slack-root mapping even when no Slack root is semantically needed. Slack retention and API constraints leak into Thinkering. | Thinkering and Concierge jointly own nearly every interaction boundary. | Reject. Slack may transport/project an interaction, but it must not be the canonical backend. |
| Thinkering fully replaces Slack immediately | Cleanest long-term product boundary and maximum freedom over ordering, identity, note integration, and interaction design. | Today it would regress push notifications, Slack-native file/audio input, and existing Pebble/Monologue/Thinkering-to-Slack agent capture. It would require a simultaneous cutover across three repositories and several devices. | Thinkering plus remote-box/capture owners take over every displaced capability. | Directionally coherent, but premature as an immediate cutover. |
| **Thinkering primary; Slack retained as a narrow adapter** | One canonical catalog and attention surface; existing provider histories remain authoritative; Slack keeps mobile push and already-working ingress/source projections while parity is built deliberately. Each adapter can later be removed independently. | Temporarily maintains two user-visible clients and exact cross-surface bindings. A notification or Slack projection can lag even when the session result is correct. | Thinkering owns product/session state; Concierge owns Slack projection and its runtime sessions; remote-box owns Monologue; provider adapters own native continuity. | **Recommended.** It is the smallest reversible path to the desired product without pretending Slack supplies nothing. |

The hybrid is not “Slack as backend.” The invariant is one canonical session key
and one runtime admission owner. Slack transports or projects selected events; it
never defines the session, branch, archive state, Done state, transcript, or order.

## What Slack actually supplies today

Slack is more than a message renderer, but most of its value here is replaceable
platform infrastructure rather than the desired session model.

| Capability | Slack supplies | Current Thinkering/Concierge evidence | Consequence of bypassing Slack |
| --- | --- | --- | --- |
| Identity and authorization | Workspace membership plus bot/user/app tokens and granular OAuth scopes. Concierge currently declares 37 bot scopes and 11 user scopes. | Thinkering already has a private passkey/owner-recovery boundary. Provider subscription authentication remains separate either way. | No need to rebuild team identity for this single-operator product, but Thinkering must authenticate every session command and Slack adapter callback itself. |
| Notifications | Desktop banners/badges, mobile push, email fallback, and notification preferences for DMs, mentions, and followed-thread replies. | A whole-repository search found no `PushManager`, `PushSubscription`, `notificationclick`, or `web-push` implementation in Thinkering. Its PWA alone does not prove background push. | Immediate Slack removal would remove the only proven phone/desktop result-alert path. Keep Slack notification delivery until one Thinkering push path is built and proven, then select exactly one notifying transport per event. |
| Persistence and search | A hosted searchable archive of messages and files, subject to workspace plan and retention settings. Paid workspaces keep data for the workspace lifetime by default but can change it; free history is much more limited. | Provider-native transcripts are already authoritative. Thinkering has SQLite/RxDB history, paged agent history, and MiniSearch as a disposable index, but the cross-provider session catalog/search in the discovery brief is not implemented. | Thinkering must build session metadata, evidence indexing, import, and search; it does **not** need to duplicate every transcript into the notes store. Slack is not durable enough to be the canonical archive independent of plan/policy. |
| Files | Native desktop/mobile selection, previews, malware scanning, browse/search, and uploads up to 1 GB. | assistant-ui offers attachment adapters, but Thinkering's current conversation UI renders no attachment control and its AG-UI request adapter extracts text parts only. | A Slack-free launch would regress current file input. Add a server-owned attachment adapter and immutable content references before redirecting file-bearing sessions. |
| Audio/video | Native phone/desktop clips up to five minutes with optional generated transcripts. Concierge also transcribes Slack audio through its existing path. | Thinkering's accepted requirements explicitly defer an in-app audio recorder. Its current agent UI has no speech/audio adapter. | Keep Slack clips or an existing external capture surface. Do not make an audio recorder a prerequisite for the session catalog unless Tejas chooses it. |
| Native clients | Maintained iOS, Android, macOS, Windows, Linux, and browser clients, including OS integration and background behavior. | Thinkering is an installable responsive PWA and already targets iPhone/WebKit, but native apps are an explicit non-goal. | The PWA can be the primary management UI, but it is not feature-parity with Slack's client fleet. Only actual single-user phone/laptop workflows need parity. |
| Current capture ingress | Slack is the destination for the `/thinkering` route; Pebble double-click/headerless/test events; and the live remote-box Monologue poller. Pebble single-click already bypasses Slack to Journalmaxx. The `/audio` backup lands in a directory rather than Slack at ingress. | These are independently owned, durable flows—not UI widgets. Monologue's timer and receipts live in `remote-box`; Concierge owns its capture queue and Slack delivery. | Removing Slack without rerouting these exact effects would break working capture. Preserve them through the initial surface change; migrate each only after its Thinkering destination and receipt semantics are proven. |

Slack's newly expanded Activity view also weakens the case for rebuilding a
notification inbox *inside Slack*: it supports saved filters, specific channels,
clearing, dense/detailed views, and reply (specific-channel and section filters
are paid-plan features). That is useful as a Slack attention adapter. It still
cannot express provider capability, session lineage, imported sessions,
WorkIntent links, or Thinkering-specific Done/archive semantics.

## Is chat and thread UI a solved problem?

Partly. The generic interaction mechanics are solved well enough that Thinkering
should not rebuild them. The product-specific state model is not.

| Candidate | It already covers | It does not decide for Thinkering | Fit |
| --- | --- | --- | --- |
| **assistant-ui** | Composer, messages, scrolling, tool parts, attachments through adapters, remote thread lists, titles, rename, archive/unarchive/delete, branches, history persistence seams, and run controls. | Canonical cross-provider identity, exact branch lineage across providers/imports, attention generations, Done vs Stop, runtime admission/recovery, evidence provenance, note relationships, push delivery, or capture routing. | Best fit. Thinkering already depends on it and uses it in its current Agents view. Add its remote thread-list primitives over Thinkering's domain contract rather than inventing a list/chat toolkit. |
| **AG-UI** | A transport-neutral event protocol for text, tools, runs, messages snapshots, state snapshots/deltas, and bidirectional agent/frontend communication over SSE/WebSockets/other transports. | Durable storage, idempotent admission, authorization, catalog identity, lineage, notifications, or user attention policy. | Keep. Thinkering already translates provider events into AG-UI; extend only the app-owned durable contract around it. |
| Vercel AI SDK `useChat` | Provider-facing streaming chat state and basic file attachment flows across several frontend frameworks. | The same session-domain, attention, recovery, import, and note-graph concerns; adopting it would overlap the already-working assistant-ui/AG-UI composition. | Useful comparator, not a justified replacement. |
| Assistant Cloud | Hosted threads, persistence, titles, attachments, run reports, and engagement around assistant-ui. | Thinkering's provider-native transcript authority, imported-session catalog, local-first workspace history, evidence graph, capture paths, and exact runtime ownership. It also adds another hosted data owner. | Do not adopt by default. Use assistant-ui's self-hosted remote adapters against Thinkering's existing storage instead. |
| Pi (`pi-agent-core`, `pi-coding-agent`, SessionManager, web/TUI packages) | Agent loop, streaming events, tools, persisted JSONL sessions, compaction, steering/follow-ups, and parent-linked branch trees. | Integration with the existing Codex App Server/Claude Agent SDK sessions, Thinkering objects, passkeys, capture routes, notifications, and imported cross-provider identity. | Strong evidence that session UI/runtime primitives exist; replacing current runtimes with it would be a much larger and unnecessary product decision. |

Current Thinkering already has 325 lines across five central conversation UI and
adapter files (`agent-thread`, `agent-conversations`, `agent-ag-ui`,
`agent-routes`, and `browser-chat-agent`) and six installed assistant-ui/AG-UI
packages. It already supports text conversation, provider-backed paged history,
tool display, reconnect/reconciliation, exact-run Stop, and a simple conversation
list. This count is not an implementation estimate; it proves only that “build the
entire chat interface” is the wrong premise.

The remaining work is the application-specific part: canonical catalog identity,
cross-source lineage, discovery/import, attention generations, async settlement,
notification policy, attachments, and bindings to existing runtime owners.

## What note integration concretely enables

Making Thinkering the surface is valuable only if sessions become part of its
semantic workspace rather than a prettier chat sidebar:

- a session can bind exact `Project`, `WorkIntent`, selected note/source revisions,
  and later `ChangeSet` verification without copying unrelated notes into a model;
- Tejas can promote an exact assistant excerpt into a Source, Decision, Learning,
  open question, or follow-up with its session/event provenance, while the native
  transcript remains authoritative;
- a session card can answer “what work does this advance?” and “which decision is
  waiting?” rather than merely “what was messaged recently?”;
- search can traverse note concepts, requirements, decisions, artifacts, and
  session evidence, then return the exact branch and fidelity instead of a Slack
  text match;
- branch lineage can sit beside the WorkIntent and ChangeSets it produced, so a
  forked alternative is not confused with a newer reply in one flat thread;
- Done can remove an attention generation without closing the underlying work,
  while archive remains a recoverable catalog action and Stop targets only the
  exact run;
- session closure can propose—not silently endorse—decisions, learnings, unresolved
  questions, and reusable evidence into Thinkering's existing Review flow.

Slack could link to some of these objects, but it cannot own atomic revisions,
evidence relationships, local-first projections, or Thinkering's human-acceptance
rules. Rebuilding those semantics in Block Kit would make Concierge a second
knowledge application.

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

The companion discovery design sharpened this brief's earlier identity proposal.
Do not mint a universal surrogate `AgentSession.id` around every native session.
Use a tagged `AgentSession.key`: the provider's exact stable native identity when
one exists, and a Thinkering synthetic UUID only for an ID-less import or a new
reconstruction. This identifies one specific branch of continuity. It never means
“whichever branch is newest,” and it never changes to point at another branch.

A lineage family is derived from explicit relations:

```text
AgentSession
  key
    native?                  # provider + account/profile scope + native session ID
    synthetic?               # Thinkering UUID + id_less_import | reconstruction
  lineage_root_key
  parent_session_key?        # another AgentSession
  fork_point_event_id?
  derivation                # native | fork | reconstruction | import
  project_id?
  work_intent_id?
  title
  summary_revision
  catalog_state             # active | archived
```

A native provider fork uses its own exact native key. A reconstruction or ID-less
branch receives a synthetic key. Both record an immutable `derived-from` relation;
the source session is not rewritten. The UI may group the family and label a
preferred branch, but the interaction API never accepts a mutable family pointer
as a target.

### Provider and transport identities are bindings

Native and surface identities map onto the canonical session:

```text
ExternalSessionBinding
  agent_session_key
  adapter_kind              # runtime | transcript-replica | slack | ...
  adapter_instance          # account/installation/host namespace
  external_session_id
  external_branch_id?
  source_revision?
  capability                # live | resumable | offline | imported-readonly
  fidelity                  # native | reconstructed-role-history | summary-only
```

The native tuple is the canonical key when available, not merely another binding.
Runtime locations, transcript replicas, and Slack roots bind around it. A Mac live
file and its AX41 archive copy are replicas of one session, not new sessions or
forks. Slack roots never become canonical addresses.

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
  agent_session_key
  title
  current_summary
  matched_evidence[]        # exact source/event pointers plus short excerpts
  capability
  fidelity
  lineage_context
  last_meaningful_event
```

The index may rank candidates, but it cannot choose one merely because it ranked
first. A caller sends only after selecting one exact `agent_session_key`; an
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
  target_agent_session_key  # exact AgentSession.key
  source_input_ref          # service-issued, transport-independent authorization
  source_action_id          # stable within source_input_ref
  sender_actor
  source_agent_session_key? # durable return address for an agent caller
  target_interaction_ref?   # exact active interaction, required for steering
  reply_to_interaction_id?
  content_parts[]           # text plus immutable attachment/source references
  cited_evidence_refs[]
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
  target_agent_session_key
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

If later real use earns it, a dedicated private Slack channel could be an optional
compact client of the same contract. It is not part of the recommended first
delivery:

- one Concierge-authored root binds an exact `AgentSession.key`;
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
| Talk to the existing agent through the management entry | Session composer submits to exact `AgentSession.key`; runtime resolves lifecycle |
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

## Reconciliation with the discovery/ownership brief

The companion `2026-09-14-agent-session-discovery-ownership.md` design on branch
`worktree-agent-session-discovery-contract` and this brief converge on the
important boundary:

- Thinkering owns canonical session identity, catalog metadata, lineage,
  discovery, attention, and the primary UI;
- Concierge retains runtime admission/recovery for the sessions it already
  manages and owns their Slack bindings;
- provider stores and imports own raw transcripts;
- Slack is an optional adapter, never the global identity or transcript store;
- search returns exact evidence and capabilities, never an inferred communication
  target.

There was one real conflict. The first version of this brief proposed a new
surrogate `AgentSession.id` for every session. The discovery design demonstrated
that the exact native `(provider, account/profile scope, native session ID)` is
already sufficient and avoids a mapping migration. This revision adopts its
tagged `AgentSession.key` and uses a synthetic Thinkering UUID only when no stable
native ID exists. The discovery design is otherwise a more detailed elaboration,
not a competing architecture.

## Consolidated material decisions

These replace the earlier six Slack-channel questions. Each original issue is
retained, but the channel question is now a surface-and-adapter question. The
recommended defaults form one coherent answer; Tejas can approve them together or
override any numbered item.

1. **Primary surface and Slack role.** Recommended: Thinkering is canonical;
   Slack remains a notification/capture/source-thread adapter. Do not create
   `#agent-sessions`, use Concierge DM as the management list, or create a
   dedicated Slack agent in the first delivery. Confirm?
2. **Which sessions appear.** Recommended: catalog every exactly identified live
   or imported session, but put only sessions with current meaningful attention
   or an explicit pin in the working set. Exclude routing receipts, capture-only
   messages, and unselected comparison children. Do you instead want explicit
   opt-in before any session enters the catalog or working set?
3. **Done and reopening.** Recommended: Done dismisses only the current attention
   generation; a later Tejas-authored turn, needs-input event, result, or failure
   reopens it. Archive is the separate sticky exclusion until Restore. Confirm?
4. **Visibility of a reply sent from Thinkering.** Recommended: if the session was
   born in a Slack source thread, mirror the exact accepted Thinkering input and
   its progress/result to that bound source thread so it remains readable. A
   Thinkering-native session should not manufacture a Slack thread unless Tejas
   explicitly enables a projection. Should Slack-originated sessions instead
   become Thinkering-only after attachment?
5. **Which surface notifies on completion.** Recommended: while Thinkering lacks
   proven background push, Slack sends the single OS-level notification for
   needs-input, result-ready, and failure; Thinkering updates in-app without a
   second push. After Thinkering Web Push is proven, choose one notifier per event,
   defaulting to Thinkering. Do you want completion on both surfaces?
6. **Controls and emoji.** Recommended: Thinkering uses labeled Stop, Done,
   Archive/Restore, Fork, and retry/recovery controls. Slack keeps native Stop and
   only `:white_check_mark:` as a Done command when a projection exists; state
   emoji are display only, not duplicate commands. Do you want Stop, Retry,
   Restore, or Fork reactions too?
7. **Ordering.** Recommended: Needs input, failed/ambiguous, and result ready rank
   above active work; explicit pins/manual order come next; recency is only the
   final tie-breaker. Done removes the current generation without deleting the
   session. Is that the right default ordering?
8. **Capture transition.** Recommended: leave Monologue, Pebble's Slack gestures,
   Thinkering Send to Slack, Slack files/clips, and `/audio` unchanged while the
   primary surface moves. Reroute an individual flow only after its exact
   Thinkering destination, full-content behavior, receipt, and notification are
   proven. Which, if any, should move in the first delivery?
9. **Imported-session contact.** Recommended: selecting an exact imported/offline
   session for a consultation may automatically create a clearly labeled,
   source-cited child; anything that may mutate files or external state requires
   a proven runnable binding and confirmation. Should even read-only consultation
   require confirmation before creating the child?

No implementation should start until these are answered together. If Tejas says
“use the defaults,” the design is complete enough to plan one coherent delivery.

## Explicit implementation-ownership handoff (inactive)

Because the design selects Thinkering as the primary surface, future approved
implementation should be led from the Thinkering project. This document remains
the decision record in the current Slack thread; it should be linked, not copied
or reinterpreted into a new design conversation.

- **Thinkering** owns `AgentSession.key`, catalog/lineage, working-set and detail
  UI, attention/Done/archive, note/evidence integration, and the authenticated
  transport-neutral client contract.
- **Slack Concierge** owns the adapter for existing Slack-root sessions,
  Slack-native progress/results/controls, and runtime admission/recovery for the
  sessions it already manages.
- **remote-box and Concierge capture** retain Monologue and capture-route ownership
  until an explicitly approved route change.
- **Provider adapters** retain native thread/run execution and transcripts.

This is a handoff of implementation ownership, not implementation approval. The
consolidated choices above remain paused.

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
- Companion discovery design, branch `worktree-agent-session-discovery-contract`,
  `docs/brainstorms/2026-09-14-agent-session-discovery-ownership.md`
- [Thinkering's AgentSession and adapter boundary](https://github.com/tejasdc/thinkering/blob/5d3b6746daa421b720c9014f1b7a639da5390703/docs/design.readme.md#agents-history-and-interpretations)
- [Thinkering product requirements](https://github.com/tejasdc/thinkering/blob/5d3b6746daa421b720c9014f1b7a639da5390703/docs/requirements.md)

Current primary product/library sources:

- [Slack authentication](https://docs.slack.dev/authentication/)
- [Slack notifications](https://slack.com/help/articles/360025446073-Guide-to-Slack-notifications)
- [Slack Activity](https://slack.com/help/articles/46751260742035-Introducing-the-new-Activity-view-in-Slack)
- [Slack search](https://slack.com/help/articles/202528808-Search-in-Slack.)
- [Slack retention](https://slack.com/help/articles/203457187-Customize-data-retention-in-Slack)
- [Slack files](https://slack.com/help/articles/201330736-Add-files-to-Slack)
- [Slack clips](https://slack.com/help/articles/4406235165587-Record-audio-and-video-clips-in-Slack)
- [assistant-ui thread lists](https://www.assistant-ui.com/docs/primitives/thread-list)
- [assistant-ui remote thread adapters](https://www.assistant-ui.com/docs/runtimes/concepts/threads)
- [assistant-ui attachments](https://www.assistant-ui.com/docs/guides/attachments)
- [AG-UI overview](https://docs.ag-ui.com/introduction)
- [Vercel AI SDK `useChat`](https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat)
- [Pi monorepo](https://github.com/badlogic/pi-mono)
- [OpenAI Symphony](https://github.com/openai/symphony)

## Raw premise challenge (preserved verbatim)

The following attached source is authoritative. It is preserved without
compression so the decision can be reconstructed later.

> Premise challenge from Tejas (Monologue, 2026-09-14T22:32, verbatim at the end). It lands directly on the recommendation you delivered at 22:18, so treat it as re-opening the surface decision, not as a detail.
>
> His argument: we are contorting ourselves around Slack's constraints while building many features. The question he wants asked is why agentic session management cannot simply be rolled into Thinkering. We now understand what we need from Slack and what does not work there. Building it in Thinkering would let us keep improving session management and make it our own. His prior concern was managing all the chats and threads, but he now believes that is probably a solved problem, since existing libraries do what Slack does for chat and session display. He also expects working there to yield the right patterns for integrating session management with note-taking. He names an intermediate option - keep the conversation in Slack and use it as the backend so we need not build a chat interface - then questions that too, on the grounds that Slack is little more than an interface for showing messages and sessions, so depending on it is not a large uplift.
>
> Do not proceed on the dedicated #agent-sessions recommendation. Re-open the surface comparison with Thinkering as a first-class option, under the global rule now governing recommendations: state the objective and requirements being judged, the strongest alternatives including the upstream/native path and doing nothing, where each wins and loses, quantified costs where measured, what is lost by bypassing Slack's existing behavior, and who owns the divergence and its maintenance. Label unmeasured claims as hypotheses.
>
> Determine rather than assert:
> - What Slack actually supplies that would have to be rebuilt or replaced: identity and auth, notification delivery including mobile push, message persistence and search, file and audio capture, native mobile/desktop clients, and the capture ingress paths (Pebble, Monologue, Thinkering send-to-Slack) that currently terminate in Slack.
> - Whether his solved-problem premise holds: name actual candidate libraries and what they do and do not cover, instead of accepting or dismissing the claim.
> - The note-taking integration benefit: state concretely what becomes possible in Thinkering that Slack as the surface cannot do.
> - The hybrid he floats, Thinkering as management surface with Slack retained as transport, as its own option with its own costs.
>
> Reconcile rather than re-litigate: the agent-session-discovery brief already committed in this repo at docs/brainstorms/2026-09-14-agent-session-discovery-ownership.md proposes that Thinkering owns canonical AgentSession.id, catalog metadata and lineage, with Concierge as runtime/admission owner and Slack as an adapter. That position and this challenge are converging. Align with it and say plainly where they conflict.
>
> Keep the decision in this thread so it is not forked across two projects. If the design concludes Thinkering is the surface, implementation ownership moves to the Thinkering project and this thread hands off explicitly.
>
> After folding this in, re-ask the consolidated material decisions - your original six plus whatever this changes - as one question set. Design only; no implementation.
>
> Verbatim capture:
>
> By the way, a follow-up on the agent who's working on this. Like I was thinking, I mean, we're building so many features and like, you know, trying to build this like, you know, agentic session management in Slack and, you know, trying to contort ourself around Slack's, you know, thing here. But I'm thinking, uh, the other question to ask is like, you know, what is it-- why can't we just like roll that in into Thinkring, right? Uh, we understand what we need from Slack and what, what, uh, things are working from Slack. There's also a lot of things that are not working, and we're trying to like contort ourself. If we can build this whole thing into Thinkring, then we can keep improving how we handle agentic session management, right? Uh, and like, you know, make it our own and like, you know, have a nice way to do it. My only concern was like the how do we manage all of these, you know, chats and, uh, things, but really that probably could be a solved problem, you know? And I think working there will also give us the right patterns for identifying how to integrate session management with note-taking well. And I was thinking, you know, we can still have all of the thing happening inside Slack, so we don't have to build the, the entire chatting interface and like, you know, all of those things in. So that's still a pos-possible thing that we still use this as our back end or something. But we-- that could also be very much questioned, right? You know, why, why do we need to do all of these things if we can ma-- do the good session management chat and there's like existing libraries that help us do what chat, session, uh, what, like, you know, what Slack is doing, you know? Which Slack isn't really doing this except like acts, acts, act, act like a interface to show messages and sessions, right? So I don't think that's like a huge uplift here that, you know, we need to rely on Slack.
