# Routed requests and execution dependencies

The inbox router interprets explicit waiting intent and resolves named work to exact existing execution references. Concierge validates those references and owns publication and execution admission for every routed request. Product channels need no agent-side scheduler or second language classifier.

`router-actions.sh post`, `resume`, and `upload` call `POST /requests` on the running service's private `requests.sock` inside its state directory. The socket is owner-only and runtime-scoped; there is no public ingress, new credential, daemon, broker, or polling worker. Audit and read-only receipt verbs retain their existing transport. The [router runbook](../runbooks/ROUTER-ACTIONS.md) owns CLI syntax.

## Publication and intake ownership

`routed-requests.ts` serializes publication and input classification per destination channel. A request's exact source input and stable split-action ID identify one operation. The source must already be an accepted user input in the ledger; the caller cannot supply an alternate requester. Payload conflicts under the same source/action fail before any new publication.

The service commits the task, destination, direct dependencies, requester, payload hash, and publication intent to `routed_requests`. Attachment bytes are copied into `routed_request_files` in that same transaction before Slack calls. The service uses the existing user token and `router-post.ts` transport. Text conversion and the single `routed-request.txt` presentation for long tasks remain shared. Admission retains the original task text, including provider aliases that may now live inside the Slack attachment, and attaches the exact uploaded file metadata.

An optional `provider` alias is part of the caller's idempotency hash. The service resolves `provider_selection` once at acceptance and stores it in the same request payload, separate from the caller hash. Recovery and duplicate submissions reuse that decision. This internal selection records new-session isolation and, for a cross-provider resume, its source and exact turn dependencies. The destination queue owner adds the immutable continuation snapshot to that existing record before provider invocation. The visible provider prefix belongs to publication, not the canonical task text. [Provider sessions](PROVIDER-SESSIONS.md) owns precedence, continuity, and usage policy.

Slack events enter `routed_input_events` durably before waiting for the channel owner. An early publication echo cannot classify, steer, capture, or create a turn while publication owns the channel. The exact posting/file-share receipt binds the request to the normal input ledger. The owner invokes normal admission even without an echo; later echoes are duplicates of the same `(channel, message_ts)`. Direct human inputs follow the same channel owner. Provider execution starts through the existing queue and never holds the channel owner.

The first event insert uses the existing transient SQLite retry contract. Shutdown waits for pending persistence before releasing the coordinator; an input persisted during shutdown remains available for startup admission.

Publication intent, reserved file IDs, delivery uncertainty, and confirmed timestamps survive process exit. Network calls occur outside SQLite transactions. Startup proves prior owners dead before recovering requests and input classification. An exact receipt resumes the same request; a known file ID uses existing share recovery. A text echo carrying the exact client message ID can establish recovery identity. Ambiguous publication without exact proof parks the request and preserves channel exclusion; it never causes a blind repost or a dependency-free execution. Other channels remain independent.

Publication evidence is monotonic: receipt reads and their failures cannot downgrade confirmed or uncertain publication to “not sent” or erase known message/file identities. A parked channel's accepted successors remain durable but are not active publication for deployment drain. A publication that can actually proceed still participates in drain ownership.

The source/action request record and receipt remain the deduplication authority. Attachment byte copies are removed after durable admission, when Slack and the existing input attachment lifecycle own them. Waiting itself creates no recurring work. Acceptance processes one finite payload and its selected edges; queue/terminal events and startup evaluate outstanding dependencies. Existing durable projection workers own reaction retries and stop after convergence or explicit parking.

## Execution semantics

`turn_dependencies` records unique direct edges to older turns. The older-only rule plus existing ascending session FIFO prevents cycles. Both `acquireSessionTurn` and `claimNextQueuedTurn` require every prerequisite to be satisfied before provider ownership. An explicit empty deferral remains a separate turn, as does a deferred resume whose prerequisites already finished; neither becomes steering.

Execution lookup validates each supplied root/session/turn selector against its exact channel and triggering-message cutoff before filtering settled work. Unknown or mismatched identity is an error, never a complete empty selection. Lookup, reference validation, and provider outcome links share the canonical visible Slack root, including durable input claims and legacy session-mode rules.

Terminal execution and artifact owners latch satisfaction in `satisfied_at` and preserve the terminal `outcome`. Done, confirmed error/cancellation, and explicitly parked response delivery satisfy ordering after owned delivery has settled or parked. Provider retry, provider parking, interrupted/ambiguous ownership, and unfinished artifacts do not. Queue admission rechecks this state, including on startup. Later requests in those provider sessions do not alter the edge set or clear satisfaction. Destination-session FIFO remains an independent admission constraint.

The activated provider receives the captured references, outcomes, and available terminal summaries. Completion is an ordering condition; task conditions such as “only if tests pass” still require the destination agent to assess the actual results.

`wait_requested` marks opt-in waiting. A queued request projects `hourglass_flowing_sand` onto its own user message, through the existing durable reaction worker. Claim or terminalization requests removal. Revision-aware projection reconciles an add finishing after activation. There is no waiting reply, activity card, clock, or activation announcement. Normal progress begins only when the queue starts the provider.

## Authorities and checks

### Addressed session conversation

`session-communication.ts` composes with this request owner through the same
private socket. It does not own provider execution or another catalogue.
`sessions search` and `context` are a replaceable facade over the existing
router corpus, with explicit coverage and exact session/conversation evidence.
An opaque address pins the existing session row and visible root. Only this
new path supplies `expected_session_id`; admission revalidates it before live
steering or ordinary FIFO admission. Ordinary Slack routing is unchanged.
Messageability is distinct from resumability: the existing live-dispatch
registry proves an exact first-turn steering target before a native UUID has
been persisted. Idle delivery requires the existing persisted provider binding.

An accepted `session_communication_requests` row is both the immutable request
and its mandatory return obligation. Its exact accepted source input determines
sender identity. The row, payload hash, fixed prerequisite IDs and due time are
committed before routed publication. Existing source/action identity then binds
one routed effect, including a reply arriving during admission. Publication,
provider acknowledgement, semantic settlement and return admission remain
separate facts.

Partial replies append correlated events. A final reply atomically records its
answer and one final outbox event. A final answers only its named request, even
when several requests steer into one running turn. General turn completion
settles every remaining question as unanswered with the exact retained output
reference. Only an initial, dedicated, single-question turn with no steering
may use its final output as the answer automatically. Error and cancellation
remain explicit outcomes. Exact existing request dependencies wait outside the
native FIFO; unsuccessful prerequisites settle the continuation without
admitting it. The execution-based `work/--after` contract remains independent.

Return events use the same routed publication and input owner, steering an
active requester or queuing a new turn for an idle requester. They create no
new return obligation. Deliberate Stop and archive retain the event instead of
resurrecting work. A changed binding never redirects delivery. The request
receipt exposes held or ambiguous return state. Existing routed recovery owns
effect reconciliation; the conversation layer inspects its stable identity and
never blindly republishes it.

One 30-minute due time is stored at acceptance. One timer serves the earliest
uninspected deadline and stops when none remain. Its one overdue inspection
records known admission, execution, process-owner and Stop evidence and a
durable notification; it does not replay uncertain effects or perform native
recovery itself. Late answers remain valid. Startup and existing input,
steering and terminal lifecycle signals inspect outstanding requests/events.
Work per signal is proportional to unresolved requests and undelivered events;
settled/admitted history is excluded by partial indexes. There is no periodic
idle scan, new supervisor or deadline-extension loop.

Peer input and return envelopes identify agent/service origin and confer no
new human authority. The service derives causal depth from received
communication inputs and rejects a ninth automatic hop until direct human
input begins a new chain. Shared session FIFO remains the sole provider writer;
communication does not grant filesystem or deployment ownership to a peer.

The CLI contract is in [router actions](../runbooks/ROUTER-ACTIONS.md). Focused
`session-communication.test.ts` tests storage races, correlation, dependencies,
Stop and deadline behavior. The real Slack `session-communication` case proves
live steering, idle resume, correlated returns, retained output and recovery
across an exact controller reload. Historical transcripts and reconstruction
remain outside this implementation.

### Existing routed-request authorities

- `routed-requests.ts`, `routed-request-api.ts`: request acceptance, channel owner, lookup, publication/admission, recovery.
- `state.ts`: schema, input ownership, fixed dependency edges, satisfaction, session FIFO, reaction intent.
- `router-post.ts`, `router-request-client.ts`, `router-actions.sh`: shared Slack presentation and API clients.
- `routed-requests.test.ts`, router/queue/reaction focused tests: ordering, duplication, uncertainty, empty selections, failure outcomes, and projection races.
- Sandbox `queued-requests`: user author, quiet wait, cross-channel prerequisites, later independent work, one activation, full file-backed input, exact ledger/API/browser evidence.

The approved rationale is preserved in [the design record](../plans/2026-09-10-wait-for-existing-work.md).
