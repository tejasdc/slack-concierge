# Turn lifecycle and durable projections

This document describes the current Concierge turn lifecycle. Source and focused tests remain authoritative for executable state transitions and constants.

## Runtime ownership

Routed publication and Slack input classification share the per-channel owner described in [routed requests](ROUTED-REQUESTS.md). The existing session queue additionally gates explicit deferred turns on fixed prerequisite executions. Publication/admission releases its owner before provider execution; waiting never launches a provider or creates progress replies.

Concierge accepts Slack events and authenticated native surface input into the same session ledger and turn FIFO. Slack threads retain adapter bindings; native input requires no Slack message. The [unified session owner](SESSION-OWNER.md) describes native admission, source capabilities and Thinkering observations. The Slack projection behavior below remains specific to Slack-presented turns.

- `bot/src/index.ts` owns Slack ingress, admission, command and shortcut registration, and routing.
- `bot/src/session-runtime.ts` composes the same owner, queue, registry and executor when Slack is disabled. `session-execution-host.ts` admits native inputs and controls; it does not own a second provider queue.
- `bot/src/session-turn-queue.ts` owns process-local wakeup coalescing for durable ownerless queued turns. SQLite claim transitions in `bot/src/state.ts` remain the concurrency boundary.
- `bot/src/turn-dispatch-seams.ts` owns the shared active-turn/steering registry, restart ordering seam, and forced-fresh comparison dispatch contract.
- `bot/src/turn-execution.ts` coordinates an admitted turn through context preparation, provider execution, response delivery, and durable completion.
- `bot/src/provider-input.ts` prepares both initial and steering inputs. The turn coordinator owns the private attachment root and provider access; `bot/src/steering.ts` owns ordered preparation and lets final cleanup await in-flight preparation after closing admission to steering.
- `bot/src/agent-progress.ts` owns Agent-mode commentary, stable activity/plan cards, coalescing, lifecycle heartbeat, and terminalization. `agent-progress-pages.ts` owns payload pagination; `agent-progress-messages.ts` owns its durable native message projection; `agent-session-stop.ts` binds native Stop to the current owned turn.
- `bot/src/turn-status-controller.ts` owns the previous projection's ephemeral heartbeat and terminal status for turns admitted in `legacy` mode.
- `bot/src/thread-status.ts` and its state transitions own the previous projection's visible thread summary anchor. `slack_root_summary_projections` owns Agent-mode terminal root replacement.
- `bot/src/todo-file-watcher.ts` and `bot/src/todo-sync.ts` own the canonical `notes/TODOS.md` to read-only Slack List projection independently of provider turns and the interactive Slack queue.
- `bot/src/codex-remote-observer.ts` owns subscriptions and durable projection of Codex Remote input into already-mapped Slack threads.

The Remote observer excludes Concierge-owned native inputs by matching the provider's
`clientId` to the accepted input ledger under the exact provider thread and turn. Native
steering uses the accepted input ID, not the legacy `slack-concierge:` client prefix.
The ledger's human/agent/service origin owns classification; text that resembles an
identity envelope is not provenance. A genuinely external Codex input can still be
mirrored while a Concierge turn is running. Native turns retain their result and
attention in Thinkering; correlated requests return through their recorded obligations.
An original Slack mapping does not make native private history or native finals eligible
for Remote mirroring or advance that Slack thread's cumulative summary.
- `bot/src/deployment-state.ts` and `bot/src/deployment-worker.ts` own automatic `origin/main` reconciliation, durable rollout runs, repair launch, and failure diagnostics outside the provider-turn lifecycle.
- `bot/src/state.ts` owns persisted transitions, leases, recovery identity, and the SQLite schema.

Extend the responsible component instead of adding another lifecycle branch to `handleUserMessage` in `index.ts`.

## Responses and status projections

Concierge appends `_model: <reported model ID> - cwd: <working directory>_`
to final Slack replies, replacing the provider label. Codex takes the resolved
model from `thread/start` or `thread/resume` and honors `model/rerouted` only for
the owned turn. Claude Code takes the initial model from `system/init`, preferring
the latest main-assistant message's model over it; subagent and synthetic model
labels do not replace it. Missing metadata displays `model: unknown`, never a
requested alias or guessed default. The footer is part of the durable outbound
text, so delivery recovery preserves the completed turn's identity.

Every final provider response begins with `TL;DR:`. The summary is cumulative for its visible Slack thread. Generated project `AGENTS.md` files own that durable contract; for customized projects that have not yet adopted the scaffold, Concierge supplies the fallback on every turn through provider-native application context. Later Agent turns receive only the latest already-cumulative summary through that application context; the legacy projection retains its historical synthesis behavior. A separately linked Slack thread is reference material, not part of the current visible thread or cumulative summary unless the user explicitly asks to continue or combine it. Neither instruction is inserted into the real user message, and Slack List controls are never provider prompt context. Codex output is accepted only from its `final_answer` phase; Claude Code output is accepted from its terminal result, so progress commentary cannot become the final response. Codex Remote finals are mirrored into the thread but never advance the canonical cumulative summary because app-originated turns do not inherit Concierge's per-turn cumulative context.

Every turn records an immutable `projection_mode` at admission. Ordinary Slack
user and comparison turns are admitted in `agent` mode. Rows created before the
Agent feature retain the schema default `legacy`, so an in-flight or recovered
turn is never converted under its provider.

An Agent-mode turn creates one app-authored native Block Kit message in the exact
Slack channel/thread and stores its timestamp before provider work proceeds.
Subsequent updates use `chat.update`, not an expiring stream. Ordinary provider
output never creates another reply merely because a turn is long or verbose;
only confirmed consumption of steering guidance starts a successor progress
message so later output appears below that user input. The messages contain
only a typed allow-list of provider events:

- provider-authored commentary accumulates as blank-line-separated `markdown_text`
  paragraphs and is redacted before projection. The latest update is bounded by
  Slack's 12,000-character Markdown limit; an oversized update is truncated with
  an explicit marker instead of opening a new reply. An internal `commentaryId`
  identifies each complete update;
  fragments of that update retain its identity, while consecutive updates remain
  distinct even without intervening activity. Historical chunks lacking identity
  retain their existing adjacent-text semantics. Legacy stream writes strip this
  internal field. Compaction markers retain an internal `isCompaction` flag and
  stay outside commentary history, never replacing the latest provider commentary or
  triggering message rollover; legacy
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
  repeated file reads. Web operations include provider-supplied search terms and
  page hostname/path, plus the find term for page searches. The installed Codex
  protocol supplies `search.query/queries`, `openPage.url`, and
  `findInPage.url/pattern`; legacy web-search items supply `query`. Claude's
  `WebSearch`/`WebFetch` use only their query/URL fields from complete tool-use
  events. URL credentials, query strings and fragments are omitted, including
  URLs embedded inside query/find text; all previews
  are redacted and bounded before publication. Missing metadata stays absent;
  no page descriptions are guessed or fetched. Never expose raw commands, file
  search queries, other tool arguments/results, or reasoning. Claude's named
  tools use descriptive categories when available;
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
  Commentary starts a new preview, while older activity snapshots age out of the
  compact projection because they are no longer rendered. The existing durable page
  stores details without an additional state owner or background task; title-only
  recovery updates preserve previously saved details;
- `plan-progress` is one replace-in-place native task card showing the current plan
  step, with all steps and their states in its native expandable details. Rendering
  always places it last, after commentary and activity, regardless of when the plan
  arrived. It stays on the active progress message and moves to a successor created
  by accepted steering. The closed pre-steering page omits planning rather than
  freezing a stale step with “continued below”; terminalization clears every
  remaining in-progress card;
- a submitted steering message starts a new progress page only when the provider
  reports consuming it: Codex's matching `userMessage.clientId`, or Claude's exact
  pending guidance replay. Duplicate notifications are ignored. The controller
  closes the old activity and resets its preview, then emits an internal
  `steering_boundary` before further output. This is also a coalescing barrier, so
  later plan updates cannot replace an earlier pending update above the guidance.
  Pagination freezes the prior page's activity with a continuation label and carries
  the plan only into a new durable reply. The latest boundary identity survives
  bounded-history compaction;
  it is never sent as a Slack block or legacy stream chunk. Already-open operations
  from the preceding interval cannot overwrite the new activity. No provider
  session, turn, Stop binding, queue, or database schema changes are involved;
- context compaction may add one factual marker; and
- narration, final-answer tokens, reasoning, command text and arguments, output, diffs, full filesystem paths, and secret-bearing detail never enter progress messages.

The page renderer derives a compact view from those retained chunks: latest
commentary as visible native Markdown, one `task_card` titled
“Earlier progress”, or “Earlier progress (recent)” after older entries age out,
the active Thinking/activity card with whole-turn elapsed time in its title, then
planning. History uses the stable `earlier-progress` task identity with `complete`
status and rich-text `details`, the same native detail surface as Thinking.
Activity and clock updates leave its identity and content unchanged; new
commentary changes only the retained history. This replaces the inline container
whose expanded state Slack mobile discarded on message updates (reported with
iOS screenshots on 2026-09-08). Slack controls the client-specific presentation;
the bot does not create or update a custom modal. History contains at most 50 older provider-authored updates and 12,000
characters, newest-first, in one rich-text section. Reversal is only
between commentary updates: paragraphs/fragments within an update and the durable
source chunks stay in their original order. Trim each history update's display
edges before joining with one blank line: retained chunks include stream
separators, which otherwise create leading and doubled gaps in the native detail
sheet. Internal paragraph breaks and stored chunks remain unchanged. The reducer joins same-ID fragments
before bounding each page, so the renderer reverses stored updates rather than raw
provider batches. This caps per-page work and storage while keeping the current
message identity stable. Thinking/status
snapshots, operations, and system compaction markers never enter that section.
Current activity and its operation details remain in the active card.
The live card represents the whole turn: while the latest page has no terminal
projection request, it always renders `in_progress`. Completing/failing an
individual operation, closing a snapshot for commentary, or pausing for a provider
retry cannot show a terminal tick/error on that live card. The durable projection
supplies this running-turn state; stored operation snapshots keep their own
statuses. Planning remains last on the active page; closed steering pages omit it.
An operation title may therefore read `Compacting context ✓ · 9m 36s elapsed`
while the native card still spins; the next operation replaces that title normally.
If commentary leaves the page with no current activity snapshot, the live
page renders a Thinking card from the known running-turn state; it does not invent
a provider operation or add a durable chunk. Terminal/older pages never use it.
Retained commentary keeps its original redacted text (including Markdown source),
not a generated summary. Latest commentary is not duplicated there. Missing
commentary/history/plan sections are omitted.

Slack exposes no documented suppress-notification flag for `chat.postMessage`, so
payload pressure cannot be repaired with a supposedly silent continuation. If Slack
definitively rejects the rendered Block Kit expansion at its 50-block limit, the
projector durably shrinks the same page and retries the same `client_msg_id` (or the
known message timestamp for an update). Transport ambiguity is still parked rather
than retried. This fallback never manufactures another progress reply.

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
Progress finalization does not own the successful terminal status. The turn
coordinator reasserts `active` only after the final response and terminal root
projection settle, so no later completion write can leave Slack rendering the
session as processing. A service drain while either projection is pending leaves
the delivered turn unsettled for ordered restart recovery: root first, terminal
status second. Cancellation reasserts `active` after its progress page is final;
terminal failures use `suspended` after progress is final. Restart recovery
preserves the same ordering. A permanent terminal Agent-session status failure
posts a durable, mentioned `Concierge sync error — Slack display out of date` reply in the affected
thread explaining that the turn finished but Slack's working indicator could not
be cleared. When both terminal projections fail, one notice contains both errors
so the single per-turn notice projection cannot hide either failure.

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
steering intervals, not tool events, and cascade with turn deletion. No idle
poller is added. Each active page retains the latest commentary, at most 50 older
commentary updates and 12,000 older-commentary characters, one current activity,
and one current plan. Archived activities and older commentary age out instead of
creating capacity-driven replies. The latest Markdown update is bounded to
Slack's 12,000-character limit with an explicit truncation marker. If Slack
explicitly rejects the rendered expansion at its 50-block limit, the projector
shrinks and retries the same page identity; it never treats an ambiguous transport
outcome as permission to repost. Only accepted steering creates another page.

The existing `progress_stream_ts` remains the first-message identity and
`progress_stream_state` the turn projection lifecycle, for compatibility. Page
rows distinguish the new transport. `progress_activity_id` follows the desired
snapshot's latest activity/text boundary. Retry and terminal recovery reuse it.
`progress_terminal_requested` prevents replay from duplicating terminal commentary
or a late update from reviving the plan. Existing persisted streams retain their
old finalization path; there is no historical backfill or live transport switch.

The provider result stays outside the progress event stream. Concierge atomically gives
either a persisted native Stop or durable response delivery ownership of the
turn. Once delivery wins, the provider result is persisted, Concierge finalizes the
progress pages, then sends the full `TL;DR:` response through the existing durable response
delivery worker as a separate new reply. Each reply chunk keeps prose, headings,
task lists, code, and links in Slack's native `markdown` blocks. Detected Markdown
tables within Slack's 20-column contract become explicit `table` blocks whose
rich-text cells preserve supported inline formatting and whose `column_settings`
enable wrapping for every column; column alignment markers are retained. The
top-level `text` remains the complete mobile-notification and accessibility
fallback. One deterministic response plan supplies both the durable chunk count and
the blocks posted at each chunk index. It reopens fenced code, repeats table headers
across payload boundaries and the 100-row table limit when the header and a data row
fit together. A data row that cannot share the fallback budget follows the preceding
header on its own bounded page; later pages resume repeating the header. It isolates
multiple tables into separate messages for Slack's one-table-block-per-message
contract. Table cells are parsed into rich-text elements once; payload-boundary fragments retain those
elements and their original column directly rather than being serialized and parsed
again. This keeps links, styles, literal characters, and cell line breaks lossless
when an oversized row continues. Indented and fenced code remain Markdown rather
than being interpreted as tables. The existing chunk identity remains the delivery
and recovery authority. The 3,800-character source
budget also keeps each explicit table below Slack's 10,000-character aggregate
cell limit and each message's translated Markdown below its 12,000-character
limit. Tables outside the explicit table-block shape, including content that
cannot fit one native semantic element within those limits, stay in native
Markdown rather than losing or collapsing source columns. Slack can therefore
notify on actual completion. The last activity card becomes `Work complete · 18m 42s`, for example,
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
The router DM (`D0BMWUJ3RD5`) is the sole production exception to the separate
completion reply. `router-reply.ts` selects that exact conversation. Once native
progress is stopped, response delivery persists the latest turn-owned progress
timestamp as chunk zero's `replace_message_ts`, then sends the same final-response
payload with `chat.update`. This is a handoff to response delivery, not final
tokens in the progress stream. `slack_ts` and `delivered_at` still mean confirmed
delivery; retries/recovery reuse the saved replacement target and cannot create a
second completion message. Later progress cannot reclaim the stopped message.
Historical deliveries already attempted without a replacement target retain their
original post identity, as do legacy streams without native page records.

An ordinary short routing receipt therefore occupies the one existing bot reply,
including its destination link and model/cwd footer. Long responses retain the
existing continuation chunks after the first edited message; accepted steering
retains its ordering boundary and the final replaces the latest page. Errors that
require attention retain their explicit failure notice. A permanent update error
parks delivery through the existing failure owner; it does not silently repost.
The router's own instructions suppress the separate helper audit. Other channels
and DMs keep their existing progress-plus-final behavior. Sandbox claims may set
`CONCIERGE_SANDBOX_ROUTER_REPLY_MODE=1` to map this policy to only their provisioned
DM fixture; the production selection cannot be widened by that flag.

Recovery enforces the same progress-before-final order. If the
terminal projection cannot be confirmed, the final remains durable but undelivered,
the session is suspended, and one action-required projection is used instead.
When a parked turn is claimed again, its confirmed native page remains the
progress identity and the prior attempt's terminal fence is cleared. The queue
claim owns that transition. Historical retries that already lost their stream
fields are restored from the posted page after recovery claims the saved
delivery; the provider is not rerun. Restoration requires the exact owner, a
retry attempt, and a confirmed page, and cannot reopen an already delivered
response or infer the identity of an ambiguous message creation.
After delivery is confirmed, Concierge durably attempts a user-token
`chat.update` of an ordinary user-authored root to the original first-turn request followed by
a blank line, a heavy divider, a bold `Concierge TL;DR` label, and the cumulative
summary on its own line. The request
leads because the root is user-authored and identifies the thread. The combined `text` is capped
at 4,000 UTF-8 bytes as well as Slack's documented 4,000-character ceiling after
the shared Markdown-to-mrkdwn transform that produces the exact outgoing text;
production rejected a 4,000-code-point, 4,048-byte update as `msg_too_long`.
When necessary, Concierge keeps the complete summary and truncates only the
request tail with `… [truncated]`, without splitting a Unicode code point. If
Slack still returns `msg_too_long` after that preflight, Concierge retries once
with half of the optional request prefix while preserving the complete summary.
Historical root projections parked with that exact deterministic error are
requeued once at startup under the corrected renderer. A durable migration bit
distinguishes those pre-fix rows from all newly rendered projections and prevents
another restart from requeueing a failed repair. Missing or oversized
summaries, a summary that leaves no room for request text, and threads without a
stored top-level root request leave the root unchanged. This applies to new
projections and targeted recovery of the known length failure, not as a fleet
scan or repair of unrelated historical roots. Any permanent root projection
failure posts one durable, mentioned `Concierge sync error — Slack display out of date` reply in the
affected thread with the Slack error and an explicit statement that the final
response was delivered and the agent is no longer working. The failure parks
only that projection; it cannot demote or hide the delivered final response or
block the terminal `active` status.

Comparison roots are a different Slack ownership and rendering boundary: the
Concierge bot posts them with visible provider/prompt/transcript/attachment
blocks, while the first persisted `turn.user_text` is a private replay wrapper,
not the visible prompt. A comparison root is identified by the exact durable
`comparison_requests` channel/root mapping. Its TL;DR projection reads the exact
root through `conversations.replies`, verifies its posting bot identity, and
updates it with that same bot token, retaining every original prompt block and
replacing only the owned TL;DR section. Full 50-block anchors put the TL;DR in their
first title section without losing any prompt blocks. Slack's fallback text
remains the original comparison caption plus the current TL;DR, never the
private provider wrapper. An unrepresentable or unowned root parks explicitly
and triggers the in-thread sync warning; it is not repeatedly retried as a
transient failure. Historical comparison-root projections parked with the exact
`cant_update_message` error are requeued once on startup after the ownership
fix, guarded by a durable repair bit. Ordinary user-authored roots keep their
existing user-token and bounded request-prefix path. Later turn deliveries
continue to advance the independent durable `thread_tldr` and router's indexed
delivered summaries even if the root edit parks; Slack readers of the root
should use the latest delivered final reply whenever the visibly labeled sync
warning says its header is stale. The warning identifies the affected header,
keeps a diagnostic error code, and says the user need not resend the turn.
Parking a delivered turn's root edit and requesting its failure notice share
one SQLite transaction. Thus a historical repair interrupted after requeue
retains its warning obligation if a later startup permanently parks the row;
pending notice projections resume even if the service stops before the
immediate in-thread write. No restart-only repair list or background pending
pass may silently lose this failure notice.

`agent_session_stopped` is resolved by authenticated workspace, exact `channel`
and `thread_ts`, and the registry's owned turn. Its Slack `event_ts` must be at or
after that turn's first progress timestamp; the comparison uses exact microseconds,
not a local clock or a queued input's timestamp. Empty `streaming_message_ts[]` is
valid. Stop intent is persisted before provider cancellation. Duplicate callbacks
are idempotent; stale events cannot cancel a successor. Only the turn coordinator,
never the event handler, projects terminal Agent status. Cancellation finalizes progress,
abandons undelivered artifacts, releases the provider-session lock, and creates
no final reply.

### Interrupted input continuity

`turns.replay_text` owns the exact prepared input, including completed audio
transcription. Preparation reuses this text on a retry instead of downloading
and transcribing the audio again. Non-audio files still require their normal
preparation and remain unreplayable. After preparation, a persisted Stop ends
the turn before provider admission; completing the transcript is preservation,
not permission to start work. Existing dead-owner recovery retains Stop and
requeues only proven pre-admission work.

`provider_input_acknowledged_at` records receipt, independently of native turn
creation. Codex requires the exact `userMessage.clientId` in the owned native
turn (including history recovered after reconnect); Claude requires the exact
echoed initial user message. Turn start, model initialization, completion, and
missing acknowledgement are not evidence that input entered native history.

On a later user turn in the same durable session, `listInterruptedInputContext`
selects prior cancelled, interrupted, failed, or parked inputs whose receipt is
unconfirmed. Automated turns neither receive nor retire this user context;
automated failures are not user-input sources. `input-continuity.ts` supplies
their lossless saved text as labeled
historical data ahead of the current instruction. It distinguishes no admission
from uncertain execution, retains original typed text when preparation did not
finish, discloses missing preparation or non-audio files, and
forbids automatic repetition of uncertain actions. The current user input owns
instructions and routing identity. No new turn, automatic retry, polling, or
provider-selection policy is introduced by this context handoff.

The current turn's exact receipt atomically sets each source's
`input_context_received_by_turn_id`. A crash or Stop before that receipt leaves
the sources eligible for the next user turn; confirmed inputs are excluded.
Each source keeps its original canonical text, so repeated interruptions do
not nest copies of prior history. The delivered response includes a durable
Concierge continuity notice even if the provider omits one. Legacy interrupted
rows without receipt evidence remain unconfirmed; native start/turn identity
counts as potentially submitted, never as proof of input receipt.

Cross-provider continuation cannot silently omit stopped inputs from its
recorded history. It rejects that source with an explicit continuity gap and
asks for a continuation brief or a resume in the original session. The check
also runs after an accepted continuation's source dependencies settle.

This repairs the [cancelled audio incident](../incidents/2026-09-15-cancelled-audio-input.md)
without asserting that historical turn 941 executed or automatically repeating
it. The real Slack `input-continuity` case covers gated audio preparation,
App Home Stop, service restart, same-native-session resume, and Stop after
confirmed receipt. Focused tests additionally cover crash/error context,
repeated interruptions, exact bytes, and provider receipt correlation.

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
may run concurrently. Both Slack and headless queue composition also exclude the
existing live registry's active session IDs from the atomic claim. Ordinary Slack
admission uses its existing deferred-input path while that registry still owns the
session. Durable terminal delivery can precede asynchronous status/attachment cleanup;
closing steering does not release execution ownership. Registry settlement clears
that ownership before waking the queue, so the next input remains ownerless until
cleanup ends rather than being claimed and rejected as a duplicate owner. This is a
read of the same registry, not another queue or execution lock. A prior turn's `pending` or `sending` artifact delivery is
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
and expose the turn ID in its durable Slack status. For a login-repairable
authentication failure on claude-code the attention notice also carries the
`/auth-refresh` hot-login guidance; entitlement, billing, and admin-disabled
failures, which a fresh login cannot fix, get only the generic Retry hint.
A parked turn remains the oldest FIFO blocker, but a queued successor is the
user's durable signal to continue the session: a safely-resumable parked head
turn is automatically resumed at each recovery boundary — when a later input
queues behind it, once at queue startup, and after a completed `/auth-refresh`
login. Because a new input that arrives while the head is still settling into
`parked` cannot resume it at admission, its session records a one-shot
resume grant that the next settlement consumes, so that new-input boundary is
not lost. Each boundary grants at most one resume, so a still-broken provider
parks the turn again and waits for the next boundary rather than looping.
Ambiguous or otherwise unsafe parks are never auto-resumed; they still require
the App Home Retry control or
`bun run bot/scripts/session-turn-queue.ts resume --turn-id <id>`, which also
remain available for a parked head with no successor. Resuming an agent-mode
turn settles any still-pending legacy status projection the park left behind
so the agent surface, not the legacy status worker, owns its visible state.
There is no attempt limit or age-based discard.

`/auth-refresh claude-code` starts Claude Code's interactive login on the
service host, keeps that process alive, and returns the authorization URL to
Slack; the URL's callback is provider-hosted, so it can be approved from any
device. `/auth-refresh claude-code <code>` writes the approval code to the
waiting process's stdin and reports the outcome. A completed login resumes
blocked parked head turns and wakes the session turn queue. Codex is not a
hot-login provider: its CLI on this host has no device-auth mode and its
default login returns credentials through a host-localhost callback a remote
browser cannot reach, so `/auth-refresh codex` reports that codex auth is
managed on the host (Codex App Server); its queued turns still resume through
the same boundaries once that auth is restored.

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

A resumed Claude process may emit a result for a queued notification before
echoing the current request. That result cannot close provider input, settle the
turn, or disable usage fallback. The parser excludes pre-acknowledgement output
from its response text, tool list and timing, and the adapter logs only safe session identity, phase
and error status as `claude_code_unowned_result_ignored`. If the process exits
without a result after the exact request acknowledgement, the turn still fails;
an earlier notification result never counts as completion.

### A full conversation compacts and the request is sent again

Claude refuses a turn whose conversation no longer fits with `Prompt is too long`. Auto-compaction
is on and works — the Inbox's own history shows it firing at 967k–978k of a 1M window — but it is a
threshold check that races the request, and on 2026-09-22 a two-sentence message lost that race at
~979k and was shown to Tejas as Failed with a Retry button. Compaction then ran on the next input
four minutes later and the session recovered by itself, which is what made the failure pointless.

So the adapter now recovers in place. On a refusal that `isContextOverflowRefusal` recognises, with
no tool having run in that turn and only once per turn, it writes `/compact` into the same live
process, waits for the outcome, and on success replays the turn's accepted inputs verbatim behind a
continuation preamble — the same replay machinery the usage fallback uses. He sees no failure; the
turn simply answers. If compaction reports failure, does not report at all within ten minutes, or
the refusal is not about the window, the original error surfaces exactly as before.

`/compact` is a user message here, not a control request. Claude Code 2.1.280 answers it with
`status{status:"compacting"}`, `status{compact_result}`, a fresh `init`, a `compact_boundary`
carrying `trigger:"manual"`, and a `result`; a message sent afterwards is answered normally in the
same process. That sequence was verified against the real CLI on 2026-09-23, because the Agent SDK
at 0.3.263 declares no compaction control request and its published reference documents none — do
not assume a future SDK adds one without checking. Neither `/compact` nor the continuation is added
to `ownerSubmittedTexts`, which is what keeps this run's own bookkeeping out of his conversation.

### Claude usage fallback

The Claude adapter handles a terminal usage rejection inside its existing
streaming-input process. A rejected `rate_limit_event` or the CLI's explicit
credit/usage-limit message permits the next configured model from
`CLAUDE_USAGE_FALLBACK_CHAIN` in `aliases.ts`. Defaults and the chain share exact
model IDs there; no model-family or size inference selects candidates. The
observed legacy `claude-fable-5` preference explicitly enters the same fallback
suffix as the current Fable default. Unknown model IDs do not opt into fallback.
Each candidate is tried once per
Concierge turn. Ordinary authentication, transport and server failures keep their
existing handling. When every candidate is exhausted and the provider reported when its
allowance returns, the turn waits in its own queue for that instant instead of failing;
the queue's deadline timer brings it back. See
[provider usage](PROVIDER-USAGE.md#dispatch-and-invalidation).

The adapter waits for the native `set_model` control acknowledgement, then sends
one retry of the unfinished request in the same provider conversation. The retry
includes the original accepted provider input and every acknowledged steering
input verbatim, in order, with instructions to preserve completed actions and
give later guidance precedence. It does not consult a summary or search index,
create a new Concierge turn/session, or rebuild native conversation history.
The exact retry must be echoed before its result is accepted. Pending user steering settles
before fallback starts; steering arriving during the model switch waits for that
control to settle. Sending new guidance discards the prior response's usage
rejection before any new rate-limit event or guidance replay can arrive. Stop
remains bound to the same process. Failed or ambiguous
model controls stop this attempt without trying another model. Only the final
outcome releases provider ownership, and the footer reports the actual assistant
model. Prior tool history remains available while terminal timing comes from the
final native result.

Before any model switch, the first init persists the preferred model in the
owned running turn's existing `provider_model` field, leaving explicit selection
intact. A later Claude turn uses the latest non-null preference through its own
turn ID. This also captures the native model of legacy sessions on first use,
without migrating their history. Fallback models do not replace this preference,
so later turns try the preferred model again. All-model exhaustion with a reported reset
holds the turn in the retry surface until that instant; without one it retains the
existing parked/terminal surface. Previously parked production turns are not replayed
by a deployment.

Changing an alias/default still does not hot-switch a bound live shared session.
Usage fallback is a separate native `set_model` control inside the existing
adapter process; it keeps the Concierge session row and provider session UUID.

Anthropic's [model configuration](https://code.claude.com/docs/en/model-config#fallback-model-chains)
excludes billing/rate limits from the built-in availability fallback. Its
[streaming-input model control](https://code.claude.com/docs/en/agent-sdk/typescript)
preserves the native conversation. A sandbox account probe on 2026-09-14 proved
Fable credit rejection followed by an Opus response recalling the earlier input
under the same session UUID. The `claude-usage-fallback` sandbox case repeats this
through two real Slack turns and verifies preference, session, delivery and history,
including a new instruction unique to the second failed input and both durable
replay payloads.

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
