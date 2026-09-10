# Routed requests and execution dependencies

The inbox router interprets explicit waiting intent and resolves named work to exact existing execution references. Concierge validates those references and owns publication and execution admission for every routed request. Product channels need no agent-side scheduler or second language classifier.

`router-actions.sh post`, `resume`, and `upload` call `POST /requests` on the running service's private `requests.sock` inside its state directory. The socket is owner-only and runtime-scoped; there is no public ingress, new credential, daemon, broker, or polling worker. Audit and read-only receipt verbs retain their existing transport. The [router runbook](../runbooks/ROUTER-ACTIONS.md) owns CLI syntax.

## Publication and intake ownership

`routed-requests.ts` serializes publication and input classification per destination channel. A request's exact source input and stable split-action ID identify one operation. The source must already be an accepted user input in the ledger; the caller cannot supply an alternate requester. Payload conflicts under the same source/action fail before any new publication.

The service commits the task, destination, direct dependencies, requester, payload hash, and publication intent to `routed_requests`. Attachment bytes are copied into `routed_request_files` in that same transaction before Slack calls. The service uses the existing user token and `router-post.ts` transport. Text conversion and the single `routed-request.txt` presentation for long tasks remain shared. Admission retains the original task text, including provider aliases that may now live inside the Slack attachment, and attaches the exact uploaded file metadata.

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

- `routed-requests.ts`, `routed-request-api.ts`: request acceptance, channel owner, lookup, publication/admission, recovery.
- `state.ts`: schema, input ownership, fixed dependency edges, satisfaction, session FIFO, reaction intent.
- `router-post.ts`, `router-request-client.ts`, `router-actions.sh`: shared Slack presentation and API clients.
- `routed-requests.test.ts`, router/queue/reaction focused tests: ordering, duplication, uncertainty, empty selections, failure outcomes, and projection races.
- Sandbox `queued-requests`: user author, quiet wait, cross-channel prerequisites, later independent work, one activation, full file-backed input, exact ledger/API/browser evidence.

The approved rationale is preserved in [the design record](../plans/2026-09-10-wait-for-existing-work.md).
