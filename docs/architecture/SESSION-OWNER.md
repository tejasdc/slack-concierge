# Unified session ownership

Concierge owns one session catalogue and execution ledger. Thinkering provides the authenticated surface and private source/browser capabilities. Slack is an optional input and projection adapter. The [wire contract](../contracts/session-owner-v1.md) is the shared API authority; the [joint proposal](../plans/2026-09-15-unified-session-convergence.md) preserves the approved scope and amendments.

## Identity and admission

The existing `sessions.id` is public as `concierge:<integer>`. An opaque address pins that row and its binding generation. Provider conversation IDs and original Slack roots remain exact bindings. A fork creates a distinct child with an exact boundary; a verified replacement binding advances the generation. Search ranking, a matching title, an import namespace or a provider UUID alone cannot establish ownership.

Discovery matches current catalogue titles, summaries and project names alongside retained dialogue. A catalogue-only match has an empty dialogue evidence array and the exact current session view; it cannot fabricate a message or collapse equal titles. Context resolves the selected address before communication.

Both native input/run and accepted Slack source callers of `sessions search` use this
same owner search and receive `{results:[{session,evidence}],coverage}`. The usable address
is `result.session.address`; `concierge:<id>` is a catalogue ID, not an addressed binding.
Retained session inputs and provider messages are considered before catalogue-only and
legacy routing matches, so the result limit cannot be filled by Slack evidence before
native dialogue is examined. Slack routing evidence retains its caller cutoff and exact
visible-root exclusion. A top-level human session continued in Thinkering remains the
same session even when its original Slack root no longer resolves to it. Provider child
sessions are not imported into this ownership model by discovery.

`session_inputs` retains authenticated accepted content, action identity, origin, optional request correlation, and its existing turn/steering binding. It is not another execution queue. An input can be held without a turn. `turns.native_run_id` is the stable UUID alias of that existing execution; several steering inputs can share it. Existing Slack turn and provider IDs are never renumbered. Input, request, event, run and provider IDs remain distinct.

Thinkering's server authenticates its human session and origin, validates chosen workspace revisions, and submits through the root-private owner socket. The owner issues the accepted-input identity atomically with the immutable action payload. Agent tools instead prove an existing input and its exact admitted run. Browser/model actor claims cannot become human authority. Trusted server adapters share the existing root host boundary; the socket is not a security boundary against an arbitrary root process.

For ordinary native Codex/Claude execution, the host conveys the admitted origin through the existing provider application instructions and a per-input JSON identity header followed by the message as plain text. The header comes from `session_inputs`; the human task is not serialized inside a quoted JSON content field. The body contains the human message, agent request or service result, selected context and attachment guidance. Earlier stored JSON envelopes retain their original authors and evidence; they are not rewritten. Human origin means authenticated human instruction, regardless of the service transport. Agent requests and service returns can continue already-authorized work but grant no new human authority. Body actor claims and quoted envelopes cannot replace the owner-generated identity. Each steered input keeps its own origin, including a human follow-up after a service result in the same run. Ordinary Slack provider preparation includes the same identity-header contract so a later native input can enter its existing live execution. Claude receives the contract through `--append-system-prompt`, Codex through application additional context; it is not appended as purported user authority. Receipts retain the exact accepted text and replay retains the actual prepared message. Restricted consultation and ChatGPT retain their existing preparation/capability boundaries.

The owner retains uploaded bytes and their hash before input preparation. Selected revision text is produced by the authenticated surface, checked against exact object references and hashes, then retained independently of the human message. No common owner reads Thinkering's workspace database. Human source evidence is one pinned source/version/event reference and never an implicit provider bind.

Common history and live message events restore readable accepted input at their read boundary. `session-history-projection.ts` matches a user message's native ID, native turn and exact observed content to a retained provider event, then to exactly one native input's prepared replay or final admission prompt hash in the same owned turn. The admission hash includes any interrupted-history prefix added after replay preparation. It does not parse envelope JSON for identity. A proven match exposes the immutable accepted text, attachment custody descriptors and accepted input ID as `submissionId`, so the surface resolves the correct human/agent/service receipt even during mixed-origin steering. Native message IDs, fork boundaries, tool details, cursors and raw provider events remain unchanged. Exact-source context reads still use raw native evidence and its original hashes. Quoted envelopes, unmatched messages and unbound archive history stay literal evidence; absent proof never invents attribution. Provider preparation, attachment paths and selected-context scaffolding remain in retained execution evidence rather than the conversation display.

## One execution owner

Provider availability uses the shared [usage reset cache](PROVIDER-USAGE.md) inside the
existing adapters. Its explicit clear and timestamp expiry affect future attempts only;
neither owns replay, queue promotion, Stop or recovery.

`SessionExecutionHost` dispatches native inputs through the same `SessionTurnQueueCoordinator`, durable claims, `ActiveTurnDispatchRegistry`, `executeAgentTurn` and provider adapters as Slack. Explicit human queue/steer controls validate the observed run; agent requests leave that choice to the coordinator. Native fork controls serialize in their parent's existing FIFO, preserve the parent binding and create the child only from exact native evidence. There is no provider writer in the Thinkering consumer.

Terminal observations may arrive before asynchronous executor cleanup releases the live registry. Both runtime compositions pass the registry's still-active sessions into the existing atomic queue claim; ordinary Slack admission defers through the same FIFO at that boundary. Registry settlement wakes promotion after releasing its owner. Native setup failures use the exact owned dispatch attempt: before admission or unsafe effects they fail the turn and release the cached session state together; after admission intent they retain ambiguity through the existing parked-turn path. Late failures cannot rewrite a settled result or another attempt, and no setup failure replays an input.

The existing recovery owner distinguishes unattempted input, a known-dead ambiguous attempt, and a saved result. Only proven unattempted work can resume without new effect evidence. Saved results return without another provider call. Ambiguous effects remain inspectable. A deliberate Stop cannot become an automatic retry. Unconfirmed interrupted model input can be supplied as labeled historical context to a later authorized input; it is not permission to repeat prior actions. Native fork controls are excluded from that model history.

Known terminal state stays monotonic. A native result and its notification are distinct from any correlated answer. The shared Codex app-server observer is composed in both Slack-enabled and Slack-disabled owner runtimes and subscribes to each uniquely bound active native session, independent of whether that session still has an eligible Slack projection. Each successful attach or reconnect records a history invalidation so an already-open surface reads retained items that predate the subscription. Future completed user, assistant and tool items enter the common owner observation stream with their exact provider message and turn IDs; Slack mirroring remains a separate projection of its narrower eligible subset. On-demand history/detail reads use the same native item shapes. Cursor replay rebuilds a view, never submits another run. Archive, pause, outcome, read and attention retain separate meaning.

Native results and actionable setup errors, provider refusals, parked uncertainty and interrupted/delivery-parked recovery advance attention once per accepted input/dispatch attempt. The existing event ledger retains the attention marker atomically with the generation increment; successful result retention and failure projection share that marker. A retained pre-turn unavailable creation uses its accepted input with attempt zero. This updates neither outcome nor read/dismiss generations, and a stale read or dismiss cannot hide a later failure. Prior result events already prove their attention increment, so compatibility projection does not count them again.

The existing session projection subscribes to native terminal facts as well as Slack facts. Installation performs one catch-up query over retained accepted inputs and their turn rows, recording only actionable native failures without an attention marker. Its cost scales with retained accepted inputs; each selected row receives one event/metadata transaction and ceases to qualify. There is no idle work, timer, provider admission or repair queue. This catches the observed already-retained ChatGPT failure and owner-death recovery without changing input bytes, execution state, provider identity or replay eligibility. Reinstallation and repeated recovery preserve read/dismiss decisions.

A confirmed nonretryable native provider refusal settles as a failed input and releases its session. It is not an uncertain send or an invitation to retry. The existing Slack remediation flow and genuinely ambiguous native effects retain their previous parking behavior.

## Session names

Router dispatch supplies an explicit initial name through `--session-name`,
mapped to the existing canonical metadata `title`. Native create and first
input retain that field atomically; routed admission initializes it before
execution and emits a normal owner event. Existing named sessions and later
human renames survive duplicate dispatch. Thinkering consumes the same
`SessionView.title` in its list and detail heading. See the
[wire contract](../contracts/session-owner-v1.md#session-names) for the parameter
and the separate agent-refinement policy decision, which does not block initial naming. No provider prompt parser,
second naming store, backfill or transcript-title rewrite is involved.

## Requests and returns

`session-communication.ts` retains the existing request/event ledger. Request acceptance atomically retains the immutable target, source, content, due time, prerequisites, mandatory return obligation and native target input before dispatch. A reply names exactly one request. Partial answers may precede its final; ending a turn with other outstanding questions returns an unconfirmed-answer disposition with retained output references.

Request prerequisites wait outside session FIFO, so the reply needed to unblock a continuation can enter the requesting session. Native return events use the same accepted-input and queue machinery. A return may steer only into its exact original asking run while that run remains live. Otherwise it enters FIFO, including when another return or human input is running in that session; idle requesters resume through the same queue. A proven-unsent live return keeps its input/event identity when queued; the failed steering remains evidence and the new queue placement has its own observation identity. Ambiguous sends are never re-enqueued by the conversation layer.

ChatGPT and consultation-only recipients cannot invoke reply tools. Their incoming requests queue as separate inputs. The service correlates a final result only for the exact acknowledged request input, one question, no intervening steering and a completed native execution. Otherwise it returns the unconfirmed-answer disposition and output references. Consultation-only targets reject requests for work before acceptance.

An agent's addressed ask can select a historical `consult:true`, `send:false` source. The owner verifies its retained version, branch, boundary and dialogue hashes using the same evidence preparation as human consultation. It atomically creates a distinct restricted child, its agent-origin consultation input, the requester operation and mandatory correlated return. Supplied evidence must belong to that exact dialogue; work and attachments are refused. Source/action duplicates keep the same child and request identity. The source run and binding are revalidated after asynchronous evidence retrieval, before provider dispatch. The child uses the existing informational policy/FIFO, and the service returns its exact acknowledged result. Agents never enter the human consultation route or acquire human origin.

Refreshing an imported source to a different retained version advances its address binding generation while preserving its canonical session ID. Search returns the current view after that refresh; an old address cannot silently contact newer history.

Explicit human ChatGPT intent is interpreted by the existing admitted agent's application instructions. `router-actions.sh sessions ask --provider chatgpt` uses the same source-bound request owner as an addressed ask. Atomic acceptance creates one native ChatGPT session through `SessionOwner`, its agent-origin `create` input, the request operation and mandatory return. The HTTP spelling is `targetProvider:"chatgpt"` instead of `targetAddress` on `POST /sessions/v1/requests`. An exact native input/run or accepted Slack input supplies provenance; text cannot grant human origin, restricted consultation cannot escape policy, and ChatGPT cannot create outbound requests. Source/action retries retain the original target even when unavailable.

Unavailable creation retains a failed operation without a provider turn and returns that failure through the existing service input. An exact ChatGPT attempt parked by its execution owner may likewise settle the request as failed using its retained error once the owner release, ended timestamp and failure class are durable. The provider turn stays parked; this observation does not release its session lock, satisfy provider dependencies or authorize replay. Configured admission and capability evidence remain on the exact operation. No new queue, provider owner, recognizer or fallback is involved.

One due time and one timer inspect unresolved work after 30 minutes. It records health and a durable notice; it does not infer success, override Stop or replay an ambiguous effect. No pending deadline means no timer. An empty queue scan emits no execution-change wake. There is no autonomous conversation quota, periodic repair scan or second scheduler. The [routed request architecture](ROUTED-REQUESTS.md) retains Slack publication and fixed `work/--after` semantics.

## Read-only sources and provider capabilities

Before a native ChatGPT binding exists, the provider history adapter returns no native page so the common owner can show its retained input/output history with incomplete coverage. This read never invokes the ChatGPT capability or changes the uncertain attempt. Once bound, the exact account/conversation reference remains required and capability failures remain visible; imported source history retains its existing source-reader path.

Slack routing indexes only Slack-provenance inputs, including genuine Slack steering on a native run. Accepted native steering and service returns stay in the common owner catalogue instead of becoming malformed Slack sources. The projection version rebuilds that source boundary on upgrade. Existing views are preserved transactionally while the nullable Slack-column migration replaces their underlying tables.

Thinkering's existing process serves the configured root-private capability socket. The source reader retains original bytes, exact version/branch/event/role/locator/hash and coverage. Partial inventory stays partial. Importing history creates searchable source provenance, not an execution owner. Historical candidates visibly carry `consultation-only` and separate availability before context/contact.

An authenticated host/surface may request one ChatGPT inventory pass through `POST /sessions/v1/sources/refresh`. The owner invokes the configured capability's existing refresh instance; it never starts a new scheduler, retries a rate limit or sends a model input. Startup restores retained bytes without a browser refresh. Search retains the actual saved/pending coverage.

Mac consultation creates a distinct common-catalogue child from a pinned cited dialogue packet. Initial and subsequent execution, retry and recovery enforce the same information-only policy: no tools, filesystem changes, network or outbound session messaging. A native fork that cannot retain that policy is unavailable. The service supplies correlated results without exposing outbound model tools to that child. Native continuity and reconstructed evidence remain different fidelity claims.

Codex reads effective configuration for every consultation thread start/resume, including recovery, and disables each configured MCP server through one structured `mcp_servers` override. Nested server names remain literal, including dots and quotes; Codex's dotted override paths do not interpret quoted segments. Native table merging preserves each server's existing transport while setting `enabled: false`. No host profile or daemon configuration is rewritten. The remaining tool, filesystem, network and outbound-action restrictions still apply, and the provider must confirm the restricted permission profile before turn admission. The parser contract is pinned to [Codex 0.153.4 overrides](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/config/src/overrides.rs) and [table merging](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/config/src/merge.rs).

ChatGPT uses its original account/conversation/browser binding. Explicit human bind retains a control intent before independent source/account/anchor verification. The capability adapter independently reads the exact owner operation and current binding before any browser send. Prepared bytes/model/attachment hashes are pinned at provider admission. Existing-effect observation and reconciliation never resend. Failed start, unavailable browser and uncertain send remain visible ChatGPT outcomes; another provider is never silently substituted. Inventory and snapshots grant no execution. There is no ChatGPT MCP endpoint or outbound model session tooling.

## Composition and operation

The common API uses the existing `<CONCIERGE_STATE_DIR>/requests.sock`, mode0600. The systemd source configures `CONCIERGE_SESSION_CAPABILITY_SOCKET=/run/thinkering/session-capabilities.sock`; Thinkering hosts that socket in its existing process with a private parent directory. Sandbox configuration must supply only its own capability path.

Slack remains enabled by default. With `CONCIERGE_SLACK_ENABLED=0`, `session-runtime.ts` starts the same owner/FIFO/providers without loading Slack configuration, authenticating Slack or publishing an input. Existing Slack bindings remain retained provenance. Normal provider tools receive their exact owner's state/socket and helper backing through service-issued execution environment; an isolated source run cannot fall back to production. Headless legacy Slack helpers receive no Slack credential source.

This change does not import discarded Thinkering extraction bookkeeping or implement a replacement extraction runner. Thinkering's `workspace.sqlite` and published effects remain untouched. Completed extraction/transform work must never be replayed or republished.

Selected workspace revisions reach provider preparation only through the authenticated surface's hash-verified `context` snapshots. Saved shared/workflow instruction files remain editable in Thinkering; the common owner does not read or apply those files, create workflow-folder outputs, or revive the held runner callbacks. The surface must not claim those execution effects while that path is held.

## Executable authorities and acceptance

| Boundary | Authority |
| --- | --- |
| Additive schema, exact inputs, aliases and events | `session-schema.ts`, `session-inputs.ts`, existing `state.ts` |
| Surface contract and controls | `session-owner.ts`, `native-session-controls.ts`, `session-owner-v1.md` and its fixtures |
| FIFO, execution and native result recovery | `session-execution-host.ts`, `session-turn-queue.ts`, `turn-dispatch-seams.ts`, `turn-execution.ts`, `turn-recovery.ts` |
| Private source/browser transport and policy | `session-capability-client.ts`, `provider-policy.ts`, native adapters |
| Runtime environment and observations | `provider-owner-environment.ts`, `provider-history.ts`, `session-projection.ts`, `session-runtime.ts` |
| Conversation correlation and due notices | `session-communication.ts` and the existing request/event ledger |

Focused tests cover immutable acceptance, exact source authority, independent question settlement, held/idle/ambiguous returns, native controls, restricted policy, provider history and runtime restart. The full delivery also requires the real sandbox removal case: a genuinely Slack-born provider session and a new authenticated Thinkering session exchange correlated partial/final replies both directions with Slack absent and original native identity retained. New-to-new or scripted-provider tests alone do not establish that. C1/X1 actual source custody, common-owner consultation and same-child follow-up are separate required evidence. Existing Slack regression acceptance remains required while Slack is enabled.
