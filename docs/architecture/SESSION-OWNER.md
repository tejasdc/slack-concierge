# Unified session ownership

Concierge owns one session catalogue and execution ledger. Thinkering provides the authenticated surface and private source/browser capabilities. Slack is an optional input and projection adapter. The [wire contract](../contracts/session-owner-v1.md) is the shared API authority; the [joint proposal](../plans/2026-09-15-unified-session-convergence.md) preserves the approved scope and amendments.

## Identity and admission

The existing `sessions.id` is public as `concierge:<integer>`. An opaque address pins that row and its binding generation. Provider conversation IDs and original Slack roots remain exact bindings. A fork creates a distinct child with an exact boundary; a verified replacement binding advances the generation. Search ranking, a matching title, an import namespace or a provider UUID alone cannot establish ownership.

Discovery matches current catalogue titles, summaries and project names alongside retained dialogue. A catalogue-only match has an empty dialogue evidence array and the exact current session view; it cannot fabricate a message or collapse equal titles. Context resolves the selected address before communication.

`session_inputs` retains authenticated accepted content, action identity, origin, optional request correlation, and its existing turn/steering binding. It is not another execution queue. An input can be held without a turn. `turns.native_run_id` is the stable UUID alias of that existing execution; several steering inputs can share it. Existing Slack turn and provider IDs are never renumbered. Input, request, event, run and provider IDs remain distinct.

Thinkering's server authenticates its human session and origin, validates chosen workspace revisions, and submits through the root-private owner socket. The owner issues the accepted-input identity atomically with the immutable action payload. Agent tools instead prove an existing input and its exact admitted run. Browser/model actor claims cannot become human authority. Trusted server adapters share the existing root host boundary; the socket is not a security boundary against an arbitrary root process.

The owner retains uploaded bytes and their hash before input preparation. Selected revision text is produced by the authenticated surface, checked against exact object references and hashes, then retained independently of the human message. No common owner reads Thinkering's workspace database. Human source evidence is one pinned source/version/event reference and never an implicit provider bind.

## One execution owner

`SessionExecutionHost` dispatches native inputs through the same `SessionTurnQueueCoordinator`, durable claims, `ActiveTurnDispatchRegistry`, `executeAgentTurn` and provider adapters as Slack. Explicit human queue/steer controls validate the observed run; agent requests leave that choice to the coordinator. Native fork controls serialize in their parent's existing FIFO, preserve the parent binding and create the child only from exact native evidence. There is no provider writer in the Thinkering consumer.

The existing recovery owner distinguishes unattempted input, a known-dead ambiguous attempt, and a saved result. Only proven unattempted work can resume without new effect evidence. Saved results return without another provider call. Ambiguous effects remain inspectable. A deliberate Stop cannot become an automatic retry. Unconfirmed interrupted model input can be supplied as labeled historical context to a later authorized input; it is not permission to repeat prior actions. Native fork controls are excluded from that model history.

Known terminal state stays monotonic. A native result and its notification are distinct from any correlated answer. Exact provider message and tool IDs feed the shared observation stream and on-demand history/detail reads. Cursor replay rebuilds a view, never submits another run. Archive, pause, outcome, read and attention retain separate meaning.

A confirmed nonretryable native provider refusal settles as a failed input and releases its session. It is not an uncertain send or an invitation to retry. The existing Slack remediation flow and genuinely ambiguous native effects retain their previous parking behavior.

## Requests and returns

`session-communication.ts` retains the existing request/event ledger. Request acceptance atomically retains the immutable target, source, content, due time, prerequisites, mandatory return obligation and native target input before dispatch. A reply names exactly one request. Partial answers may precede its final; ending a turn with other outstanding questions returns an unconfirmed-answer disposition with retained output references.

Request prerequisites wait outside session FIFO, so the reply needed to unblock a continuation can enter the requesting session. Native return events use the same accepted-input and queue machinery. A return may steer only into its exact original asking run while that run remains live. Otherwise it enters FIFO, including when another return or human input is running in that session; idle requesters resume through the same queue. A proven-unsent live return keeps its input/event identity when queued; the failed steering remains evidence and the new queue placement has its own observation identity. Ambiguous sends are never re-enqueued by the conversation layer.

ChatGPT and consultation-only recipients cannot invoke reply tools. Their incoming requests queue as separate inputs. The service correlates a final result only for the exact acknowledged request input, one question, no intervening steering and a completed native execution. Otherwise it returns the unconfirmed-answer disposition and output references. Consultation-only targets reject requests for work before acceptance.

One due time and one timer inspect unresolved work after 30 minutes. It records health and a durable notice; it does not infer success, override Stop or replay an ambiguous effect. No pending deadline means no timer. An empty queue scan emits no execution-change wake. There is no autonomous conversation quota, periodic repair scan or second scheduler. The [routed request architecture](ROUTED-REQUESTS.md) retains Slack publication and fixed `work/--after` semantics.

## Read-only sources and provider capabilities

Slack routing indexes only Slack-provenance inputs, including genuine Slack steering on a native run. Accepted native steering and service returns stay in the common owner catalogue instead of becoming malformed Slack sources. The projection version rebuilds that source boundary on upgrade. Existing views are preserved transactionally while the nullable Slack-column migration replaces their underlying tables.

Thinkering's existing process serves the configured root-private capability socket. The source reader retains original bytes, exact version/branch/event/role/locator/hash and coverage. Partial inventory stays partial. Importing history creates searchable source provenance, not an execution owner. Historical candidates visibly carry `consultation-only` and separate availability before context/contact.

An authenticated host/surface may request one ChatGPT inventory pass through `POST /sessions/v1/sources/refresh`. The owner invokes the configured capability's existing refresh instance; it never starts a new scheduler, retries a rate limit or sends a model input. Startup restores retained bytes without a browser refresh. Search retains the actual saved/pending coverage.

Mac consultation creates a distinct common-catalogue child from a pinned cited dialogue packet. Initial and subsequent execution, retry and recovery enforce the same information-only policy: no tools, filesystem changes, network or outbound session messaging. A native fork that cannot retain that policy is unavailable. The service supplies correlated results without exposing outbound model tools to that child. Native continuity and reconstructed evidence remain different fidelity claims.

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
