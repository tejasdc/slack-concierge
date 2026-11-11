# Unified session ownership

The [ChatGPT answer obligation contract](CHATGPT-ANSWER-OBLIGATIONS.md) adds exact task custody and retained repair to requests that ask ChatGPT. A provider attempt or turn ending does not discharge that duty.

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

A surface input retained while its session is paused, archived or otherwise unable to admit a turn records a durable `receipt` event with that exact input identity in the same transaction. This tells an already-open reader to fetch only that operation receipt without claiming that execution started. Queue or live admission later records its ordinary `accepted` event. On startup, the owner seeks only unresolved surface inputs with an explicit queue intent and adds the deterministic receipt event when an older retained input has no accepted, capture or receipt event; it does not infer custody for ambiguous legacy inputs, release the input, create a turn or touch Focus-review captures that intentionally remain hidden until release.

Thinkering's server authenticates its human session and origin, validates chosen workspace revisions, and submits through the root-private owner socket. The owner issues the accepted-input identity atomically with the immutable action payload. Agent tools instead prove an existing input and its exact admitted run. Browser/model actor claims cannot become human authority. Trusted server adapters share the existing root host boundary; the socket is not a security boundary against an arbitrary root process.

For ordinary native Codex/Claude execution, the host conveys the admitted origin through the existing provider application instructions and a per-input JSON identity header followed by the message as plain text. The header comes from `session_inputs`; the human task is not serialized inside a quoted JSON content field. The body contains the human message, agent request or service result, selected context and attachment guidance. Earlier stored JSON envelopes retain their original authors and evidence; they are not rewritten. Human origin means authenticated human instruction, regardless of the service transport. Agent requests and service returns can continue already-authorized work but grant no new human authority. Body actor claims and quoted envelopes cannot replace the owner-generated identity. Each steered input keeps its own origin, including a human follow-up after a service result in the same run. Ordinary Slack provider preparation includes the same identity-header contract so a later native input can enter its existing live execution. Claude receives the contract through `--append-system-prompt`, Codex through application additional context; it is not appended as purported user authority. Receipts retain the exact accepted text and replay retains the actual prepared message. Restricted consultation and ChatGPT retain their existing preparation/capability boundaries.

The owner retains uploaded bytes and their hash before input preparation. Selected revision text is produced by the authenticated surface, checked against exact object references and hashes, then retained independently of the human message. No common owner reads Thinkering's workspace database. Human source evidence is one pinned source/version/event reference and never an implicit provider bind.

Native audio attachments are retained in ordinary common-owner custody. Before a Codex or Claude native initial input or steer reaches its provider, the execution host stages those exact bytes and uses the existing local Whisper transcription boundary that prepares Slack audio. The provider receives both the original staged audio path and its labeled transcription; a transcription failure fails preparation visibly instead of silently dropping spoken input.

Common history and live message events restore readable accepted input at their read boundary. `session-history-projection.ts` matches a user message's native ID, native turn and exact observed content to a retained provider event, then to exactly one native input's prepared replay or final admission prompt hash in the same owned turn. The admission hash includes any interrupted-history prefix added after replay preparation. It does not parse envelope JSON for identity. A proven match exposes the immutable accepted text, attachment custody descriptors and accepted input ID as `submissionId`, so the surface resolves the correct human/agent/service receipt even during mixed-origin steering. Native message IDs, fork boundaries, tool details, cursors and raw provider events remain unchanged. Exact-source context reads still use raw native evidence and its original hashes. Quoted envelopes, unmatched messages and unbound archive history stay literal evidence; absent proof never invents attribution. Provider preparation, attachment paths and selected-context scaffolding remain in retained execution evidence rather than the conversation display.

## One execution owner

Provider availability uses the shared [usage reset cache](PROVIDER-USAGE.md) inside the
existing adapters. Its explicit clear and timestamp expiry affect future attempts only;
neither owns replay, queue promotion, Stop or recovery.

`SessionExecutionHost` dispatches native inputs through the same `SessionTurnQueueCoordinator`, durable claims, `ActiveTurnDispatchRegistry`, `executeAgentTurn` and provider adapters as Slack. Explicit human queue/steer controls validate the observed run; agent requests leave that choice to the coordinator. Native fork controls serialize in their parent's existing FIFO, preserve the parent binding and create the child only from exact native evidence. There is no provider writer in the Thinkering consumer.

Scheduled saved work keeps its fire time as a separate admission condition at the queue's atomic claim. A retry or recovery may move its next attempt time, but cannot start it before the fire time. The queue wakes at that fire time even when the retry time was cleared. An explicit manual start overrides the schedule. See the [early scheduled Inbox incident](../incidents/2026-11-04-scheduled-inbox-work-fired-early.md).
Dropping Saved work names one queued turn. Its receipt retains the cancellation cause and the agent's exact source input and run when an agent did it; other queued turns in the same session retain their place. A request withdrawal revokes only its target and linked continuations, with the withdrawal cause on each revoked input. A scheduled turn that is still waiting at handoff acceptance moves to the successor with the same turn, input, due time, and repeating-firing identity, while its model and effort change to the successor's binding. This keeps the scheduler's one-firing-per-sequence constraint intact and prevents the successor from running a predecessor-only model. A proposed handoff leaves it on the predecessor. A queued scheduled turn with uncertain provider admission or unresolved dependencies still blocks acceptance rather than being replayed.

Banked work may opt into **quiet only** at creation. The choice is stored on its turn and inherited when any continuation is queued, including a provider refusal, background release, interruption, startup recovery, or planned boundary. Generic banked work can still start near an allowance reset outside quiet hours. Quiet-only work requires the saved-work time zone's quiet band at forecast selection and the queue's atomic claim, including manual start. Admission closes five minutes before the quiet band's end, and the running-turn controller requests cancellation at that cutoff so unfinished work stops before morning. A continuation retains work without replaying its first input. A requester's cancellation revokes an ordinary or saved queued turn and follows its exact continuation lineage; each canceled input receipt and turn remain as history, and the saved-work list omits them. A withdrawn request cannot create a later continuation. The choice is explicit, never inferred from the project name.

Terminal observations may arrive before asynchronous executor cleanup releases the live registry. Both runtime compositions pass the registry's still-active sessions into the existing atomic queue claim; ordinary Slack admission defers through the same FIFO at that boundary. Registry settlement wakes promotion after releasing its owner. Native setup failures use the exact owned dispatch attempt: before admission or unsafe effects they fail the turn and release the cached session state together; after admission intent they retain ambiguity through the existing parked-turn path. Late failures cannot rewrite a settled result or another attempt, and no setup failure replays an input.

The existing recovery owner distinguishes unattempted input, a known-dead ambiguous attempt, and a saved result. Only proven unattempted work can resume without new effect evidence. Saved results return without another provider call. Ambiguous effects remain inspectable. A deliberate Stop cannot become an automatic retry. Unconfirmed interrupted model input can be supplied as labeled historical context to a later authorized input; it is not permission to repeat prior actions. Native fork controls are excluded from that model history.

Known terminal state stays monotonic. A native result and its notification are distinct from any correlated answer. The Codex app-server observer is composed in both Slack-enabled and Slack-disabled owner runtimes. It uses its own connection, scans the App Server's loaded conversations once on connection or reconnection, and subscribes only to a uniquely bound conversation with running work. Codex broadcasts status changes to every connection; an active transition subscribes the observer to externally started work, and an idle transition refreshes its terminal receipt. A terminal turn releases the subscription once the thread is idle; the next Concierge turn or active status change reattaches it. This follows external work without resuming every saved conversation after a restart or polling all idle ones. For each observed loaded conversation, it reads the latest native item and retains a digest per session. It invalidates history unless the retained thread and digest match exactly. First observation, a rebound to another thread, and an unreadable native head invalidate; a later reconnect to an unchanged head stays silent. Future completed user, assistant and tool items enter the common owner observation stream with their exact provider message and turn IDs; Slack mirroring remains a separate projection of its narrower eligible subset. On-demand history/detail reads use the same native item shapes. Cursor replay rebuilds a view, never submits another run. Archive, pause, outcome, read and attention retain separate meaning.

Session outcome is working-set state, not execution history. `done` means done for now:
the owner changes it back to `open` when a human- or agent-origin input is durably bound
to a queued turn or attached to a live turn as steering. Inputs merely retained while a
session is archived, paused or otherwise unable to admit execution do not reopen it, nor
do service returns or control/observation activity. `shipped` is a distinct work verdict
and no new input changes it automatically. Consumers use `outcome=open` for the active
working set and use execution independently for Running or other lifecycle views.

The visible latest run excludes a redundant service input withdrawn before provider
admission and an empty turn whose input joined running work. Their turns and cancellation
reasons remain in the ledger; the real run stays visible.
A genuinely canceled latest run carries
the actor and reason in exact views and prepared cards. Stop and queued-message withdrawal
record Tejas's action at the turn boundary. A human Stop is identified by its
retained operation for the exact run, rather than by the provider's cancellation
error. Canceling saved work through an agent command records that agent's exact
session address; cancellation through the authenticated app records Tejas.
Legacy records without a reason say so.

Native results and actionable setup errors, provider refusals, parked uncertainty and interrupted/delivery-parked recovery advance attention once per accepted input/dispatch attempt. The existing event ledger retains the attention marker atomically with the generation increment; successful result retention and failure projection share that marker. A retained pre-turn unavailable creation uses its accepted input with attempt zero. This updates neither outcome nor read/dismiss generations, and a stale read or dismiss cannot hide a later failure. Prior result events already prove their attention increment, so compatibility projection does not count them again.

The existing session projection subscribes to native terminal facts as well as Slack facts. Installation performs one catch-up query over retained accepted inputs and their turn rows, recording only actionable native failures without an attention marker. Its cost scales with retained accepted inputs; each selected row receives one event/metadata transaction and ceases to qualify. There is no idle work, timer, provider admission or repair queue. This catches the observed already-retained ChatGPT failure and owner-death recovery without changing input bytes, execution state, provider identity or replay eligibility. Reinstallation and repeated recovery preserve read/dismiss decisions.

A confirmed nonretryable native provider refusal settles as a failed input and releases its session. It is not an uncertain send or an invitation to retry. The existing Slack remediation flow and genuinely ambiguous native effects retain their previous parking behavior.

## Externally submitted Codex turns

The Codex observer subscribes each uniquely bound provider thread while it runs and retains
`turn/started` and `turn/completed` evidence independently of owner-admitted inputs.
The session view uses a newer external turn's provider state and timestamps when no
owner run is active. Its native run ID stays absent: observation grants no Stop,
steering or recovery authority over an unrelated completed owner run. Existing
owner receipts remain immutable. Thinkering refreshes this projection through its
existing owner event stream; no frontend timer or second execution queue is involved.

On subscription/reconnection and `thread/status/changed`, the observer reads live
thread metadata plus one latest turn with `itemsView: notLoaded`. Reads overtaken
by lifecycle notifications cannot overwrite those notifications. Connection loss
or thread closure makes previously observed running work uncertain until fresh
provider evidence arrives. `thread/started` resubscribes a previously closed binding.
Both `contextCompaction` items and legacy `thread/compacted` remain activity within
the turn; neither is terminal evidence. Message/delta traffic alone never implies
a new running turn. Unbound and ambiguous provider identities cannot update a session.

Investigate a mismatch by comparing `sessions.native_metadata_json.codexLifecycle`,
the exact provider thread/turn, and owner `turns.provider_turn_id`. The existing
`session_owner_events` ledger retains `provider-turn`, `provider-lifecycle` and
`provider-activity` evidence. The service journal emits
`codex_session_lifecycle_observed` with session/thread/turn IDs, previous/current
state and source, and `codex_session_lifecycle_refresh_failed` on unavailable reads.
These signals contain no prompts, transcript text or provider errors. A failed
refresh does not establish a terminal result; inspect the shared connection and
the exact provider lifecycle before taking recovery action.

## Session names

Router dispatch supplies an explicit initial name through `--session-name`,
mapped to the existing canonical metadata `title`. Native create and first
input retain that field atomically; routed admission initializes it before
execution and emits a normal owner event. Existing named sessions and later
human renames survive duplicate dispatch. Thinkering consumes the same
`SessionView.title` in its list and detail heading. See the
[wire contract](../contracts/session-owner-v1.md#session-names) for the parameter
and the agent's source-bound title command. Thinkering-origin Codex creation
records the owner's configured model and effort defaults on the session before
the first turn, matching the queued turn selection. A session's live agent names
it and may correct that name later; a title Tejas set himself wins and is never
overwritten. No provider prompt parser,
second naming store, backfill or transcript-title rewrite is involved.

## Requests and returns

Every work request carries the earlier work on its problem, and its first reply says what came before; handed-off, archived and paused sessions still answer questions. See [What came before](EARLIER-WORK-IN-REQUESTS.md).

### Provider-change handoff

A provider change creates a successor on the same Concierge instance; it never changes the
predecessor's bound provider or replays work in progress. A source-bound `sessions handoff`
proposes the successor in the predecessor's project folder and retains one inventory and
its digest. The successor's first input is a handoff brief with that inventory, a pointer
to `sessions context` for the predecessor's decisions, and references to worktree state.
The predecessor still owns and can work on every obligation while the handoff is proposed.
Only one proposal may be open per predecessor; the caller or predecessor can withdraw it.

The inventory names open requests sent by and owed by the predecessor, queued inputs,
active watches, open Lab roles where available, and referenced worktrees. Each item has
a stable kind and reference. Sent requests retain whether their target has acknowledged
or started work; those and ChatGPT requests must not be dispatched again. A sent request (local or to a peer)
that has already settled is still listed while its final return has not reached the
predecessor: not yet written, written but never started, or waiting in a queued turn.
Acceptance moves its return destination to the successor; an unstarted return input
moves in place with its ID, and a queued one moves with its queued item. A return
already handed to a predecessor run stays there and is never replayed. A missing Lab
read is stated as an omission. Worktrees, provider transcripts, past answers and Lab
entries stay where they were and keep their original authors.

Only a live successor run can accept with the inventory digest. The owner recomputes the
inventory; a changed digest or an unsafe queued input refuses acceptance and returns the current inventory for
acknowledgement. Acceptance transfers the open request return and reply ownership,
safe never-started queued inputs, scheduled firings, and watches in one ledger transaction, recording each
moved item. An ordinary queued input's original acceptance and history stay with the predecessor;
the successor receives a linked copy. A scheduled input instead changes session custody in place,
so its accepted input and firing IDs remain stable. The request keeps its own ID. Sent request IDs
and their targets do not change. An owed request's reply ownership moves to the
successor. An outside request retains its unique accepted input as the custody key
until that exact queued input is safely copied; several outside requests never collapse
onto the same handoff brief. Repeating an outside ask after transfer returns its existing
request without dispatching an input retained in the predecessor's history. Other owed
requests bind to the successor's accepted run, and original input provenance does not change.
An Inbox upkeep reminder for an exact request that has already closed is retired in that
same transaction, even if admission uncertainty makes the reminder unsafe to replay. The
closed request's final receipt is authoritative; the reminder is not sent to the successor.
If the request reopens before acceptance, the inventory changes and the handoff must be
acknowledged again.
A queued turn continuation on the predecessor is likewise retired in that same transaction.
The handoff itself supersedes continuation on the predecessor, and the successor continues
the conversation with its own brief and open obligations.
The predecessor is then superseded: owner writes from its run and new requests to it
are refused with the successor's address. Its live run receives a notice and can finish,
but cannot write through the owner; its own outcome and reads remain allowed. Suspension
prevents another turn. The session detail read exposes the canonical continuation chain,
successor ID and handoff ID to Thinkering. `sessions obligations` reports the
outstanding inventory, lineage and current holder on either side of the transfer.
`sessions cancel --reason provider-change` refuses with the handoff command. See
[the router procedure](../runbooks/ROUTER-ACTIONS.md#provider-change-handoff).
The authenticated Thinkering owner API also accepts proposal, acknowledgement and withdrawal
at `/sessions/v1/handoffs` and `/sessions/v1/handoffs/<id>/<accept|withdraw>`, using the
same exact live source input, run identity and stable action identity as request actions.

`session-communication.ts` retains the existing request/event ledger. Request acceptance atomically retains the immutable target, source, content, due time, prerequisites, result destination and native target input before dispatch. A reply names exactly one request. Partial answers may precede its final; ending a turn with other outstanding questions records an unconfirmed-answer disposition with retained output references. A named Inbox thread is the default result destination: the owner posts replies and terminal notices there, retains the request receipt, and marks confirmed completion and successful informational answers delivered without admitting a second input to the requester. Failed, `needs_decision`, unclassified work, overdue, canceled and unconfirmed outcomes also return to the requester so it can recover or decide; Tejas's own Stop remains quiet. `sessions ask --return-to-requester` explicitly adds a requester return for every outcome when the asking agent needs to act on it. A final `--hand-back not-my-subject|too-loaded` also returns to the requester, even for a named thread: the thread keeps its one answer post, and the requester receives a separate actionable copy bearing the fresh-session instruction. Requests without a named thread still return every outcome to the requester. The same rule holds for peer results.

For an ordinary Inbox request naming a thread, the accepted request message is placed in that same thread. Its conversation display carries only the recipient and required one-line human-facing summary. Tejas's words stay in his original message, and the full brief stays in the retained request record for the working agent; the thread UI needs an explicit request-detail affordance before Tejas can open it there. This prevents command guidance and duplicated source text in the conversation while preserving exact request custody. The agent is a thread reply target from the retained dispatch. Request identity, deadlines, prompt-answer signals, final disposition and stall notices remain in the request ledger; the thread is their shared presentation and reply address. The prepared message worker projects this request placement from the retained thread address, including existing request rows, and respects an explicitly placed request root. The router needs no return or working transcript to observe confirmed completion or a successful informational answer. Failure, decisions, uncertainty, overdue answers, explicit requester returns and final hand-backs wake it for a dependency it must act on. Requests with no Inbox thread retain the private requester return.

A final `needs_decision` reply returned to an ordinary requester creates one requester-owned blocking attention item when the service return is admitted. The return input identifies both the question and its notification, so local and peer retries do not create another item. The worker's agent-origin attention is not a second push; the requester item names the worker and task, and opens the exact return in the requesting session. Later agent turns leave this decision open until Tejas answers in that session; an Inbox thread continues to own its own question and notification.

An Inbox router turn may post its answer into a thread before it ends. At result retention, the owner follows the opening input through the canonical thread resolver and records a stable marker if that turn posted in the same thread. A closing-only return's owner relay records its post and marker together. The result stays in retained session history but is omitted from the Inbox conversation and prepared thread view; a turn with no post in that thread still shows its closing answer. Startup reconciles older post/result pairs through the indexed turn sequence in short batches and records completion once; a prepared-view upgrade removes their duplicate closing rows without deleting the underlying events. Both message readers use the marker rather than reimplementing thread lineage. This prevents the router's post and final narration from reading as two answers to one message.

The communication and peer owners reconcile their existing durable rows with one in-flight
pass each. Startup restores late retained returns before either owner dispatches; the root
request socket is already bound, so this migration yields after each event or request. Each
pass captures a rowid high-water mark for its request, event and inspection stages, visits
one record at a time, and yields to I/O before the next. An execution change during a pass
marks another pass, which revisits older changed rows and picks up newly accepted rows.
The existing per-request task map still serializes one request while independent network
operations remain in flight. Stop halts scans at the next record boundary and waits for
their active work. Return auditing keeps its minute cadence and terminal decisions but uses
the same yielding record boundary. This bounds event-loop occupation across independent
records; work within one request, such as looking up its sibling questions or matching
returns, remains atomic and may read several rows.

Request prerequisites wait outside session FIFO, so a reply that unblocks a continuation can enter the requesting session when a requester return was chosen. Those native return events use the same accepted-input and queue machinery. A return may steer only into its exact original asking run while that run remains live. Otherwise it enters FIFO, including when another return or human input is running in that session; idle requesters resume through the same queue.

A busy recipient is never a refusal, for any provider or sender. The coordinator chooses live delivery for agent requests and service returns, so a live input that provider evidence proves was never received — a `failed` steering row with no `provider_sent_at` — returns once to that session's own queue through `recoverUnsentSteeredInput`, keeping its input, request and event identity. It then runs as an ordinary turn when the session next accepts work, and the sender sees a queued receipt rather than a failure. The failed steering row remains evidence and the new queue placement has its own observation identity. Four cases stay terminal instead: an acknowledged or ambiguous send, which is never re-enqueued; a deliberate human `delivery:"steer"`, which names one exact run and refuses by contract; a retained Slack-provenance steering message, which belongs to the deprecated surface; and an archived or suspended session, which cannot accept the input at all. `capabilities.send` is therefore independent of execution state: it reports whether this session can receive input, not whether it is idle right now.

Retry identity is the accepted input ID. A second dispatch of an input with a steering row reads that row's recorded state instead of inserting another row or enqueueing another provider message. An input that already has a failed, provably unsent steering row runs from its queue turn; the earlier-waiting promotion cannot withdraw that turn for another steering attempt. If a previous promotion already detached its queue turn, recovery completes the queue placement under the same accepted input ID. A sent or ambiguous row is rebound to the input without replay. The unique steering index remains the last line of defense, not the normal retry decision. The October 16 incident was four service returns that were queued after a restart, then withdrawn by the earlier-waiting promotion and retried as steering every few seconds. The promotion also asks the run's own admission rule before withdrawing any waiting turn (`canJoin` on `releaseEarlierWaitingInputs` and `releaseWaitingInputs`): a run opened by Canvas speech takes only speech from its own board and page, so a return or request waiting behind it keeps its queued turn untouched. Withdrawing first and refusing afterwards re-queued twelve waiting returns into fresh turns on every speech segment he sent (147 turns for one return), ~170 statements each, until each send held the owner about a second (November 2, 2026, `docs/incidents/2026-11-02-think-aloud-send-requeued-every-waiting-return.md`).

ChatGPT and consultation-only recipients cannot invoke reply tools. Their incoming requests queue as separate inputs. The service correlates a final result only for the exact acknowledged request input, one question, no intervening steering and a completed native execution. Otherwise it returns the unconfirmed-answer disposition and output references. Consultation-only targets reject requests for work before acceptance.

An agent's addressed ask can select a historical `consult:true`, `send:false` source. The owner verifies its retained version, branch, boundary and dialogue hashes using the same evidence preparation as human consultation. It atomically creates a distinct restricted child, its agent-origin consultation input, the requester operation and mandatory correlated return. Supplied evidence must belong to that exact dialogue; work and attachments are refused. Source/action duplicates keep the same child and request identity. The source run and binding are revalidated after asynchronous evidence retrieval, before provider dispatch. The child uses the existing informational policy/FIFO, and the service returns its exact acknowledged result. Agents never enter the human consultation route or acquire human origin.

Refreshing an imported source to a different retained version advances its address binding generation while preserving its canonical session ID. Search returns the current view after that refresh; an old address cannot silently contact newer history.

Explicit provider intent is interpreted by the admitted agent's instructions. `sessions ask --provider <alias>` uses the same source-bound owner as an addressed ask. Atomic acceptance creates a native session, its agent-origin first input, attachment custody, request operation and selected result destination. Codex/Claude creation requires an exact canonical project folder with agent instructions: a folder with its own Git root and an `AGENTS.md` or `CLAUDE.md` (either may be a symlink, since team repositories keep their own layout) that is a workspace child, a child of a plain grouping folder (the Mac's `ideaflow/`, whose Cortex was unstartable until 2026-09-30), or a separate expertise repository in the lab's ignored `agent-ecology/expertise/` folder. A workspace child keeps its name over a grouped one; a nested expertise's own registered project owns its tasks and file attribution. A writing workspace directly inside an Obsidian vault (a workspace child or grandchild holding `.obsidian`) is also a project, which Obsidian Sync keeps as one copy without Git; the owner resolves its cwd independently of historical Slack channel rows and pins the existing alias table's model and selected reasoning effort before dispatch. The retired `D0BMWUJ3RD5` DM folder is excluded. ChatGPT uses `--provider chatgpt` without project/effort. The HTTP spelling is `targetProvider` instead of `targetAddress` on `POST /sessions/v1/requests`, with optional `effort`, `project`, `files` and `captureId`. An exact native input/run or accepted Slack input supplies provenance; text cannot grant human origin, restricted consultation cannot escape policy, and ChatGPT cannot create outbound requests. Source/action retries retain the original target even when unavailable.

The [native Inbox](../contracts/native-inbox.md) is an active session in this same ledger.
Its Claude Opus 1M session runs from the `slack-inbox` repository; prior Inbox
sessions retain their native identities and accepted history across the cutover.
Trusted capture admission retains original source/attachment custody and queues through
the same owner. Import-only captures remain visible without provider execution. The
Inbox's readable history is paginated over existing accepted/result events; source
diagnostics stay in files. Editable note saving uses the existing Thinkering capability
socket, with source/run validation and capture-ID idempotency. No alternate router,
capture queue or session database exists.

Unavailable creation retains a failed operation without a provider turn and returns that failure through the existing service input. An exact ChatGPT attempt parked by its execution owner may likewise settle the request as failed using its retained error once the owner release, ended timestamp and failure class are durable. The provider turn stays parked; this observation does not release its session lock, satisfy provider dependencies or authorize replay. Configured admission and capability evidence remain on the exact operation. No new queue, provider owner, recognizer or fallback is involved.

One due time and one timer inspect unresolved work after 15 minutes (`STILL_WAITING_AFTER_MS` [decision: still-waiting-after-15-minutes]). While a Concierge update is draining, nothing is reported: the next inspection moves on, because work held only by an update is waiting, not stalled. It records health and a durable reminder to the asking agent, naming the request from its retained summary or words and telling that agent to inspect and follow up or cancel if needed. This agent-only reminder is never posted as a message in Tejas's Inbox thread. The request stays open; a later answer still reaches its chosen destination. The reminder does not infer success, override Stop or replay an ambiguous effect. Work still running under a live owner is not unresolved work: its next inspection moves to the next interval and nothing is reported, because a healthy investigation presented as a stall is what makes the whole signal untrustworthy. This optional postponement stays in owner memory and in the receipt's effective due time; it does not write the ledger or gate a durable command receipt. After restart, the still-due accepted request is inspected again, and only a genuinely stalled request creates the durable once-only reminder. When a stall is real, the requests one recipient turn is holding report one notice between them, since they are one piece of work. No pending deadline means no timer. An empty queue scan emits no execution-change wake. There is no autonomous conversation quota, periodic repair scan or second scheduler. The [routed request architecture](ROUTED-REQUESTS.md) retains Slack publication and fixed `work/--after` semantics.
Each communication wake still reconciles unresolved accepted inputs and open requests for crash recovery. Its queries seek the narrow unresolved input and open-request indexes before applying receipt and due-time checks; retained resolved history must not be scanned on every execution change. Capture scopes use the canonical lowercase `capture:` prefix. The two recovery scans name their partial index with `INDEXED BY`, because Bun's bundled SQLite otherwise walks every input without a turn through the plain turn index, and a request's events are read through `session_communication_events_request`; before both, one wake re-read the events table about twenty times and the inputs table twice (2026-10-30, [record](../incidents/2026-10-30-communication-wake-scanned-events-and-inputs.md)).

A request closes only through a command: the recipient's explicit final reply, the
requester's cancel, or a failed or canceled execution. Successful provider turn completion
closes nothing, whatever the turn's text says; the request stays open until the recipient
session replies, and any later authenticated run of that session may do so. The original
admission/turn stays pinned as execution evidence. The owner no longer reads a finished
turn's text as `undetermined` or its silence as `unanswered`: that closed 63 requests
between September 16 and 23, 2026, 34 of them after a partial reply, and discarded a real
final that arrived six minutes after one such closure. The single exception is a recipient
with no reply command (ChatGPT, consultation-only): a turn dedicated to one request is its
reply. A stranded request (the recipient is not running, has nothing queued and waits on no
live request of its own) was held by the recipient's Stop hook when it tried to end the turn, and
gets one stalled notice to the requester, which does not close it; see the
[request reply protocol](../plans/2026-09-23-request-reply-protocol.md). Explicit final
dispositions remain immutable; an owner-inferred final recorded before
this rule is superseded by the recipient's later explicit final (`superseded_by_event_id`,
unique among unsuperseded finals), which returns as its own event while the earlier return
stays history. A peer origin answers each forwarded reply with `recorded`, `duplicate` or
`refused`, and the recipient marks a refused reply refused instead of forwarded; the first
start of this release rereads the peer's reply record for recent inferred peer closures.
Stop ends only that run;
new requests and later returns remain messageable through the same FIFO, while
pause/archive still hold admission and return delivery. A final reply settles exactly the
requests it names: its own and any it lists with `--also`. Sharing a recipient turn settles
nothing. From September 17 to November 4, 2026 a sibling's explicit final also settled every
other request the turn held, because replies could then name only one request and turns that
answered three questions confirmed one. Once `--also` existed and the turn-end check sent a
recipient back for each unanswered request, that rule only ever copied an answer onto a
request it did not answer: the Inbox sends one request per thread, they steer into one turn,
and on November 4 one thread's answer closed two other threads with the wrong text
([failure record](../incidents/2026-11-04-one-reply-closed-sibling-requests.md)).
The recipient session is one
conversation: a run that follows an interruption may answer requests delivered to the
earlier run. An ambiguous steering input cited by its own live run is a valid source. That is strong
evidence of receipt rather than proof, because its ID derives from a request ID that another
message can quote, so the owner records no acknowledgement from it.
Partial replies neither extend nor replace the original overdue
deadline. Its service event wakes the native requester without Slack or an expired run
identity supplied by an external timer. This is a request safeguard, not deployment health
proof: the recipient still owns reporting actual activation or a specific recovery blocker.

## Read-only sources and provider capabilities

Message display metadata stays attached to its exact provider message and retained turn. History and event reads expose optional `createdAt` with `timestampSource` (`provider`, `received`, or `submitted`), `model` with `modelSource` (`provider` or retained `run`), and `reasoningEffort` with its provider/requested provenance. If only a requested model is retained it is `requestedModel`; a session's current model never relabels older messages. Missing native metadata remains unavailable. Event reads filter before projection; metadata joins are batched once per history page or event flush.

Every message the owner can attribute carries `inputId`, the accepted input it belongs to, so a client threading a request to its replies reads an owner-established identity instead of inferring one from page order, and the attribution is unchanged after a reload. `turnId` is not a substitute and never was: it is the provider's turn identity, present on every message event but absent from the Inbox ledger page, which builds its messages without one, and a receipt has no `turnId` field at all, exposing `runId` and `inputId` instead. A client comparing a message's `turnId` to a receipt's therefore compares against nothing. All three history paths supply it, because a session reads through exactly one of them: provider history projects a user message's existing prepared-byte match and resolves an assistant or tool message through `sessionMessageInputProjection`, which reads the input recorded on the retained message event for that exact message ID, native turn and role; the Inbox ledger page uses the input on its accepted/capture and result events; the turn fallback uses the turn's accepted input. Several retained events for one message must agree; a disagreement leaves the message unattributed rather than guessing. `submissionId` keeps its separate provider-submission meaning. The provider-history join batches once per history page or event flush beside the metadata join.

Both joins depend on `session_owner_events_session_kind` for their cost, not just their speed. Each requested message matches by `session_id` and `kind` before any `json_extract` on the payload, so with the index SQLite seeks that session's events, and without it the planner scans all 52k events once per requested message — page cost becomes requested count times table size, and it grows with the whole ledger rather than with the session being read. Measured on the production copy at 52,514 events: one 160-message page took 4.47s in the input projection and 4.43s in the metadata projection, against 72ms and 68ms with the index. The planner chooses it with no `ANALYZE` statistics, which is what production runs — `sqlite_stat1` does not exist there. Do not drop this index to simplify the schema, and keep new per-message joins on the same two columns.

Attribution is per message, not per turn. `projectSessionProviderMessage` records the steered input that the provider has acknowledged so far, falling back to the input that opened the turn, so a steered input owns the output produced after its send. This is resolved as each message is recorded because it cannot be recovered afterwards: `provider_sent_at` and event `created_at` are both second-granularity and a turn emits several messages within one second, so no retained comparison can place a message on either side of a boundary within that second. Only `status='sent'` moves attribution — an ambiguous or failed steering send proves nothing about what the provider received, and legacy steering rows without an accepted input fall back. Messages retained before this existed remain turn-granular, so a thread rooted at an input steered into an older turn is empty; a client must resolve an empty thread against its receipts before asserting anything, because a request receipt carrying `settlement` or a completed state proves the reply exists and is recorded against another input. Saying nothing replied is then a confident falsehood rather than a missing detail, and the receipts are what distinguish it from a request genuinely still unanswered.

Measure that impact on threads rather than on roots. Steered roots undercount it: `concierge:3172` has 9 steered inputs out of 231, but on its live Inbox 19 of 83 threads are empty-while-answered against 7 genuinely silent, because a thread also empties when its replies were attributed to whichever input opened their turn. The user-visible population is roughly three times the silent one, which is why this is worth the projection rather than a marginal case.

That history cannot be repaired, and the reason is worth keeping so nobody tries. Neither provider's retained message identity places a message relative to a steering boundary, for opposite reasons: Codex keeps one provider turn ID for the whole owner turn across steering, by design, since `turn/steer` passes `expectedTurnId` and asserts the response names the same turn — 61 steered Codex turns, every one with exactly one distinct `message.turnId`. Claude assigns a distinct ID per message — 12 to 164 distinct across each steered turn — so per-message identity carries no segment information either. With the second-granularity timestamps, that is two independent proofs that the boundary is a fact only the recorder holds while it records.

The acknowledgement echo this depends on is asymmetric between providers, which bounds what the fix delivers. Codex acknowledges every steering send: 133 of 133 retained rows with an accepted input are `sent`. Claude acknowledges 10 of 30, with 16 ambiguous and 4 failed, so on Claude a steered input owns its output only when its echo arrived, and the other two thirds keep the turn's opening input. That is the conservative outcome rather than a gap to close by guessing.

One edge stays open. A message that belongs before a boundary but reaches `projectSessionProviderMessage` after it — via `codex-session-observer.ts` observing an item for an owned turn, rather than the live stream — records the steered input. It is bounded to one message inside the same turn, both candidates are inputs in the same thread, and `recordSessionEvent` keeps the first write for an event ID so a replayed duplicate cannot flip a recorded attribution. Closing it exactly would take the Codex app server's steering boundary tied to `clientUserMessageId`, already observed in `codex.ts` as `observedSteeringBoundaryClientIds` driving `suppressOutputUntilSteeringBoundary`: a stream-ordered marker that places an item correctly regardless of when the observer delivers it. Codex-only, since Claude has no equivalent. Not taken without an observed instance.

A client that already holds a page asks only for what changed since it. Every history response carries `asOf`, taken from the ledger head before the page is read, so an event recorded during the read reaches the next delta rather than neither; the client upserts, so the overlap is harmless. `history?after=<asOf>` answers from whatever the page was built from, because the ledger does not fully mirror a provider transcript. The Inbox page is its own ledger rows, append-only and never rewritten, so its delta is those rows after the position. A Claude or Codex page is the transcript, and a Claude steering message can sit there with no ledger event at all, so a ledger-only delta would omit it rather than deliver it late. Its delta instead re-reads the transcript tail and anchors on the newest message the client held plus a fingerprint of that whole window: newer messages are the change, and older ones are resent only when the ledger shows a new version, a turn-level event on their turn (every finished native turn closes with a `run` event after its messages, which carries the final timing), or a reaction or save. A vanished, moved or inserted message breaks the fingerprint and the answer is `reset`, since clients never infer deletion from absence. The Claude reader already reads the whole transcript (28 ms for 220 rows) and Codex pages from its own server, so reading a page beyond the held window is cheap. Imported sources, ChatGPT and the retained-turn fallback have no exact delta and always reset.

A read a client repeats is bounded by the owner, not by the client's patience. `GET /sessions/:id/history` already pages. `GET /events` accepts comma-separated `kind`/`runId` sets and a `limit`, returning `hasMore` with a `nextCursor` at the last sequence the read scanned, so unread and mention state cost a page instead of the session's whole ledger; an unfiltered `after=0` read is a full replay and is not an attention read. `GET /sessions/:id` accepts `limit`/`cursor` over its receipts, whose retained request and result bodies grow without bound in the Inbox; it returns the newest page oldest-first with `nextCursor` for the older page. Both stay unbounded when the caller passes no limit.

Receipt paging is not the Inbox's lever, and the reason generalizes. Inbox routing status is derived by scanning all receipts for the `request` receipt whose `request.sourceInputId` matches a thread's key, so a window that omits it renders a routed, answered thread as never routed — confidently wrong rather than incomplete, which is the failure this whole area exists to remove. The owner answers that read in ~350 ms for its 1.8 MB; it presented as 35 s only because it queued behind the unbounded events read on the same connection, so bounding events is expected to be the whole fix. If a measured problem remains, omitting the `text` and `result` bodies is the correct lever for a cross-scanning read, because `request` and `settlement` are what routing and status are made of while `text` duplicates message content the client already holds. Page only a view whose receipts are already scoped to what it renders.

The browser retains its event cursor with the corresponding disposable read-cache snapshot. A cold stream may use `after=now` and load authoritative history instead of replaying the entire event ledger. SSE emits `caught-up` with the processed cursor after initial replay; reconnect honors `Last-Event-ID`. Catch-up updates cached messages and invalidations, then reconciles changed cached sessions once. It does not make each historical terminal event download another history page. Thinkering owns cache persistence and the existing routed scroll pane; Concierge remains the accepting owner.

Unread activity and human attention are separate. Ordinary results and failures remain visible without setting `needsAttention`. Every working turn ends its ordinary answer with one exact marker line, `[[outcome-k7q4:done|response|needs_you|failed]]`, the text after `needs_you` being the question and after `failed` the reason (`bot/src/turn-outcome-marker.ts`). There is no schema, form or tool call. Only that exact marker alone on the last line counts, so outcome words in prose mean nothing; the marker is stripped from results and history. `response` is an answer he needs to read that blocks nothing; it raises attention like `needs_you`, and its `needs_you` attention event carries `outcome:"response"` with the text after the marker (or the answer) as `question`. A final hand-off reply's work disposition also declares (completed→done, failed→failed, needs_decision→needs_you, an informational final answer→done); the turn's own marker supersedes it. ChatGPT's answer counts as done; consultations declare nothing. A native turn that ends without a marker is recorded `finished_without_saying`. `needsAttention` comes only from declared `needs_you` outcomes: each records a `kind:"turn_outcome"` event and a `kind:"needs_you"` attention event `{question,inputId,generation}`, where `inputId` is the input it answers — in the Inbox, the request thread's root. An open question clears when Tejas sends a message in that session (in the Inbox, a reply in that thread), when a later turn declares (in the Inbox, for the same thread), or when he dismisses it past its generation. Reading never clears it, and `finished_without_saying` neither raises nor clears it. `SessionView.turnOutcome` is `{outcome, question, inputId, at}` for the latest declaration, or null. `@Tejas` text no longer affects attention.

Before a native ChatGPT binding exists, the provider history adapter returns no native page so the common owner can show its retained input/output history with incomplete coverage. This read never invokes the ChatGPT capability or changes the uncertain attempt. Once bound, the exact account/conversation reference remains required and capability failures remain visible; imported source history retains its existing source-reader path.

Slack routing indexes only Slack-provenance inputs, including genuine Slack steering on a native run. Accepted native steering and service returns stay in the common owner catalogue instead of becoming malformed Slack sources. The projection version rebuilds that source boundary on upgrade. Existing views are preserved transactionally while the nullable Slack-column migration replaces their underlying tables.

Thinkering's existing process serves the configured root-private capability socket. The source reader retains original bytes, exact version/branch/event/role/locator/hash and coverage. Partial inventory stays partial. Importing history creates searchable source provenance, not an execution owner. Historical candidates visibly carry `consultation-only` and separate availability before context/contact.

An authenticated host/surface may request one ChatGPT inventory pass through `POST /sessions/v1/sources/refresh`. The owner invokes the configured capability's existing refresh instance; it never starts a new scheduler, retries a rate limit or sends a model input. The owner remembers, in memory only, the most recent pass it started: a POST while it is pending joins it, and `GET /sessions/v1/sources/refresh` returns its start, settle time and result or error without starting one. A rate-limited pass took 267 s on 2026-10-13, past the gateway's 120 s command deadline, and its 200 reached nobody; a caller cut off at that deadline reads the settled outcome rather than re-POSTing, which would start a second crawl. Startup restores retained bytes without a browser refresh. Search retains the actual saved/pending coverage.

Mac consultation creates a distinct common-catalogue child from a pinned cited dialogue packet. Initial and subsequent execution, retry and recovery enforce the same information-only policy: no tools, filesystem changes, network or outbound session messaging. A native fork that cannot retain that policy is unavailable. The service supplies correlated results without exposing outbound model tools to that child. Native continuity and reconstructed evidence remain different fidelity claims.

Codex reads effective configuration for every consultation thread start/resume, including recovery, and disables each configured MCP server through one structured `mcp_servers` override. Nested server names remain literal, including dots and quotes; Codex's dotted override paths do not interpret quoted segments. Native table merging preserves each server's existing transport while setting `enabled: false`. No host profile or daemon configuration is rewritten. The remaining tool, filesystem, network and outbound-action restrictions still apply, and the provider must confirm the restricted permission profile before turn admission. The parser contract is pinned to [Codex 0.153.4 overrides](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/config/src/overrides.rs) and [table merging](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/config/src/merge.rs).

ChatGPT uses its original account/conversation/browser binding. Explicit human bind retains a control intent before independent source/account/anchor verification. The capability adapter independently reads the exact owner operation and current binding before any browser send. Prepared bytes/model/attachment hashes are pinned at provider admission. Existing-effect observation and reconciliation never resend. A `prepared` receipt failed as `CHATGPT_NOT_SENT` or `CHATGPT_SEND_FAILED` proves no browser dispatch began; the owner queues a bounded retry under its original run identity and a per-turn retry budget, independent of an older account-wide terminal refusal. A repeated start rearms it only after the current admission is checked. A start that still finds Thinkering restarting after two minutes (503, a refused connection or an unreachable owner check) ends `CHATGPT_NOT_SENT` as well: every attempt of a turn reuses its one run id, which Thinkering accepts at most once, returning an effect it already holds instead of sending again (12:47 on 2026-10-16 parked one as uncertain while Thinkering held no record of it). Dispatched, acknowledged, uncertain and model-mismatch effects remain read-only and are never replayed. Other failed starts and unavailable browser states remain visible ChatGPT outcomes; another provider is never silently substituted. Inventory and snapshots grant no execution. There is no ChatGPT MCP endpoint or outbound model session tooling.

## Peer instances

A second Concierge (Tejas's Mac, `CONCIERGE_PEER_NAME=mac`) is a peer: the same
runtime with its own ledger, reached over Tailscale on a token-guarded listener that
serves only `/sessions/v1/*`. `session-peers.ts` extends `sessions ask` with `--peer`:
the origin retains `session_peer_requests` plus the requester's ordinary `request`
operation and return obligation; the peer creates the target through
`createRequestTarget` and retains `session_peer_deliveries`. The peer reports execution
facts and forwarded replies (`session_peer_replies`) to the origin, which applies the
same settlement rules as a local request and delivers returns through `admit`. Peer
identities in receipts and provenance read `<peer>:<n>`; agent authority stays
source-bound on the instance that runs the agent. See the
[peer runbook](../runbooks/PEER-INSTANCES.md).

## Composition and operation

The common API uses the existing `<CONCIERGE_STATE_DIR>/requests.sock`, mode0600. The systemd source configures `CONCIERGE_SESSION_CAPABILITY_SOCKET=/run/thinkering/session-capabilities.sock`; Thinkering hosts that socket in its existing process with a private parent directory. Sandbox configuration must supply only its own capability path.

Slack remains enabled by default. With `CONCIERGE_SLACK_ENABLED=0`, `session-runtime.ts` starts the same owner/FIFO/providers without loading Slack configuration, authenticating Slack or publishing an input. Existing Slack bindings remain retained provenance. Normal provider tools receive their exact owner's state/socket and helper backing through service-issued execution environment; an isolated source run cannot fall back to production. Headless legacy Slack helpers receive no Slack credential source.

This change does not import discarded Thinkering extraction bookkeeping or implement a replacement extraction runner. Thinkering's `workspace.sqlite` and published effects remain untouched. Completed extraction/transform work must never be replayed or republished.

Selected workspace revisions reach provider preparation only through the authenticated surface's hash-verified `context` snapshots. Saved shared/workflow instruction files remain editable in Thinkering; the common owner does not read or apply those files, create workflow-folder outputs, or revive the held runner callbacks. The surface must not claim those execution effects while that path is held.

The owner answers every read from one event loop, so a slow synchronous read delays all the others. Each owner request slower than 250 ms of the owner's own time logs `owner_request_slow` (route with query names only, duration, status, bytes). Time a request deliberately spends awaiting an answer from outside the owner, such as a side question's throwaway provider copy, a call over Thinkering's private capability socket (every `SessionCapabilityClient` call: source refresh, search, context, history, import, captures), or speech-job staging and worker completion, is recorded on its `owner_request_slow` and `owner_request_completed` lines as `awaited_ms` and left out of that judgement. Speech requests measure the asynchronous staging, worker startup, and result waits separately; synchronous attachment checks and result commits remain owner time. Waits that overlap, nested or side by side (a search fans its archive retention proofs out to Thinkering together), count once, as the time at least one of them was pending; on 2026-10-15 counting only the first sibling read a 29 s proof copy of the Inbox router's 383 MB transcript beside a 3 s one as 26 s of owner slowness and opened incident fa772103. `duration_ms` stays wall time, so a reader that judges the owner by these lines (remote-box's Concierge monitor) must subtract `awaited_ms`. A POST body is also awaited time: the owner's handler reads it from the gateway's stream, and a Mac agent's reply with screenshots crosses the Tailscale relay while it waits; on 2026-10-24 one 7.3 MB reply (two 2.7 MB PNGs as base64) took 13.7 s to arrive with 68 ms of ledger work, no loop lag and idle readers, and opened work-flow supervisor incident a8216a4c. On 2026-10-13 five side questions of 8-11 s each, with under half a millisecond of ledger work apiece and no loop lag during them, were counted as owner slowness and opened work-flow supervisor incident 838dfa4c; it reopened the same day on the 10:30 UTC ChatGPT transcript refresh, which waited 267 s for Thinkering behind a rate-limited ChatGPT browser with no ledger call and no loop lag, because only the side-question route recorded its wait. Also, a 250 ms tick that fires 200 ms or more late logs `owner_event_loop_lag` with the requests in flight and the owner's memory at that moment. Because that line is written after the loop runs again, the owner's work also carries a name (`owner-task-labels.ts`): every timer callback and owner request runs under a label that follows it through awaits, and the main thread stores the running label in shared memory when a callback or request starts and at every ledger statement, log line and JSON parse or stringify, clearing it when the callback's synchronous part returns. A watchdog thread (`owner-task-watchdog-worker.ts`) reads that memory every 50 ms. From 200 ms it publishes the block's label, which the next `owner_event_loop_lag` line carries as `task`/`task_marked`; from 500 ms it logs `owner_task_blocked` (the label at the start; `label_shares_ms`, each label's share of the block from 50 ms samples, so a stretch of several pieces of work names each one; `ledger_wait_ms`, ledger time inside the block, which tells a disk wait from computing; memory at start and peak). The routed-request API, runner routes included, runs under route labels with identifiers replaced by `:id`, from 5 s also `owner_task_still_blocked` while still blocked, and `owner_memory_jump` when the process grows 300 MB within a second. A block in awaited or event-driven work that passed no marking point is reported as `unmarked` with the label that ended last, never as another timer's label. JSC's sampling profiler is not used: starting it stalled this loop for seconds at the owner's code size (PR #484). Stand-in check with the production Bun and 40,000 compiled functions: a 2 s block after an await in a timer job was named exactly; no added loop blocks; about 0.7% of one core at 200 timer callbacks a second. A receipt that has settled for good is computed once and reused, the same invariant `changedAfter` relies on. On 2026-09-22 a full Inbox receipt read (2,124 receipts, 9.5 MB) took 2.8 s and held every read behind it while his phone opened from a notification.

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

## Read and dismiss action cost

The owner clamps a read or dismiss generation to the session's own attention counter without projecting the Inbox's questions. A requested generation above that counter can be inherited from an older session; only that exceptional case resolves the exact open attention list before clamping. The normal action retains its receipt and event, advances the canonical session row for the prepared catalogue's change journal, and returns the existing bounded session view to Thinkering. The October 19 phone catch-up showed why this matters: projecting the Inbox's question list solely to calculate a ceiling cost about 8,900 ledger calls per read action.

## Admission, identity and return invariants

- Retained audio attachments keep their original bytes and an optional transcript
  in the same attachment row. The authenticated human surface can request transcription
  of a retained audio ID before sending; retry reuses the retained text. Provider dispatch
  uses that text and avoids repeating it when it is already in the accepted human message.
  A forwarded recording is a new custody copy of identical bytes, so it reuses the words its
  original already has (found by `sha256`) instead of being transcribed again.

- Executable input receipts expose `statusDetail` with a human reason, known condition
  clearance time and whether that exact input retries automatically. Terminal failures
  remain immutable history. ChatGPT's retained not-sent codes are translated into the
  explanation that the attempt stopped before Send while the raw code remains diagnostic
  evidence. A native turn parked with an unconfirmed outcome is never
  replayed and never holds back later inputs: the next one runs and carries it as
  unconfirmed context, because nothing reconciles it and a Mac request sat queued behind
  one for five days (mac:69, Oct 1–6, 2026). A queued request that is held (sign-in, usage,
  or anything that will not clear by itself) tells its sender at once, from a peer too
  (`inputHold`). See the shared wire contract.

- Ambiguous steering follows its linked turn's confirmed terminal state, with a separate
  `STEERING_DELIVERY_UNCONFIRMED` explanation while provider acknowledgement is absent.
  Turn completion never proves that particular steering input reached the provider;
  keep `acknowledgedAt` null and do not replay it. See the shared wire contract.

- Saved sessions, saved messages and message reactions are personal owner state in that
  same ledger. Every message mark keys the canonical session plus exact provider message
  ID; Thinkering may cache projections but must not use browser storage as cross-device
  truth or reopen a neighboring message when an exact target is unavailable.

- Session names use the canonical metadata `title` shown in Thinkering. Router
  `--session-name` initializes that field; do not add a separate display label or
  infer names inside Concierge from task prose. See the shared wire contract.

- Native session/input identity is independent of Slack. Never fabricate a Slack message,
  channel, timestamp or provider binding to satisfy an obsolete caller shape.

- Selected-message actions resolve exact retained native message references in the common
  owner. Comparison replays only human requests through that boundary; Inbox capture
  retains explicit note/action intent without a provider turn; task creation appends to
  the registered project's existing `notes/TODOS.md` authority. The browser never supplies
  replacement message bytes, and no parallel task store or Slack route is introduced.

- One recipient turn commonly holds several of a requester's questions: the first opens
  it and later ones steer in. Each is settled only by a reply that names it; a recipient
  answering several together names them with `--also`, and each named request records its
  own final with the same words. A sibling's reply never settles another request (see
  "Requests and returns" and the November 4, 2026 failure record).
  A steered request the provider never acknowledged can still act as a
  source input for its exact live run. That citation is strong evidence of receipt but not
  proof (the input ID derives from a request ID another message can quote), so it records
  no acknowledgement.
  Any live run of the exact recipient session may reply to a request delivered to that
  session, so an answer after an interruption lands. Duplicate reply actions can be inspected after the run ends. An unanswered prerequisite
  holds its dependent request for a decision; it does not prove the prerequisite failed.
  A dependent the requester asked after that outcome reached it is the decision and is
  delivered; otherwise the requester cancels (`sessions cancel`) or asks again. A hold
  with no release path stranded requests silently for a day (September 17–19, 2026).

- Work running under a live owner, or a recipient session still running after the bound
  turn ended, is not a stall. The due-time inspection defers it to
  the next interval rather than waking the requester, and when a stall is real the
  requests one recipient turn holds report one health event between them, not one each.

- Final work replies declare `completed`, `failed`, or `needs_decision`. Declared
  completion settles and returns as soon as the reply is recorded. It used to wait for
  the answering run to end, which held answers for hours in a Claude session that takes
  new requests by steering into one long run (September 21, 2026); the recipient's
  explicit declaration is the confirmation.
  For a named Inbox thread, confirmed completion is retained and posted without a requester
  input; failures, decisions, uncertainty, overdue answers and final hand-backs are carried by
  exactly one `return:<eventId>` input. A request without a named thread returns every outcome,
  while a paused, archived or missing requester holds an actionable return. One answer reaches a requester once:
  finals to the same requester from the same session with byte-identical words and the
  same disposition share the first one's return, which names every request it closes, and a
  later identical copy joins the return already delivered instead of starting another
  requester turn. One answer closing five requests arrived as five Inbox turns and five lines
  on his screen (September 23, 2026). Identical bytes are the test, never similar words. The
  named thread's post and received event are the delivery proof for quiet completion; a result
  with no such destination must retain its requester return. `session-return-audit.ts` audits
  the destination each request actually requires. A run ended by his own Stop (a human `stop` operation naming that
  run, `stopped-by-tejas.ts`) settles as his stop: a quiet line in the Inbox thread it served, never
  a router turn or a notification; a cancellation without his Stop says so and asks for follow-up.
  What Concierge writes into an agent's conversation is plain words (`session-notices.ts`): an answer
  or cancellation names the request by its summary and the other session by its title, with no
  request, event or session numbers and no "not new authorization" line, because the identity
  header already carries the exact request, origin and authority; a number appears only where the
  agent must type it (a robotic notice reached a ChatGPT chat on 2026-10-09).
  A partial reply is not a result and wakes nobody: it is recorded on
  the request and read with `sessions get`, because each wake re-read the asker's whole
  conversation (one lab session, ~860k tokens per note, four times for one note, 2026-10-08). Legacy `retained` rows stay as history; the Inbox's
  rows from that day were re-delivered once in one digest reply, and rows the old runtime
  retained during rollout, or held waiting for their run to end, are released to return
  at startup. An
  unclassified work answer is `undetermined` and holds dependents. Never infer
  success from `requestedEffect`.

- Persist accepted intent before external effects. Retain exact action/input/run identity,
  verify current ownership, and preserve uncertain outcomes. Never replay completed work
  or resend an ambiguous provider effect merely because a response was lost.

- Every attributable message carries the accepted input it belongs to as `inputId`, so a
  client threads a request to its replies from owner-established identity rather than
  page order; `submissionId` keeps its provider-submission meaning. Any owner read a
  client repeats is bounded by the owner: event reads take `kind`/`runId` sets and a
  `limit`, a client holding every receipt asks `changedAfter=<asOf>` and gets back only
  those still able to change plus new ones — decided from whether each receipt has
  settled for good, never from which events fired, since a hand-off's answer records no
  event on it — and receipt reads page, so unread state and Inbox receipts cost a page instead
  of the whole ledger. A receipt looks its request up with `find`, which answers null for an
  id no table holds (a project set-up's return, a Mac request the peer table dropped), so one
  such row never refuses the whole read: it did, for every Inbox receipts read from 2026-09-28
  to 2026-10-01, and his phone said "Request receipts could not be loaded." A client holding a page asks `history?after=<asOf>` for what
  changed. Answer it from what the page was built from, never the ledger alone: a
  provider transcript can hold a message the ledger never recorded. When the owner
  cannot answer truthfully it returns `reset`, never a partial delta. See the shared
  wire contract.

- A capture that answers a thread's question is placed there with `sessions thread`
  (`--detach` undoes it, and `unthread` is his own split control): an additive
  `thread_link` event, never a rewrite of the retained capture. Any agent may place any
  accepted Inbox message, and run every `sessions topics` and areas command against the Inbox,
  credited to itself; `sessions note` saves any retained message (capture, thread reply, post,
  routed message, agent answer) as a Timeline note [decision: agents-are-never-handcuffed].
  The message then carries `replyToMessage` and `routedBy`. See the native Inbox contract.

- An agent answers a thread on purpose with `sessions post --thread`, a `post`
  ledger event in the Inbox; a post from another session is credited to it (`postedBySession`). Tejas rejected threads that collect whatever the agent said while it
  worked. Another agent's open work does not block the Inbox router from posting its own answer.
  The owner resolves the thread root; a post starts no turn and owes no reply.
  Only ledger-backed history accepts posts, because a provider transcript never contains
  them. See the native Inbox contract.

- Session views and message metadata expose exact retained turn timing (start/end, provider acknowledgement and reported work duration). Missing historical duration stays unknown. Claude print-mode tool results retain error status and provider timestamps for the same operation display as Codex.

- A selected-message reply is an immutable human input carrying `replyToMessage:{kind:"message",sessionId,messageId,source?}`. Its session ID must equal the addressed canonical session; imported-source targets retain their source/version/event pin. It is presentation/provenance for the provider envelope, not an agent/service reply or a substitute for the existing `replyTo` request-return field.

- Session outcome is durable working-set state: `done` means done for now and reopens to
  `open` only when the owner binds a new human or agent input to queued execution or live
  steering. Retained-but-held inputs, service returns and incidental controls do not
  reopen it. `shipped` remains distinct and is never reopened automatically. Active
  working-set clients filter conversations by `outcome=open`; execution is independent.

- Thinkering's workspace records and published proposals stay untouched by convergence.
  Do not import discarded extraction bookkeeping, replay old jobs or reapply workspace
  effects. Retired development controls stay retired; independent browser/phone code-only
  rollback must remain available without an agent session and must preserve notes.

- **A value more than one place needs has exactly one home, and something refuses the
  second copy.** This is DRY as Hunt and Thomas stated it — "every piece of knowledge must
  have a single, unambiguous, authoritative representation within a system" — which is about
  knowledge, not about text that looks alike. Models live in `aliases.ts`: id, provider and
  the name Tejas reads, with everything else deriving from it, and `/sessions/v1/models`
  publishing it so no client keeps a list. Enforce in this order, strongest first: derive it
  so a gap cannot compile (`MODEL_LABELS` is keyed by the literal union of the model tables,
  so an unnamed model is a build error); publish it so a consumer reads instead of copying;
  refuse a second copy with a check. **A derived guard is only real once you have watched it
  fail** — the first version of that union went through `PROVIDER_ALIASES`, whose `model` is
  typed `string`, so it widened to `string`, accepted anything, and passed a deliberately
  broken build. A client that cannot reach the published list says so and offers the
  default; a remembered fallback list is the second copy in disguise. Source: 2026-09-23,
  when Concierge moved to Opus 5.5 and thnkr.ing's picker kept offering Opus 5 — "we need to
  make this architecturally impossible". The inventory of every other duplicated value, what
  was fixed and what is still open, is in
  [one source of truth](https://github.com/tejasdc/thinkering/blob/main/docs/plans/2026-09-23-one-source-of-truth.md).
- **A request closes only through a command, never through prose.** Agents are taught only the
  commands, once, in `REQUEST_PROTOCOL` (`bot/src/request-protocol.ts`), in the per-run
  instructions and `sessions --help`; the rules are enforced where they apply, not repeated. One
  Stop hook for every agent (`bot/scripts/owed-reply-stop-hook.ts`) sends it back once when it
  tries to end a turn owing a reply: Claude gets it with `--settings` on every run, Codex as a
  managed hook from `/etc/codex/requirements.toml` (`scripts/install-codex-stop-hook.sh`, run by
  remote-box's deploy on the box and by `install-mac.sh` from a terminal on the Mac), because Codex
  runs unreviewed hooks only from managed policy. There is no reminder turn and no weaker path for
  either provider; a request still stranded after the hook is reported stalled. Never put standing instructions into each input: the Inbox's 3,802-character preamble
  was prefixed to every input (1,019 copies, ~3.9 million characters, in one conversation) and now live in its per-run
  instructions; an input carries only its identity header and its own facts. The mechanism, its grounding (FIPA Request,
  transactional outbox), the enforcement table and the measurements are in
  [the request reply protocol](../plans/2026-09-23-request-reply-protocol.md). For engineers
  here: nothing in the owner may settle a request from a turn's text or silence (only ChatGPT
  and consultation-only turns, which have no reply command, answer with their turn);
  `request-liveness.ts` owns the stranded check and the stalled notice, and
  the recipient's machine runs them; an old inferred final (`isInferredFinal`) is superseded by
  a later explicit one (`superseded_by_event_id`); peer replies count as forwarded only when the
  origin confirms that exact event, and a pulled reply with files is fetched whole. Incident:
  September 23, 2026, 72 guessed closures in a week and a discarded Mac answer; Tejas: "Why
  can't the agent say this is his final reply? … Do you know about functions and determinism?"

- **Every answer reaches its asker the moment it arrives; nothing is held to batch answers** (Tejas, 2026-10-08:
  "Please update as soon as one agent you get there. What if one agent is like doing some minor work and an another
  agent is doing two hours of work?" [decision: answers-delivered-when-they-arrive]). A stall or overdue notice is checked
  against the request at delivery and dropped when the request is already answered, and an answer withdraws a notice
  about it not yet taken up. A worker waiting on its own returning sub-request or a watch named in that request's partial reply is not stalled
  (`waitingOnDependency`). Every ask and final reply carries a one-line `--summary` shown first; `--answer-view
  summary` lets the asker see only it. See [exchange kinds](../plans/2026-10-08-exchange-kinds.md).

- **One agent event occupies one thread row.** Progress from one agent run with the same words,
  files and answer status reuses the first post across requests in a topic. A stopped
  turn has one service post across those requests; timer events stay in the request ledger and
  agent return path without posting in Tejas's thread. Each request keeps its own event,
  reminder, answer obligation and final disposition. A bodyless final still closes against that
  request's prompt-answer event, even when another request carried the visible post. Distinct
  closing facts remain append-only and appear beneath that shared post. Mac replies
  carry their source run through the same posting rule. The November 4 duplicate posts in the
  think-aloud thread are retired by append-only collapse events; raw replies remain evidence.

- **A release wait has a wake condition.** The agent registers a renewing file watch on the
  product's current-release link, then names its watch ID with `sessions reply --partial
  --waiting-on-watch`. The reply command checks that the watch belongs to that agent and is
  active. The Stop hook uses the same request-specific wake check as stranded-request recovery:
  it lets a turn end while that request has an active watch-backed partial, but still demands a
  reply for other requests without a wake. A renewing watch keeps that binding across watch IDs
  in its series, provided the active watch still belongs to the worker. An existing renewing
  watch can serve a later request too: the partial reply binds that request to the watch.
  The stranded check requires that exact request-to-watch
  binding, so an unrelated watch cannot conceal a silent stop. While the watch is active,
  the check sees a live dependency; when the link points to another release, it sends one service input to the
  agent so it can check the installed revision and close or continue the request. The file watcher
  follows the link for file or directory changes and, for new watches, also records the exact
  symlink target. An atomic link swap is observed even if the old and new release directories
  happen to have the same metadata; older active watches retain their original comparison.
  A peer agent uses the same local watch on its own machine. An outside request uses the same
  recipient-session watch check, records the watch in its partial reply, and is exempt from its
  Stop hook while that exact request has an active wait. Its renewing series ends after the
  outside request closes. An open request with no actual wake condition still receives the stalled
  notice after its report-back attempt; waiting prose alone does not hide a silent stop.
  A child request placed in a named thread counts as a wake only with an explicit return to
  the requester; thread-only delivery cannot keep the worker's other work open silently.
