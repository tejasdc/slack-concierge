# Turn lifecycle and durable projections

This document describes the current Concierge turn lifecycle. Source and focused tests remain authoritative for executable state transitions and constants.

## Runtime ownership

Concierge accepts Slack events, binds each visible Slack thread to a provider session, prepares canonical provider input, runs Codex or Claude Code, and durably projects the result back to Slack.

- `bot/src/index.ts` owns Slack ingress, admission, command and shortcut registration, and routing.
- `bot/src/session-turn-queue.ts` owns process-local wakeup coalescing for durable ownerless queued turns. SQLite claim transitions in `bot/src/state.ts` remain the concurrency boundary.
- `bot/src/turn-dispatch-seams.ts` owns the shared active-turn/steering registry, restart ordering seam, and forced-fresh comparison dispatch contract.
- `bot/src/turn-execution.ts` coordinates an admitted turn through context preparation, provider execution, response delivery, and durable completion.
- `bot/src/provider-input.ts` prepares both initial and steering inputs. The turn coordinator owns the private attachment root and provider access; `bot/src/steering.ts` owns ordered preparation and lets final cleanup await in-flight preparation after closing admission to steering.
- `bot/src/agent-progress.ts` owns Agent-mode commentary, stable activity/plan cards, coalescing, lifecycle heartbeat, and terminalization. `agent-progress-pages.ts` owns payload pagination; `agent-progress-messages.ts` owns its durable native message projection; `agent-session-stop.ts` binds native Stop to the current owned turn.
- `bot/src/turn-status-controller.ts` owns the previous projection's ephemeral heartbeat and terminal status for turns admitted in `legacy` mode.
- `bot/src/thread-status.ts` and its state transitions own the previous projection's visible thread summary anchor. `slack_root_summary_projections` owns Agent-mode terminal root replacement.
- `bot/src/todo-file-watcher.ts` and `bot/src/todo-sync.ts` own the canonical `notes/TODOS.md` to read-only Slack List projection independently of provider turns and the interactive Slack queue.
- `bot/src/codex-remote-observer.ts` owns subscriptions and durable projection of Codex Remote input into already-mapped Slack threads.
- `bot/src/deployment-state.ts` and `bot/src/deployment-worker.ts` own automatic `origin/main` reconciliation, durable rollout runs, repair launch, and failure diagnostics outside the provider-turn lifecycle.
- `bot/src/state.ts` owns persisted transitions, leases, recovery identity, and the SQLite schema.

Extend the responsible component instead of adding another lifecycle branch to `handleUserMessage` in `index.ts`.

## Responses and status projections

Every final provider response begins with `TL;DR:`. The summary is cumulative for its visible Slack thread. Generated project `AGENTS.md` files own that durable contract; for customized projects that have not yet adopted the scaffold, Concierge supplies the fallback on every turn through provider-native application context. Later Agent turns receive only the latest already-cumulative summary through that application context; the legacy projection retains its historical synthesis behavior. A separately linked Slack thread is reference material, not part of the current visible thread or cumulative summary unless the user explicitly asks to continue or combine it. Neither instruction is inserted into the real user message, and Slack List controls are never provider prompt context. Codex output is accepted only from its `final_answer` phase; Claude Code output is accepted from its terminal result, so progress commentary cannot become the final response. Codex Remote finals are mirrored into the thread but never advance the canonical cumulative summary because app-originated turns do not inherit Concierge's per-turn cumulative context.

Every turn records an immutable `projection_mode` at admission. Ordinary Slack
user and comparison turns are admitted in `agent` mode. Rows created before the
Agent feature retain the schema default `legacy`, so an in-flight or recovered
turn is never converted under its provider.

An Agent-mode turn creates one app-authored native Block Kit message in the exact
Slack channel/thread and stores its timestamp before provider work proceeds.
Subsequent updates use `chat.update`, not an expiring stream. Content continues in
another reply in the same thread at Slack payload limits or confirmed consumption
of steering guidance. The messages contain
only a typed allow-list of provider events:

- provider-authored commentary accumulates as blank-line-separated `markdown_text`
  paragraphs and is redacted before being split losslessly into chunks of at most
  12,000 characters. An internal `commentaryId` identifies each complete update;
  fragments of that update retain its identity, while consecutive updates remain
  distinct even without intervening activity. Historical chunks lacking identity
  retain their existing adjacent-text semantics. Legacy stream writes strip this
  internal field. Compaction markers retain an internal `isCompaction` flag and
  stay in durable chunks but outside commentary history, never replacing the latest provider commentary; legacy
  stream writes strip this flag too;
- activity updates reuse the same task ID until visible text intervenes. Startup,
  Thinking, tool changes, and completion without text between them update one card,
  rather than stacking cards. Visible commentary or a compaction marker closes the
  preceding activity snapshot; the next activity starts a new snapshot after that text.
  Unfinished provider operations remain tracked internally, so an older operation's
  completion cannot hide a newer active operation. Blank/excluded text and plan
  snapshots do not create new activity cards. Pending chunks preserve text/activity
  order even when several updates share one flush;
- Codex activity labels use native `commandActions` for file reads, listings, and
  searches instead of displaying the outer shell. Web reading/searching,
  compaction, editing, waiting, review, and sub-agent activity have distinct labels.
  Unknown commands stay generic. File operations expose categories/counts only,
  without filenames or per-file details. All-file command groups use one
  “Inspecting files” label; mixed groups keep distinct operation categories, not
  repeated file reads. Never expose raw commands, queries, tool arguments/results,
  or reasoning. Claude's named tools
  use descriptive categories when available;
- each activity card has native expandable `details` containing the latest ten
  operation summaries in its text interval (400 characters per summary). This is
  a compact preview, not a full execution log. Bare “Thinking” updates affect the
  active title but never enter this preview or evict an operation from it.
  Operations appear newest-first by their latest changed provider update; an
  unchanged replay does not move or duplicate an item. Adjacent identical
  summaries share one counted row, bounded by the same ten operations. The dropdown
  has no outcome marks. When the title's operation completes/fails and no other
  operation is active, its native activity event appends a small `✓`/`⚠` after
  the title text, never changing the live turn's spinner. Thinking itself,
  commentary/retry boundaries, and tool-start-only events do not create a mark;
  Claude's current adapter does not supply per-operation completion outcomes.
  The renderer turns the existing `Recent activity` detail string into native
  rich-text bullet lists, nesting each operation's extra lines one level below
  that operation. Plan details retain their existing formatting.
  Structured updates replace the
  coarse tool notification for the same item; completion retains the preview.
  Commentary starts a new preview, while older activities retain their snapshots.
  The existing durable page stores details without an additional state owner or
  background task; title-only recovery updates preserve previously saved details;
- `plan-progress` is one replace-in-place native task card showing the current plan
  step, with all steps and their states in its native expandable details. Rendering
  always places it last, after commentary and activity, regardless of when the plan
  arrived. It is carried into each continuation and keeps updating there. Older pages
  mark carried in-progress cards as continued below; terminalization clears every
  remaining in-progress card, including planning;
- a submitted steering message starts a new progress page only when the provider
  reports consuming it: Codex's matching `userMessage.clientId`, or Claude's exact
  pending guidance replay. Duplicate notifications are ignored. The controller
  closes the old activity and resets its preview, then emits an internal
  `steering_boundary` before further output. This is also a coalescing barrier, so
  later plan updates cannot replace an earlier pending update above the guidance.
  Pagination freezes the prior page with a continuation label and carries the plan
  into a new durable reply. The latest boundary identity survives overflow splits;
  it is never sent as a Slack block or legacy stream chunk. Already-open operations
  from the preceding interval cannot overwrite the new activity. No provider
  session, turn, Stop binding, queue, or database schema changes are involved;
- context compaction may add one factual marker; and
- narration, final-answer tokens, reasoning, command text and arguments, output, diffs, full paths, and secret-bearing detail never enter progress messages.

The page renderer derives a compact view from those retained chunks: latest
commentary as visible native Markdown, one initially collapsed `container` titled
“Earlier progress”, the active Thinking/activity card with whole-turn elapsed time
in its title, then planning. History contains only older provider-authored commentary
newest-first, as one rich-text child with multiline sections. Reversal is only
between commentary updates: paragraphs/fragments within an update and the durable
source chunks stay in their original order. Pagination joins same-ID fragments
before saving each page, so the renderer reverses stored updates rather than raw
provider batches. Thinking/status
snapshots, operations, and system compaction markers never enter that section.
Current activity and its operation details remain in the active card.
The live card represents the whole turn: while the latest page has no terminal
projection request, it always renders `in_progress`. Completing/failing an
individual operation, closing a snapshot for commentary, or pausing for a provider
retry cannot show a terminal tick/error on that live card. The durable projection
supplies this running-turn state; stored operation snapshots keep their own
statuses. Planning and closed continuation/terminal pages are unchanged.
An operation title may therefore read `Compacting context ✓ · 9m 36s elapsed`
while the native card still spins; the next operation replaces that title normally.
If a long commentary continues onto a page with no activity snapshot, the live
page renders a Thinking card from the known running-turn state; it does not invent
a provider operation or add a durable chunk. Terminal/older pages never use it.
Commentary's original redacted text (including Markdown source) is retained in
history, not summarized. Latest commentary is not duplicated there. Missing
commentary/history/plan sections are omitted.

Elapsed time is part of the existing task-card title, for example
`Thinking · 3m 12s elapsed`; there is no separate relative-date text block.
Its anchor is the persisted first progress message timestamp, not the current
activity, provider retry, continuation, or queued input's creation time. Before
Slack acknowledges that first post, its payload uses the current send time; later
edits use Slack's confirmed timestamp. Only the latest page of a turn without
`progress_terminal_requested` shows this elapsed suffix. Closed continuation pages and
terminal pages render the existing completed/stopped activity card instead; a
successful terminal card retains the provider-reported duration. Provider updates
refresh the title normally. During silence, the existing controller schedules one
refresh 30 seconds after its last write, using its same serialized append path with
an empty batch. The native transport redraws only the latest page; legacy streams
ignore empty batches. The timer is cleared on completion, cancellation, error, and
provider retry, and terminalization awaits an in-flight write. No second writer,
message, persistent clock, or idle poller is introduced.

Cost is bounded by active turns: one pending timeout per controller and at most two
clock-only edits per minute per quiet turn (ten per minute for five quiet turns),
through the existing rate-limit lane. Each redraw reads/renders the bounded current
page, not session history; timers perform no work after a turn settles. A provider-
event-only path cannot advance time during long silent reasoning/tool execution.
Slack's task-card title is plain text, with no native elapsed-clock field in its
[documented contract](https://docs.slack.dev/reference/block-kit/blocks/task-card-block/).
Slack owns expansion state; these message edits may still collapse its sections.

Every outbound commentary, plan, and task chunk crosses one final redaction gate
for credential assignments, bearer/JWT tokens, Slack/OpenAI/GitHub token shapes,
private keys, and URL passwords. Structured operation labels stay generic when
their provider payload cannot be proven display-safe. Detail previews are redacted
before truncation; dotted filenames are not mistaken for JWTs unless their first
segment decodes to a JSON signing header with an `alg` field.

Updates are coalesced with at most one in-flight progress write and use isolated
local Slack rate-limit lanes; these do not increase Slack's workspace/method quota.
Before creating the first progress message, Concierge creates the Agent session
as `active` with its durable initiator and initial title. After the exact
first-message timestamp is persisted and before provider work starts, Concierge
sets `agents.sessions.setStatus(processing)`; this is the lifecycle transition
that enables Slack's native loading UX and Stop control without exposing Stop
before a turn-owned message exists. A 45-minute processing
heartbeat keeps long work active without creating or editing a reply. The latest Agent session status is a durable,
monotonic projection; terminal `active` or `suspended` supersedes an older
heartbeat, and an in-flight heartbeat is awaited before terminalization. Session
creation explicitly retains the human initiator; normal message writes have no
implicit Agent lifecycle effects. The initiator is persisted with the existing
session-status projection, so retry/recovery uses that same lifecycle owner.
The same projection durably retains the normalized first non-empty line of the
root request as the session's initial title, capped at Slack's 200-character
contract. Concierge supplies that title with every status attempt, but Slack
applies it only when creating the session; later heartbeats therefore cannot
overwrite a user rename. Existing Slack sessions are not implicitly renamed.

`agent_progress_messages` stores one desired chunk snapshot and creation identity
per page, before Slack side effects. The page number orders writes; confirmed
timestamps make updates replayable. An interrupted/ambiguous post remains
`posting` and is never blindly repeated. Initial page intent and the `starting`
transition commit atomically: startup can requeue a dead owner's pre-admission
turn when all pages are still `pending`, resetting those unattempted pages and
their activity cursor in the same transaction. A historical `starting` stream
without page rows remains ambiguous. The message transport uses the same bot
credential with SDK transport retries disabled; explicit rate-limit rejections
are handled by the existing rate-limit owner. Dirty-page lookup is indexed per turn;
normal updates touch only the last page, not retained history. Rows grow with
message pages, not tool events, and cascade with turn deletion. No idle poller is
added. Pages retain at most 12,000 cumulative commentary and archived-activity
characters and 50 logical content blocks, even when most are hidden inside one
container. Current activity and plan snapshots remain non-accumulating fields.
This reuses the existing page budget rather than treating collapsed text as free
space. Slack can expand Markdown into more blocks: only its explicit translated
block-count rejection repartitions a page, preserving content in ordered replies.
Oversized Markdown is split on line boundaries where possible, reopening fenced
code and repeating table headers so continuations remain native formatted content.

The existing `progress_stream_ts` remains the first-message identity and
`progress_stream_state` the turn projection lifecycle, for compatibility. Page
rows distinguish the new transport. `progress_activity_id` follows the desired
snapshot's latest activity/text boundary. Retry and terminal recovery reuse it.
`progress_terminal_requested` prevents replay from duplicating terminal commentary
or a late update from reviving the plan. Existing persisted streams retain their
old finalization path; there is no historical backfill or live transport switch.

The provider result is never folded into progress. Concierge atomically gives
either a persisted native Stop or durable response delivery ownership of the
turn. Once delivery wins, the provider result is persisted, Concierge finalizes the
progress pages, then sends the full `TL;DR:` response through the existing durable response
delivery worker as a separate new reply. Slack can therefore notify on actual
completion. The last activity card becomes `Work complete · 18m 42s`, for example,
when the provider reports elapsed turn time; completion alone does not require a
new card. Codex's exact terminal turn supplies `durationMs`, falling back only to
valid provider `startedAt`/`completedAt` timestamps (Unix seconds). Claude Code's
terminal `result.duration_ms` supplies its duration, not the API-only
`duration_api_ms`. Its adapter clears timing at replayed steering-input boundaries
and aborted results, so only the final non-aborted result supplies completion time.
Both adapters accept only nonnegative safe integer milliseconds. Missing or
invalid timing leaves the title as `Work complete`. This is the completed provider turn's time, not total Slack-thread
age, queue time, local wall-clock time, or a sum of retry attempts. Concierge saves
the nullable `provider_duration_ms` with the final result in the delivery-claim
transaction, before progress finalization, and uses it for recovered completion too.
Recovery enforces the same progress-before-final order. If the
terminal projection cannot be confirmed, the final remains durable but undelivered,
the session is suspended, and one action-required projection is used instead.
After delivery is confirmed, Concierge durably attempts a user-token
`chat.update` of the exact root to the original first-turn request followed by
a blank line, a heavy divider, a bold `Concierge TL;DR` label, and the cumulative
summary on its own line. The request
leads because the root is user-authored and identifies the thread. The combined `text` is capped
at 4,000 characters; when necessary, Concierge keeps the complete summary and
truncates only the request tail with `… [truncated]`. Missing or oversized
summaries, a summary that leaves no room for request text, and threads without a
stored top-level root request leave the root unchanged. This applies to new
projections and their recovery, not as a scan or repair of historical roots. Root projection failure
parks only that projection; it cannot demote or hide the delivered final
response.

`agent_session_stopped` is resolved by authenticated workspace, exact `channel`
and `thread_ts`, and the registry's owned turn. Its Slack `event_ts` must be at or
after that turn's first progress timestamp; the comparison uses exact microseconds,
not a local clock or a queued input's timestamp. Empty `streaming_message_ts[]` is
valid. Stop intent is persisted before provider cancellation. Duplicate callbacks
are idempotent; stale events cannot cancel a successor. Only the turn coordinator,
never the event handler, projects terminal Agent status. Cancellation finalizes progress,
abandons undelivered artifacts, releases the provider-session lock, and creates
no final reply.

Automatic retry remains quiet. A definite terminal failure that requires Tejas
uses one durable tagged reply; the tagged message is the attention signal, not a
progress-message edit. Agent-mode turns do not add an hourglass reaction, a
loading-status reply, a steering acknowledgement, or
`assistant.threads.setStatus`. A safe provider retry retains and resumes the same
durable message pages; retry alone does not create another reply. Recovery parks
an ambiguous post outcome instead of replaying creation.

A legacy-mode turn keeps the earlier projection unchanged: queued/working status
reply, 30-second heartbeat, durable terminal status, thread-summary anchor, and
hourglass cleanup. This compatibility path exists so persisted work can finish
safely across a normal deployment; it is not a channel pilot or user-selectable
mode.

For a legacy-mode thread, the first turn's status reply is also the durable cumulative-summary anchor. Later legacy turns have their own status messages while that first reply retains the last delivered cumulative `TL;DR:`. The summary cursor advances only after response delivery is durable. If Slack proves the shared anchor was deleted, the turn and thread projections clear their pointers atomically and recreate one shared message.

Legacy terminal status and cumulative summary, Agent session status, and Agent terminal root summary are durable ordered projections with persisted desired revision and `pending`/`sending`/`delivered`/`parked` state. Progress events may coalesce before a flush; page snapshots persist before side effects. Terminal projections must be delivered, retried, or parked according to their ownership boundary. Projection bookkeeping must never replace a turn's response, first progress message, or summary timestamp with another projection's identity.

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

The deployment gate and the process-local drain both close promotion, never
input persistence. A queued row admitted before or after a deploy gate survives
restart. While deployment is only waiting for active providers it holds no gate
at all. On turn settlement the coordinator synchronously promotes queued user
work before waking the deployment runner, so requests win the next admission
boundary. The runner may retain the gate only when its atomic claim observes a
truly idle system; requests racing that short restart window remain durable
queued turns. On SIGTERM the coordinator stops before active turns are awaited,
leaving successors ownerless and queued for the next healthy process. The
existing 60-second maintenance scan is the safety net for a gate release
performed outside the process.

Provider clients have inactivity boundaries so silence cannot be mistaken for progress. Codex JSON-RPC admission calls time out after 30 seconds. Only invalid-parameter rejection is definitive; other JSON-RPC errors preserve ambiguous ownership. Before the exact accepted turn ID is known, same-thread notifications are buffered and cannot bind lifecycle identity; recovery uses the stable user-message client ID. Codex turn controllers and the Remote observer share one persistent initialized connection to the managed App Server daemon; ending a turn controller removes only its listeners and leaves the provider thread, transport, and Remote subscriptions alive. A persistent Node bridge owns WebSocket-over-Unix framing for Bun, awaits each stdin write, and is restarted on the next request after a disconnect. Shutdown sends a graceful close, then uses bounded SIGTERM and SIGKILL waits before reporting completion. After App Server accepts a turn, a bridge disconnect retains the session lock while the controller reconnects and reconciles the exact turn from history. Thirty minutes without relevant turn activity requests an interrupt, but the controller does not release ownership until exact history proves the turn terminal. The one-shot stdio compatibility transport still terminates its owned child on inactivity. Malformed bridge output and stderr chatter do not renew either lease. Claude's valid `keep_alive`, `tool_progress`, `tool_use_summary`, and `stream_event` frames renew it without changing output or steering state.

Claude succeeds only after exact initial-prompt replay and a final non-aborted result. Partial output followed by process exit is an error. Graceful closure escalates from `SIGTERM` to `SIGKILL` when necessary, and transport completion waits for proven child exit. These are inactivity limits, not total turn-duration caps.

Process heartbeats serialize and retry transient SQLite contention. Timer callbacks catch terminal failures so an interval rejection cannot crash the bot while durable ingress is still being persisted. Canvas projection is not part of provider-turn execution; committed instruction changes are watched and projected through their own lifecycle.

## Focused authority

- Turn coordination: `bot/src/session-turn-queue.ts`, `bot/src/turn-dispatch-seams.ts`, `bot/src/turn-execution.ts`
- Agent progress and lifecycle: `bot/src/agent-progress.ts`, provider adapters in `bot/src/codex.ts` and `bot/src/claude-code.ts`, Agent/root state in `bot/src/state.ts`, and Slack calls in `bot/src/index.ts`
- Legacy turn and thread projections: `bot/src/turn-status-controller.ts`, `bot/src/turn-status.ts`, `bot/src/thread-status.ts`, `bot/src/turn-status-projection.ts`
- Delivery and recovery: `bot/src/delivery-worker.ts`, `bot/src/turn-reaction-cleanup.ts`, `bot/src/turn-recovery.ts`
- Deployment coordination outside provider turns: `bot/src/deployment-state.ts`, `bot/src/deployment-worker.ts`, `bot/src/deployment-repair-supervisor.ts`, `.githooks/prepare-commit-msg`, `bot/scripts/deploy-state.ts`
- Codex shared transport and Remote projection: `bot/src/codex-app-server-client.ts`, `bot/src/codex-app-server-bridge.mjs`, `bot/src/codex.ts`, and `bot/src/codex-remote-observer.ts`
- TODO projection: `bot/src/todo-file-watcher.ts`, `bot/src/todo-sync.ts`, List CRUD in `bot/src/lists.ts`
- Focused tests: `bot/tests/agent-progress.test.ts`, `bot/tests/agent-projection-state.test.ts`, `bot/tests/session-turn-queue.test.ts`, `bot/tests/queued-turn-execution.test.ts`, `bot/tests/turn-dispatch-seams.test.ts`, `bot/tests/provider-dispatch-retention.test.ts`, `bot/tests/provider-dispatch-execution.test.ts`, `bot/tests/provider-failures.test.ts`, `bot/tests/state-fork-lock.test.ts`, `bot/tests/turn-execution.test.ts`, `bot/tests/turn-status-controller.test.ts`, `bot/tests/thread-status.test.ts`, `bot/tests/deployment-state.test.ts`
