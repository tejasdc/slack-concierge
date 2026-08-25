# Turn lifecycle and durable projections

This document describes the current Concierge turn lifecycle. Source and focused tests remain authoritative for executable state transitions and constants.

## Runtime ownership

Concierge accepts Slack events, binds each visible Slack thread to a provider session, prepares canonical provider input, runs Codex or Claude Code, and durably projects the result back to Slack.

- `bot/src/index.ts` owns Slack ingress, admission, command and shortcut registration, and routing.
- `bot/src/session-turn-queue.ts` owns process-local wakeup coalescing for durable ownerless queued turns. SQLite claim transitions in `bot/src/state.ts` remain the concurrency boundary.
- `bot/src/turn-dispatch-seams.ts` owns the shared active-turn/steering registry, restart ordering seam, and forced-fresh comparison dispatch contract.
- `bot/src/turn-execution.ts` coordinates an admitted turn through context preparation, provider execution, response delivery, and durable completion.
- `bot/src/agent-progress.ts` owns one Agent-mode progress stream's commentary accumulation, stable activity/plan cards, coalescing, lifecycle heartbeat, and terminal stop.
- `bot/src/turn-status-controller.ts` owns the previous projection's ephemeral heartbeat and terminal status for turns admitted in `legacy` mode.
- `bot/src/thread-status.ts` and its state transitions own the previous projection's visible thread summary anchor. `slack_root_summary_projections` owns Agent-mode terminal root replacement.
- `bot/src/todo-file-watcher.ts` and `bot/src/todo-sync.ts` own the canonical `notes/TODOS.md` to read-only Slack List projection independently of provider turns and the interactive Slack queue.
- `bot/src/codex-remote-observer.ts` owns subscriptions and durable projection of Codex Remote input into already-mapped Slack threads.
- `bot/src/deployment-state.ts` and `bot/src/deployment-worker.ts` own post-deploy verification triggers, exact-session wake leases, and failure notices.
- `bot/src/state.ts` owns persisted transitions, leases, recovery identity, and the SQLite schema.

Extend the responsible component instead of adding another lifecycle branch to `handleUserMessage` in `index.ts`.

## Responses and status projections

Every final provider response begins with `TL;DR:`. The summary is cumulative for its visible Slack thread. Generated project `AGENTS.md` files own that durable contract; for customized projects that have not yet adopted the scaffold, Concierge supplies the fallback on every turn through provider-native application context. Later turns also receive the root-specific prior cumulative summary through that application context. Neither instruction is inserted into the real user message, and Slack List controls are never provider prompt context. Codex output is accepted only from its `final_answer` phase; Claude Code output is accepted from its terminal result, so progress commentary cannot become the final response. Codex Remote finals are mirrored into the thread but never advance the canonical cumulative summary because app-originated turns do not inherit Concierge's per-turn cumulative context.

Every turn records an immutable `projection_mode` at admission. Ordinary Slack
user and comparison turns are admitted in `agent` mode. Rows created before the
Agent feature retain the schema default `legacy`, so an in-flight or recovered
turn is never converted under its provider. Deployment-verification turns retain
their existing projection contract.

An Agent-mode turn creates one app-authored `timeline` stream in the exact Slack
channel/thread and stores its message timestamp before provider work proceeds.
The stream contains only a typed allow-list of provider events:

- provider-authored commentary accumulates as `markdown_text`;
- `current-activity` is one replace-in-place task showing the newest active safe operation title;
- `plan-progress` is one replace-in-place task showing the current plan step;
- context compaction may add one factual marker; and
- narration, final-answer tokens, reasoning, command text and arguments, output, diffs, full paths, and secret-bearing detail never enter the progress stream.

Every outbound commentary, plan, and task chunk crosses one final redaction gate
for credential assignments, bearer/JWT tokens, Slack/OpenAI/GitHub token shapes,
private keys, and URL passwords. Structured operation labels stay generic when
their provider payload cannot be proven display-safe.

Updates are coalesced and use an isolated Slack rate-limit lane so progress cannot
starve final replies or other interactive projections. A 45-minute
`agents.sessions.setStatus(processing)` heartbeat keeps long work active without
creating or editing a reply. The latest Agent session status is a durable,
monotonic projection; terminal `active` or `suspended` supersedes an older
heartbeat, and an in-flight heartbeat is awaited before stream stop. Stream
creation and terminal stop are durable turn state; intermediate content appends
are deliberately lossy because the provider result, not the progress transcript,
is the work product.

The provider result is never folded into the stream. Concierge atomically gives
either a persisted native Stop or durable response delivery ownership of the
turn. Once delivery wins, the provider result is persisted, Concierge stops the
exact stream, then sends the full `TL;DR:` response through the existing durable response
delivery worker as a separate new reply. Slack can therefore notify on actual
completion. Recovery enforces the same stream-stop-before-final order. If the
stream cannot be confirmed stopped, the final remains durable but undelivered,
the session is suspended, and one action-required projection is used instead.
After delivery is confirmed, Concierge durably attempts a user-token
`chat.update` of the exact root to
`Concierge TL;DR: <validated cumulative summary>`. Root projection failure parks
only that projection; it cannot demote or hide the delivered final response.

`agent_session_stopped` is resolved by its exact `channel`, `thread_ts`, and
`streaming_message_ts[]`. The stopped-stream list must contain the durable stream
timestamp owned by the registry's current turn. The stop intent is persisted before the provider
cancellation callback is invoked. A stale, duplicate, or mismatched event cannot
cancel another thread or a successor turn. Cancellation stops the stream,
abandons undelivered artifacts, releases the provider-session lock, and creates
no final reply.

Automatic retry remains quiet. A definite terminal failure that requires Tejas
uses one durable tagged reply; the tagged message is the attention signal, not a
progress-stream edit. Agent-mode turns do not add an hourglass reaction, a
loading-status reply, a steering acknowledgement, or
`assistant.threads.setStatus`. A safe provider retry retains and resumes the same
durable stream; it does not stop the stream or create a second reply. Recovery
parks an ambiguous `chat.startStream` outcome instead of replaying stream creation.

A legacy-mode turn keeps the earlier projection unchanged: queued/working status
reply, 30-second heartbeat, durable terminal status, thread-summary anchor, and
hourglass cleanup. This compatibility path exists so persisted work can finish
safely across a normal deployment; it is not a channel pilot or user-selectable
mode.

An agent-enrolled successful deployment is a second explicit ingress kind: `deployment_verification`. It is admitted only from a durable wake attached to a succeeded, provenance-checked deployment run. Concierge acquires the original idle session, reuses its exact provider UUID and visible Slack thread, and records a deterministic trigger key before invoking the provider. The provider receives turn, session, Slack, deployment-run, and wake identities through its native process/App Server environment. The immutable verification packet is provider input, not a synthetic Slack user event. Consequently the turn receives normal status, response delivery, artifact handling, and cumulative-summary behavior, but no hourglass reaction.

For a legacy-mode thread, the first turn's status reply is also the durable cumulative-summary anchor. Later legacy turns have their own status messages while that first reply retains the last delivered cumulative `TL;DR:`. The summary cursor advances only after response delivery is durable. If Slack proves the shared anchor was deleted, the turn and thread projections clear their pointers atomically and recreate one shared message.

Legacy terminal status and cumulative summary, Agent session status, and Agent terminal root summary are durable ordered projections with persisted desired revision and `pending`/`sending`/`delivered`/`parked` state. Agent stream content appends are intentionally lossy. Terminal projections must be delivered, retried, or parked according to their ownership boundary. Projection bookkeeping must never replace a turn's response, Agent stream, or summary timestamp with another projection's identity.

Response delivery is monotonic. After Slack delivery is durably confirmed, later status or summary failure can park only its own projection and cannot demote the response. Before confirmation, unexpected failures relinquish pending delivery for recovery; only an explicit permanent Slack outcome parks it. Deterministic `client_msg_id` values make ambiguous creates retry the same generation, while a proven deletion advances to a fresh generation. Permanent response failure does not advance the cumulative summary.

Legacy threads lazily adopt their earliest status reply and synthesize request/outcome pairs only when a retained legacy turn needs that projection. Adoption uses Slack timestamps to prove visible-thread ownership. In a `single-persistent` channel, unresolved legacy turns never fall back to the shared provider-session anchor; losing an ambiguous old summary is safer than contaminating another thread.

## Recovery and liveness

Every provider, Slack, process, and SQLite boundary is non-atomic. Persist intent before side effects, use stable identities for retries, preserve ambiguous outcomes, and prove the exact previous process owner dead before reclaiming work.

Provider-session contention uses `turns.status='queued'` as a durable FIFO keyed
by `session_id`. Admission persists the turn and its immutable projection mode in
one transaction; only legacy admission also creates queued-status intent.
Promotion proves there is no `running` or `delivering` turn for the
session, claims only its oldest queued row, records the exact process owner, and
repairs the cached session status in the same transaction. Independent sessions
may run concurrently. A prior turn's `pending` or `sending` artifact delivery is
also a session-scoped admission and promotion blocker, so an independent queue
wake cannot enter the provider while the completed turn still owns artifact I/O.
Startup performs dead-owner turn recovery before scanning
queued rows, so an ambiguous or interrupted provider boundary is never blindly
replayed as queued work. If a session is archived after accepting queued input,
the queue-selection transaction terminalizes each row with durable status and
cleanup intent without assigning a live owner; the provider is not entered and
the session remains archived across restart. Startup and the recurring
60-second maintenance scan project both intents, so the terminal notice and
hourglass cleanup do not depend on another restart.

Accepted ordinary and comparison inputs also stay in this same durable stream
when provider dispatch fails before any tool or artifact activity. Each claim
increments `dispatch_attempt`; admission, provider identity, and settlement are
fenced to that attempt, and the provider client-message identity includes it.
Confirmed 429, 5xx, rate-limit, overloaded, and temporary terminal failures move
the same turn back to `queued` with exponential backoff from 15 seconds to 30
minutes. Authentication, entitlement, subscription, API-key, billing, and other
definite non-transient failures move it to `parked`, retain the original input,
and expose the turn ID in its durable Slack status. A parked turn remains the
oldest FIFO blocker until an operator runs
`bun run bot/scripts/session-turn-queue.ts resume --turn-id <id>`. There is no
attempt limit or age-based discard.

Replay requires a confirmed terminal provider result, compatible provider
identity, no accepted/in-flight/ambiguous steering, and an empty exact artifact
reservation. If any of those proofs is missing after provider admission, the
turn is visibly `parked` as ambiguous and the ordinary resume command rejects
it; the input remains durable without risking a duplicate or incomplete replay.

Startup may requeue a dead owner's ordinary or comparison turn only when
provider-admission intent was never recorded and both the durable artifact
reservation and its staging directory prove no activity. Once admission, tool,
or artifact activity exists, existing interruption and ambiguity recovery owns
the outcome; Concierge does not blindly replay it. Retry keeps the working
reaction, while parking queues its durable cleanup. Both transitions release
the cached session lock atomically with the visible status intent.

Comparison request-to-turn association is part of the same admission
transaction. Eventual delivery settles the linked request in the turn's durable
terminal transaction, so a retried comparison does not depend on a later
process restart to become complete.

The deployment gate and the process-local drain both close promotion. A queued
row admitted before a deploy gate survives restart; an input first classified
after the gate retains the existing `draining` no-turn outcome. On SIGTERM the
coordinator stops before active turns are awaited, leaving successors ownerless
and queued for the next healthy process. The existing 60-second maintenance
scan is the safety net for a gate release performed outside the process.

Provider clients have inactivity boundaries so silence cannot be mistaken for progress. Codex JSON-RPC admission calls time out after 30 seconds. Only invalid-parameter rejection is definitive; other JSON-RPC errors preserve ambiguous ownership. Before the exact accepted turn ID is known, same-thread notifications are buffered and cannot bind lifecycle identity; recovery uses the stable user-message client ID. Codex turn controllers and the Remote observer share one persistent initialized connection to the managed App Server daemon; ending a turn controller removes only its listeners and leaves the provider thread, transport, and Remote subscriptions alive. A persistent Node bridge owns WebSocket-over-Unix framing for Bun, awaits each stdin write, and is restarted on the next request after a disconnect. Shutdown sends a graceful close, then uses bounded SIGTERM and SIGKILL waits before reporting completion. After App Server accepts a turn, a bridge disconnect retains the session lock while the controller reconnects and reconciles the exact turn from history. Thirty minutes without relevant turn activity requests an interrupt, but the controller does not release ownership until exact history proves the turn terminal. The one-shot stdio compatibility transport still terminates its owned child on inactivity. Malformed bridge output and stderr chatter do not renew either lease. Claude's valid `keep_alive`, `tool_progress`, `tool_use_summary`, and `stream_event` frames renew it without changing output or steering state.

Claude succeeds only after exact initial-prompt replay and a final non-aborted result. Partial output followed by process exit is an error. Graceful closure escalates from `SIGTERM` to `SIGKILL` when necessary, and transport completion waits for proven child exit. These are inactivity limits, not total turn-duration caps.

Deployment wake recovery uses a stricter replay boundary than ordinary Slack ingress. Before calling the provider, Concierge durably records admission intent on both the wake and turn. A dead owner before that boundary may reuse the same cancelled deterministic turn; a dead owner after it is ambiguous and parks the wake with a durable Slack notice. Only an exactly mapped idle session with no queued, parked, running, or delivering turn can be claimed, so an accepted Slack turn always precedes a verification wake and stale cached session status cannot create a concurrent owner. A running, queued, or parked session keeps the wake pending, while `error`, `archived`, every other non-idle state, session drift, or provider-UUID drift parks it. A failed, ambiguous, or wrong-commit deployment has only a notice projection and cannot enter provider admission.

Process heartbeats serialize and retry transient SQLite contention. Timer callbacks catch terminal failures so an interval rejection cannot crash the bot while durable ingress is still being persisted. Canvas projection is not part of provider-turn execution; committed instruction changes are watched and projected through their own lifecycle.

## Focused authority

- Turn coordination: `bot/src/session-turn-queue.ts`, `bot/src/turn-dispatch-seams.ts`, `bot/src/turn-execution.ts`
- Agent progress and lifecycle: `bot/src/agent-progress.ts`, provider adapters in `bot/src/codex.ts` and `bot/src/claude-code.ts`, Agent/root state in `bot/src/state.ts`, and Slack calls in `bot/src/index.ts`
- Legacy turn and thread projections: `bot/src/turn-status-controller.ts`, `bot/src/turn-status.ts`, `bot/src/thread-status.ts`, `bot/src/turn-status-projection.ts`
- Delivery and recovery: `bot/src/delivery-worker.ts`, `bot/src/turn-reaction-cleanup.ts`, `bot/src/turn-recovery.ts`
- Deployment-triggered turns: `bot/src/deployment-state.ts`, `bot/src/deployment-worker.ts`, `bot/scripts/deploy-state.ts`
- Codex shared transport and Remote projection: `bot/src/codex-app-server-client.ts`, `bot/src/codex-app-server-bridge.mjs`, `bot/src/codex.ts`, and `bot/src/codex-remote-observer.ts`
- TODO projection: `bot/src/todo-file-watcher.ts`, `bot/src/todo-sync.ts`, List CRUD in `bot/src/lists.ts`
- Focused tests: `bot/tests/agent-progress.test.ts`, `bot/tests/agent-projection-state.test.ts`, `bot/tests/session-turn-queue.test.ts`, `bot/tests/queued-turn-execution.test.ts`, `bot/tests/turn-dispatch-seams.test.ts`, `bot/tests/provider-dispatch-retention.test.ts`, `bot/tests/provider-dispatch-execution.test.ts`, `bot/tests/provider-failures.test.ts`, `bot/tests/state-fork-lock.test.ts`, `bot/tests/turn-execution.test.ts`, `bot/tests/turn-status-controller.test.ts`, `bot/tests/thread-status.test.ts`, `bot/tests/deployment-state.test.ts`
