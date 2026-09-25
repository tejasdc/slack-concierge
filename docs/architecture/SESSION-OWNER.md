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

Native audio attachments are retained in ordinary common-owner custody. Before a Codex or Claude native initial input or steer reaches its provider, the execution host stages those exact bytes and uses the existing local Whisper transcription boundary that prepares Slack audio. The provider receives both the original staged audio path and its labeled transcription; a transcription failure fails preparation visibly instead of silently dropping spoken input.

Common history and live message events restore readable accepted input at their read boundary. `session-history-projection.ts` matches a user message's native ID, native turn and exact observed content to a retained provider event, then to exactly one native input's prepared replay or final admission prompt hash in the same owned turn. The admission hash includes any interrupted-history prefix added after replay preparation. It does not parse envelope JSON for identity. A proven match exposes the immutable accepted text, attachment custody descriptors and accepted input ID as `submissionId`, so the surface resolves the correct human/agent/service receipt even during mixed-origin steering. Native message IDs, fork boundaries, tool details, cursors and raw provider events remain unchanged. Exact-source context reads still use raw native evidence and its original hashes. Quoted envelopes, unmatched messages and unbound archive history stay literal evidence; absent proof never invents attribution. Provider preparation, attachment paths and selected-context scaffolding remain in retained execution evidence rather than the conversation display.

## One execution owner

Provider availability uses the shared [usage reset cache](PROVIDER-USAGE.md) inside the
existing adapters. Its explicit clear and timestamp expiry affect future attempts only;
neither owns replay, queue promotion, Stop or recovery.

`SessionExecutionHost` dispatches native inputs through the same `SessionTurnQueueCoordinator`, durable claims, `ActiveTurnDispatchRegistry`, `executeAgentTurn` and provider adapters as Slack. Explicit human queue/steer controls validate the observed run; agent requests leave that choice to the coordinator. Native fork controls serialize in their parent's existing FIFO, preserve the parent binding and create the child only from exact native evidence. There is no provider writer in the Thinkering consumer.

Terminal observations may arrive before asynchronous executor cleanup releases the live registry. Both runtime compositions pass the registry's still-active sessions into the existing atomic queue claim; ordinary Slack admission defers through the same FIFO at that boundary. Registry settlement wakes promotion after releasing its owner. Native setup failures use the exact owned dispatch attempt: before admission or unsafe effects they fail the turn and release the cached session state together; after admission intent they retain ambiguity through the existing parked-turn path. Late failures cannot rewrite a settled result or another attempt, and no setup failure replays an input.

The existing recovery owner distinguishes unattempted input, a known-dead ambiguous attempt, and a saved result. Only proven unattempted work can resume without new effect evidence. Saved results return without another provider call. Ambiguous effects remain inspectable. A deliberate Stop cannot become an automatic retry. Unconfirmed interrupted model input can be supplied as labeled historical context to a later authorized input; it is not permission to repeat prior actions. Native fork controls are excluded from that model history.

Known terminal state stays monotonic. A native result and its notification are distinct from any correlated answer. The shared Codex app-server observer is composed in both Slack-enabled and Slack-disabled owner runtimes and subscribes to each uniquely bound active native session, independent of whether that session still has an eligible Slack projection. Each successful attach or reconnect records a history invalidation so an already-open surface reads retained items that predate the subscription. Future completed user, assistant and tool items enter the common owner observation stream with their exact provider message and turn IDs; Slack mirroring remains a separate projection of its narrower eligible subset. On-demand history/detail reads use the same native item shapes. Cursor replay rebuilds a view, never submits another run. Archive, pause, outcome, read and attention retain separate meaning.

Session outcome is working-set state, not execution history. `done` means done for now:
the owner changes it back to `open` when a human- or agent-origin input is durably bound
to a queued turn or attached to a live turn as steering. Inputs merely retained while a
session is archived, paused or otherwise unable to admit execution do not reopen it, nor
do service returns or control/observation activity. `shipped` is a distinct work verdict
and no new input changes it automatically. Consumers use `outcome=open` for the active
working set and use execution independently for Running or other lifecycle views.

Native results and actionable setup errors, provider refusals, parked uncertainty and interrupted/delivery-parked recovery advance attention once per accepted input/dispatch attempt. The existing event ledger retains the attention marker atomically with the generation increment; successful result retention and failure projection share that marker. A retained pre-turn unavailable creation uses its accepted input with attempt zero. This updates neither outcome nor read/dismiss generations, and a stale read or dismiss cannot hide a later failure. Prior result events already prove their attention increment, so compatibility projection does not count them again.

The existing session projection subscribes to native terminal facts as well as Slack facts. Installation performs one catch-up query over retained accepted inputs and their turn rows, recording only actionable native failures without an attention marker. Its cost scales with retained accepted inputs; each selected row receives one event/metadata transaction and ceases to qualify. There is no idle work, timer, provider admission or repair queue. This catches the observed already-retained ChatGPT failure and owner-death recovery without changing input bytes, execution state, provider identity or replay eligibility. Reinstallation and repeated recovery preserve read/dismiss decisions.

A confirmed nonretryable native provider refusal settles as a failed input and releases its session. It is not an uncertain send or an invitation to retry. The existing Slack remediation flow and genuinely ambiguous native effects retain their previous parking behavior.

## Externally submitted Codex turns

The shared Codex observer subscribes each uniquely bound provider thread and retains
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

`session-communication.ts` retains the existing request/event ledger. Request acceptance atomically retains the immutable target, source, content, due time, prerequisites, mandatory return obligation and native target input before dispatch. A reply names exactly one request. Partial answers may precede its final; ending a turn with other outstanding questions returns an unconfirmed-answer disposition with retained output references.

Request prerequisites wait outside session FIFO, so the reply needed to unblock a continuation can enter the requesting session. Native return events use the same accepted-input and queue machinery. A return may steer only into its exact original asking run while that run remains live. Otherwise it enters FIFO, including when another return or human input is running in that session; idle requesters resume through the same queue.

A busy recipient is never a refusal, for any provider or sender. The coordinator chooses live delivery for agent requests and service returns, so a live input that provider evidence proves was never received — a `failed` steering row with no `provider_sent_at` — returns once to that session's own queue through `recoverUnsentSteeredInput`, keeping its input, request and event identity. It then runs as an ordinary turn when the session next accepts work, and the sender sees a queued receipt rather than a failure. The failed steering row remains evidence and the new queue placement has its own observation identity. Four cases stay terminal instead: an acknowledged or ambiguous send, which is never re-enqueued; a deliberate human `delivery:"steer"`, which names one exact run and refuses by contract; a retained Slack-provenance steering message, which belongs to the deprecated surface; and an archived or suspended session, which cannot accept the input at all. `capabilities.send` is therefore independent of execution state: it reports whether this session can receive input, not whether it is idle right now.

ChatGPT and consultation-only recipients cannot invoke reply tools. Their incoming requests queue as separate inputs. The service correlates a final result only for the exact acknowledged request input, one question, no intervening steering and a completed native execution. Otherwise it returns the unconfirmed-answer disposition and output references. Consultation-only targets reject requests for work before acceptance.

An agent's addressed ask can select a historical `consult:true`, `send:false` source. The owner verifies its retained version, branch, boundary and dialogue hashes using the same evidence preparation as human consultation. It atomically creates a distinct restricted child, its agent-origin consultation input, the requester operation and mandatory correlated return. Supplied evidence must belong to that exact dialogue; work and attachments are refused. Source/action duplicates keep the same child and request identity. The source run and binding are revalidated after asynchronous evidence retrieval, before provider dispatch. The child uses the existing informational policy/FIFO, and the service returns its exact acknowledged result. Agents never enter the human consultation route or acquire human origin.

Refreshing an imported source to a different retained version advances its address binding generation while preserving its canonical session ID. Search returns the current view after that refresh; an old address cannot silently contact newer history.

Explicit provider intent is interpreted by the admitted agent's instructions. `sessions ask --provider <alias>` uses the same source-bound owner as an addressed ask. Atomic acceptance creates a native session, its agent-origin first input, attachment custody, request operation and mandatory return. Codex/Claude creation requires an exact canonical project folder with a real `AGENTS.md`: a workspace child with its own Git root, or a writing workspace directly inside an Obsidian vault (a workspace child or grandchild holding `.obsidian`), which Obsidian Sync keeps as one copy without Git; the owner resolves its cwd independently of historical Slack channel rows and pins the existing alias table's model and selected reasoning effort before dispatch. The retired `D0BMWUJ3RD5` DM folder is excluded. ChatGPT uses `--provider chatgpt` without project/effort. The HTTP spelling is `targetProvider` instead of `targetAddress` on `POST /sessions/v1/requests`, with optional `effort`, `project`, `files` and `captureId`. An exact native input/run or accepted Slack input supplies provenance; text cannot grant human origin, restricted consultation cannot escape policy, and ChatGPT cannot create outbound requests. Source/action retries retain the original target even when unavailable.

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

One due time and one timer inspect unresolved work after 30 minutes. It records health and a durable notice; it does not infer success, override Stop or replay an ambiguous effect. Work still running under a live owner is not unresolved work: its due time moves to the next interval and nothing is reported, because a healthy investigation presented as a stall is what makes the whole signal untrustworthy. When a stall is real, the requests one recipient turn is holding report one notice between them, since they are one piece of work. No pending deadline means no timer. An empty queue scan emits no execution-change wake. There is no autonomous conversation quota, periodic repair scan or second scheduler. The [routed request architecture](ROUTED-REQUESTS.md) retains Slack publication and fixed `work/--after` semantics.

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
pause/archive still hold admission and return delivery. A sibling's reply can also settle a
request: one recipient turn
routinely carries several of a requester's questions, and when every input it received is
such a request, an explicit final reply to any of them answers the rest. Requiring a reply
to name each request ID made one turn that answered three questions confirm only the one
the reply happened to name, which is a worse failure than no protocol at all, because
every consumer above it then has to hedge finished work. The reply is what settles the
siblings, never for a request that sent its own partial. The recipient session is one
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

An authenticated host/surface may request one ChatGPT inventory pass through `POST /sessions/v1/sources/refresh`. The owner invokes the configured capability's existing refresh instance; it never starts a new scheduler, retries a rate limit or sends a model input. Startup restores retained bytes without a browser refresh. Search retains the actual saved/pending coverage.

Mac consultation creates a distinct common-catalogue child from a pinned cited dialogue packet. Initial and subsequent execution, retry and recovery enforce the same information-only policy: no tools, filesystem changes, network or outbound session messaging. A native fork that cannot retain that policy is unavailable. The service supplies correlated results without exposing outbound model tools to that child. Native continuity and reconstructed evidence remain different fidelity claims.

Codex reads effective configuration for every consultation thread start/resume, including recovery, and disables each configured MCP server through one structured `mcp_servers` override. Nested server names remain literal, including dots and quotes; Codex's dotted override paths do not interpret quoted segments. Native table merging preserves each server's existing transport while setting `enabled: false`. No host profile or daemon configuration is rewritten. The remaining tool, filesystem, network and outbound-action restrictions still apply, and the provider must confirm the restricted permission profile before turn admission. The parser contract is pinned to [Codex 0.153.4 overrides](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/config/src/overrides.rs) and [table merging](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/config/src/merge.rs).

ChatGPT uses its original account/conversation/browser binding. Explicit human bind retains a control intent before independent source/account/anchor verification. The capability adapter independently reads the exact owner operation and current binding before any browser send. Prepared bytes/model/attachment hashes are pinned at provider admission. Existing-effect observation and reconciliation never resend. Failed start, unavailable browser and uncertain send remain visible ChatGPT outcomes; another provider is never silently substituted. Inventory and snapshots grant no execution. There is no ChatGPT MCP endpoint or outbound model session tooling.

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

The owner answers every read from one event loop, so a slow synchronous read delays all the others. Each owner request slower than 250 ms logs `owner_request_slow` (route with query names only, duration, status, bytes), and a 250 ms tick that fires 200 ms or more late logs `owner_event_loop_lag` with the requests in flight. A receipt that has settled for good is computed once and reused, the same invariant `changedAfter` relies on. On 2026-09-22 a full Inbox receipt read (2,124 receipts, 9.5 MB) took 2.8 s and held every read behind it while his phone opened from a notification.

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
