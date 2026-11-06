# Native Inbox

## Waiting captures

During an explicitly opted-in Focus lease, ordinary human captures and addressed Capture bar replies are accepted
without entering this executable waiting queue. They appear in the separate held review
page and enter the queue or their retained exact reply target only on a user-selected
release. See [Focus capture review](../architecture/PAUSE-ALL.md#focus-capture-review).

The owner exposes a bounded, ordered page of human Inbox inputs and attributed outside-agent
captures that are still queued and have never reached a provider. A new executable capture
joins the Inbox router's running turn by default; it appears in this waiting page when no
run can accept it. Its bytes, accepted input and live-delivery intent commit together, and
duplicate or restart recovery dispatches that exact input only if no turn or steering effect
already took it. Thinkering's Inbox uses the waiting page
to show what is waiting, marking outside-agent authorship explicitly.
`Move next` raises one queued input's priority within this Inbox session; the owner claim and
the older-turn blocker use that same priority, then original turn order. It changes neither
the input nor the turn identity. An already admitted or ambiguously delivered input cannot
move.

`Work with current run` names the exact acknowledged Inbox run and up to twenty selected
waiting inputs. The owner attaches each original input as its own steering message, preserving
capture bytes, authorship, thread and receipt. If that run has ended, the owner refuses the
action and the captures remain queued. If the run stops accepting partway through, those it
did not take remain queued; accepted and ambiguous messages are never replayed. Stop still
addresses one exact run. Replacement is a new human input plus withdrawal of the old queued
one, never a rewrite of retained words.

Queue controls are idempotent human actions. The read is a bounded page over the canonical
ledger, and the action emits owner events so the Inbox refreshes without a second queue or
copy of capture state. Priority is local to the Inbox session: it does not displace work in
other sessions.

Concierge owns the active canonical Inbox session, accepted inputs, attachment bytes
and request obligations. Thinkering opens it with its existing conversation surface.
The existing capture ingress and owner delivery remain the producer boundary. A provider/cwd
cutover creates a new active session; earlier Inbox sessions and their source and
request evidence remain in the catalogue and visible Inbox history.

## Answering a thread

When the Inbox asks another session to work on a named thread, the owner posts that session's
answers, final result, failure and cancellation into the thread under the answer's exact event
identity. The request's status remains readable with `sessions get`; the Inbox router does not
receive a second runnable copy for ordinary replies. An ask that truly needs its result to continue routing says
`--return-to-requester`; a final hand-back always gives the asking agent an actionable copy while its answer stays in the thread once. A 15-minute unresolved-request reminder goes to the asking agent with
the exact request summary or words, not into Tejas's thread. A provider hold that only the
asking agent can follow up on uses the same destination. A stopped run at Tejas's request stays a quiet service note; other terminal
failures create a reading item in that thread. New reply and notice posts commit beside the
request event in owner receipt order; they do not wait for a router turn. A delayed peer reply
is ordered when the owner receives it, rather than pretending it arrived while the peer was offline.
Pending copies from the former protocol are refused by both live dispatch and queue admission,
then withdrawn only if no provider admission or steering could have occurred. Already consumed
conversation history remains intact. Explicit grouped replies carry only the requests that opted
into a return; separate requests with similar words are never collapsed.

Tejas asked that answering a thread be an action the Inbox agent takes, not something
the app scrapes from whatever the agent said while it worked. His reply into a thread is
a human input carrying `replyToMessage`, which wakes the agent; the agent answers with
`router-actions.sh sessions post --thread <message-id>`. The owner records a `post`
ledger event, and the Inbox page and its `history?after=` delta both include it, since
they share one query. It appears as an assistant message with `author.communication:
"post"`, the `replyToMessage` it answers, and the thread's root `inputId`.

### Direct messages to the Inbox router

A human-surface message addressed to the Inbox router joins its running turn through the
same provider controller used for agent requests and service notices. The owner applies
this rule even when an older composer supplies `delivery:"queue"`. The Inbox composer
does not offer Queue: it is the control conversation for ongoing work. Thread replies
addressed to a worker still go to that worker. Captures join the running router when it
can take them, and otherwise use ordered intake with Move next and Work with current run.
Explicit Queue in ordinary sessions still means
finish the current turn before starting this separate instruction. Saved work keeps its
chosen time. Those guarantees are why queue delivery remains available.

Admission retains `admissionIntent:"live"` atomically with the exact message before trying
the provider. No active accepting run means this same input enters the normal queue. A
provably unsent refusal recovers that input; acknowledged or ambiguous sends never replay.
Every later live input first brings in earlier, unreceived unselected messages in
accepted order, including captures and messages older browsers or outside-agent routes
marked Queue as a default. Deliberate Queue, saved work, dependencies and any prior
provider admission stay where they were. This prevents a later message from passing
an earlier one during a run-start race.

Queue admission followed by steering retains both `accepted` events for the same input.
Only the earliest accepted event places that input in Inbox message history; the later
event records delivery, not another message. Prepared and live readers share the indexed
`firstInboxAcceptanceSql` predicate. On October 14, promoting two older queued messages
exposed the missing rule: the prepared message uniqueness constraint refused their second
admission events and prevented receipt status from advancing. The reader correction resumes
the existing checkpoint without deleting history, moving messages, or replaying delivery.

An ordinary accepted executable message and its local queued turn commit together. A forwarded
thread reply, its local agent request, and its topic obligation also commit together; the request attempts live
delivery into a busy recipient and queues only when no live run can take it. A marked
agent test reply uses the same entrance with agent authorship. Forwarding to another
machine retains the exact chosen destination as an intent before the network call;
retry and startup recovery reuse the original input and peer request identity. A lost
peer answer leaves delivery explicitly unconfirmed until that identity is reconciled.
The peer's retained request and the source topic obligation commit together before network
delivery. An unanswered older forwarded reply without a topic obligation is admitted by
upkeep; an older checked completion is not replayed as new work.
For a forwarded reply, the peer recipient retains the exact input with the delivery
record, then attempts live delivery. A refusal before provider admission recovers that
same input on retry or reconciliation and creates at most one queued turn.
The private `accepted-input-admission-fixture.ts` exercises rollback for local forwarding,
retained peer intent and exact-input recovery after turn insertion refusal,
same-action duplicate and changed-payload refusal. Recovery acts only on explicit
queue, live-delivery or forwarding intents with no turn, steering or request custody. A marked
agent test reply may retain source-run custody: its live-delivery or peer forwarding intent advances
only when those source fields exactly match its retained agent source. Other agent
inputs cannot enter this recovery path. Ordinary human input has no source-run custody;
an exact duplicate of an older unbound message without that proof gets an explicit
unconfirmed receipt and remains held for exact investigation.
It does not exercise peer delivery or prove an installed recovery.

A post carries files: repeated `--file <path>` for its own bytes and `--attachment
<custodyId>` to place a file already in custody — a worker's returned mockups — without
downloading and re-uploading them. The owner retains every file before it accepts the post,
under an action identity derived from the source input, action ID and position, so a retry
reuses that custody while different bytes conflict; an unknown custody ID is refused. The
`post` event payload and the retained action carry the ordered custody IDs, and the history
page and its `history?after=` delta expose `attachments:[{id,name,contentType}]` on that
message. A result row exposes attachments when its own retained result payload names them.
A post with at least one file needs no text; one with neither text nor a file is refused.

A turn that produced no text of its own is not a message here. After a `sessions outcome`
action, a turn may end without closing text; an older turn may answer only with its outcome
marker. Either way, that result carries neither text
nor files: the shared Inbox query leaves it out, so the thread shows no reply rather than a
sentence nobody wrote. A result that carries files is still a message. Tejas read one such
placeholder as speech from Claude on 2026-09-22 ("(agent completed without a text reply)");
the owner no longer produces one, and no surface substitutes wording of its own.

The owner resolves that root from `--thread` by the page's own id rules: a request or
capture is its own root, and a result or earlier post carries its root forward, so an
answer anywhere in a thread stays in it. A thread message that is not in this Inbox is
refused. A post starts no provider turn and creates no request or return obligation, so
it cannot start a loop. It is idempotent by source and action ID and refused after Stop.
A post does not raise attention; a turn's declared `needs_you` outcome does, on the
request thread it answers (see the shared wire contract).

A capture of his that answers a question the Inbox asked belongs in that thread, not in a
new request row (Tejas, 2026-09-20: one cut-off recording plus two spoken answers made
three rows). `sessions thread <inputId> --thread <message-id>` records that placement, and
`--detach` undoes it; the retained capture keeps its own bytes and the latest record wins.
Only the Inbox threads its own accepted human inputs, never its agent messages, and a
capture cannot continue its own thread. The placed message carries `replyToMessage` plus
`routedBy` (the deciding session, input and run), so a client can show that it was routed
and offer to split it out; his own thread replies carry their link without `routedBy`. His
split control is the `unthread` message action on the same surface, recorded as a human
detach. The Inbox agent decides placement, only for a thread where it asked and is still
waiting; everything else stays a new row.

A bug report (a capture from the bug button or its shortcut, marked by the Thinkering
bug-report door) is always a thread of its own [decision: inbox-button-always-new-request].
The owner refuses, with `BUG_REPORT_OWN_THREAD`, an agent's `sessions thread` of a bug
report, `topics place` of one into a topic that holds any other root, `topics create` with
it beside other roots, `topics route` of it into another thread, and `topics merge` of a
topic that holds one. The router gives it its own topic (`topics create --root <it> --from
<related topic>` links the related thread) and sends the work to the owning agent with
`sessions ask --route-message`. The placement prompt and the Stop hook's filing commands
offer only that. Other captures may still join a bug report's thread, and Tejas's own moves
are not restricted. Before this (Nov 5, 2026) the router placed his bug report about a
worker's answer into that worker's thread, and its instructions were the only guard.

Every Inbox message resolves to one thread root, and attention needs are keyed by it: a
capture or request is its own root; a routed capture follows its link; his reply follows
the message it replies to; and a returned answer follows the request it settles, through
the input that request was sent from. A return is never a thread of its own: filing a
question asked in a turn a return started under that return left questions he had already
answered open (2026-09-21, repaired once by bot/scripts/repair-inbox-needs.ts).

Only the Inbox accepts posts, because only its history is built from the ledger. Every
other session shows its provider transcript, which a post never enters. There a post
would be accepted and then never seen, and it would sit inside the window a history delta
fingerprints, so it is refused until a transcript merge is designed.

`GET /sessions/v1/inbox` ensures the active Claude Opus 1M session exists in
`/root/workspace/slack-inbox` and returns `{session: SessionView}`. It creates no
provider turn. `GET /sessions/v1/inbox/:captureId` returns `{item}` from retained
custody. The prior Codex Inbox session remains intact and can finish exact existing
obligations; only newly accepted captures use the new session.

Trusted local producer `POST /sessions/v1/inbox` accepts:

```json
{
  "source": {
    "kind": "monologue",
    "id": "exact-producer-note-id",
    "recordedAt": "2026-09-15T21:00:00.000Z",
    "title": "Optional title",
    "metadata": {}
  },
  "text": "Complete original transcript or report",
  "files": [{"name": "image.png", "contentType": "image/png", "base64": "..."}],
  "importOnly": false
}
```

Kinds include `pebble`, `thinkering`, `monologue`, `alexa`, `voice-memo`, `outside-agent`, `agent-report` and `reader`, one closed list in
`bot/src/inbox-producer-sources.ts` that validation, capture state and attribution all read.
Source IDs remain exact producer identities: the public capture worker uses its immutable event
ID; Monologue uses note_id; Voice Memos uses the Mac transcription job ID prefixed with
`voice-memo:`; Alexa (remote-box's private skill service, which verifies Amazon's
request signature) uses the Alexa request ID, so a retried request stays one capture and is shown
as his, through the door "Alexa"; Voice Memos is shown as his through "Voice Memos"; an outside agent uses the ID minted by the installed helper. An `outside-agent`
source requires `metadata.outsideAgent` matching the outside-agent name contract, and every
other kind refuses that field, including `monologue`. An outside-agent source cannot cite a
Concierge run or request `importOnly`; it always queues the Inbox router. The endpoint uses the existing private `requests.sock` and root filesystem
authentication. It is not a browser/model author-selection route. Public capture
keeps its existing credential and acceptance queue; no new credential or queue exists.

The response is `{inbox:{sessionId,address},item,operation}`. Item contains
`captureId,inputId,sessionId,source,text,attachments`; attachments contain
`id,name,contentType,sha256`. Operation is the common Receipt with an additional
`id` equal to `operationId` and item.inputId. The producer must retain this exact
receipt. Capture ID is SHA256 of JSON `[source.kind,source.id]`. Retried exact source
and bytes return the original input; a changed snapshot conflicts. Original metadata
and timestamps belong to the snapshot and must remain stable on retry.

First access or acceptance creates the active Inbox if absent, using Claude Code
`opus[1m]` and the `slack-inbox` project cwd. This is the explicit router model
exception; ordinary destination work still uses fresh Sol at medium effort unless
Tejas chooses otherwise. Acceptance retains an attributed input and files and queues it
atomically through the existing execution owner. Native human ingress retains human
provenance; outside-agent ingress retains its named agent provenance. No Slack message is manufactured. Stopped/archived session policy
remains owned by normal session controls. Later human session controls remain
available.

`importOnly:true` retains the source in native history with a completed import
receipt and no provider turn. A duplicate cannot change its first disposition or
execute it. Later assignment is a separate explicit human input. Historical Slack
deliveries, previous assignments and uncertain work are not replayed during import.

Human correction `1789510460.238219` requires the retained report backlog to use ordinary
intake (`importOnly:false`) and invoke the Inbox agent, like new Monologue captures.
Preserve each original source ID, bytes, attachments and prior-assignment metadata so
the Inbox can reconcile earlier work rather than starting every investigation again.

Thinkering bug-report text is recognized from its report format. The readable part
before Complete diagnostics JSON appears in the conversation. The exact full report
is retained as `thinkering-bug-report.txt`, alongside original images. New intake and
imports share this conversion; the original digest binds all bytes. History pages
do not contain base64 file bodies or eagerly render diagnostic JSON. The Inbox reads
accepted dialogue through existing owner event sequence, including import-only inputs
that intentionally never entered a provider transcript.

Inbox history includes accepted capture and result events from all retained Inbox
sessions without rewriting their identities. It follows the common native paging contract: a null cursor returns the
newest readable page in chronological order, and its opaque continuation walks to
older readable events. Only accepted non-capture inputs, Inbox captures and retained
terminal results consume page capacity; live provider message/tool observations do
not displace durable dialogue. The existing numeric event-sequence cursor remains the
stable page boundary across this ordering correction; continuation uses a strict older
predicate so it cannot repeat the boundary or loop.

The full Inbox session transcript requests `activity=true` on the same bounded history
page and delta routes. That view includes retained provider tool steps, including command
launches and results, in their event order with exact message IDs and agent attribution.
Its cursor is bound to the activity view, so a compact-history cursor requires a fresh
head page instead of silently skipping earlier tools. The default history remains compact
for ordinary Inbox thread reading; the activity view does not copy the whole run into
each thread. A background command appears through its retained launch and result tool
messages, while the existing background-wait state reports that it is still running.

The Inbox agent interprets explicit verbs and ordinary clear requests. Ambiguity
asks Tejas; ideas or quoted proposals do not authorize implementation. Work routes
through common sessions search/context/ask, with exact source, model, project and
attachments. It must preserve scoped user exceptions rather than applying them to
unrelated pipeline work.

`sessions note <captureId> <source flags> --action-id A --summary-file F` validates the live
source/run, resolves original capture bytes, retains intent, then calls `POST /captures/note` on
the existing Thinkering capability socket with `{captureId,text,title,capturedAt,summary}`.
`summary` is the agent's Markdown outline (a title line, then `- ` bullets, without the spoken
command) and becomes the note; the original bytes become its Source, which the agent cannot
supply or change. A note he already edited keeps his words (`summary:"kept-edited-note"`).
The summary is required (Tejas, 2026-10-01: "you should not dump my whole transcript here").
`--add-to <earlier captureId>` makes a follow-up capture a new section of the note that earlier
capture already has, keeping the follow-up as that section's Source, so a thread's follow-ups land
in the one note he reads on his Timeline (`addTo` on `/captures/note`).
`--person <name>` instead files the capture under that person's one note (`person` on
`/captures/note`): thnkr.ing makes the note the first time anyone names the person, keyed by the
name, and adds each capture as a section with the capture as its Source. A capture naming several
people is filed once per person, each with its own action ID and a summary of only what concerns
that person (Tejas, 2026-10-07: "start a thread for each person and keep adding to a central note").
The response is `{source:{objectId,revision},note:{objectId,revision},created}`.
The capability owns idempotent creation by capture ID and preserves edited notes on
retry. The owner retains confirmed note receipts; uncertain responses remain explicit.
Agents cannot replace source text through this command. No old transform runner is used.

Delivery follows the existing Git deployment channels. Current human policy forbids
agent-run tests, sandbox probes and review cycles for this pipeline. Runtime product
acceptance belongs to Tejas. Prior failed evidence remains unchanged.

## Topics

There is one Inbox. Every session ever marked as the Inbox is part of its one dialogue, its
threads and its topics; the session holding the `inbox` standing role is the current router.
A provider handoff and `sessions agents bind inbox` both move that role
([router actions](../runbooks/ROUTER-ACTIONS.md#standing-agents)). Before 2026-11-06 a bind
moved only the label: captures, thread-named requests and thread lookups followed the newest
Inbox-marked session and accepted-handoff chains, so an overnight stand-in received nothing
and could name no thread.

A topic is the Inbox's recognizable conversation: a stable `topic:<uuid>` owning a set of
thread roots (each root belongs to at most one topic; the latest placement wins), a title
with its previous titles as aliases, a one-line summary of the most useful current fact, a
lifecycle (open/closed, plus set aside), the human requests inside it, the questions
waiting on Tejas, what he has actually been shown, and what the router says it is working
on. Threading itself is unchanged: topics are resolved from the same thread roots as
`sessions post` and attention needs, so `unthread` takes a capture back out of its topic.

Owner events are the truth and the tables are their projection. Every change records
exactly one event — kind `topic`, `topic_request`, `topic_question`, `topic_answer`,
`topic_reading` or `topic_focus` — carrying `topicId`, `change`, the full record of
everything it changed, `by:{kind:'agent'|'human'|'owner',sessionId?,inputId?,runId?}`,
`reason?` and the topic's `revision` after the change. They never enter `inboxRows`, so
history pages and deltas are unchanged, and they reach clients on the ordinary event
stream (`GET /sessions/v1/events?kind=topic,…`). `rebuildTopicProjections()` replays them
into the tables and is idempotent; `bun run bot/scripts/migrate-inbox-topics.ts --rebuild`
runs it. Payloads carry only the titles, summaries, briefs and cited answer passages the
router wrote — never transcript text, prompts or provider errors.

A human read mark carries the exact conversation event sequence the screen displayed.
The owner validates that single retained entry still belongs to the thread, then advances
the read position monotonically in the same transaction as its receipt. A stale placement
returns a conflict so the screen can refresh. This action does not build a topic summary
or scan other threads while the owner holds its write transaction.
Routing one accepted message to a second thread checks earlier routes through the retained
source-message index before it writes another destination; the query uses the index's
two-kind predicate and then selects topic routes, preserving the independent-route rule.

The owner keeps one in-memory index of every Inbox message and its thread root
(`entryIndex` in `session-topics.ts`), built once per process and extended only over new
rows. After a restart it is filled by `warmEntryIndex` in bounded steps that yield the
owner between them, started once the owner is online in both runtime compositions, and
logged as `inbox_entry_index_warmed`; a read or human action that arrives before the warm
finishes completes only what is left. Before this (2026-10-12) the whole build ran inside
whichever read came first after each restart, which was his first tap on a thread: about
3 s and 157 MB inside that action's own write transaction, with every other read behind
it; see [the incident](../incidents/2026-10-12-thread-index-rebuilt-in-his-first-tap.md).

Reads are measured, not argued: `CONCIERGE_STATE_DIR=<state dir> bun run
bot/scripts/topics-read-timing.ts` times the list, background and question reads against a
state directory (a copy of the live one, or the live one read-only). The first read after a
restart resolves every Inbox message's thread once (about one second on the September 2026
ledger; it was 85 s before events were indexed by input and message lookups stopped using an
either/or condition), and later reads cost tens of milliseconds because the per-read indexes are
built once per read, never once per topic (2026-09-22, the first live Threads screen sat on
"Loading threads…").

Only the Inbox session's admitted live run may change topics. A worker session may call
`topics questions` and `topics read` for a topic that holds one of its linked dispatches,
so it can declare questions against its own work; anything else is 403 `TOPIC_FORBIDDEN`.
Every mutation is retained under scope `communication:<sourceInputId>` with its
`--action-id`, exactly like `post` and `thread`: a duplicate returns the first receipt and
a changed payload conflicts. `--expected-revision N` refuses with 409
`TOPIC_REVISION_STALE` when the topic moved on. His own rename wins: an agent rename after
a human one is refused with 409 `TOPIC_TITLE_HUMAN` unless `--reason` says `human-approved`.

`router-actions.sh sessions topics …` (the command's own `help` prints the full syntax):
`list`, `read`, `resolve`, `questions-read`, `create`, `place`, `rename`, `summary`,
`merge`, `close`, `reopen`, `request add|amend|link|close|reopen`, `questions`,
`question settle`, `answer`, `acknowledge`, `file`, `focus`, `release`. `topics questions` takes
the reconciliation array in `--json-file`; the owner assigns missing `questionId`s, bumps a
question's `revision` whenever its decision, why, known, choices, uncertain, answerable,
blocking, optional or context changed (a new revision is a new unread revision), and
supersedes a replaced question with the replacement's id. A question's identity may be
spelled `questionId` or `id` (the read API's spelling); the two must agree, an unknown one
is refused, and a new declaration whose decision already stands open in the topic is refused
with the existing id (`QUESTION_DUPLICATE`) rather than becoming its twin. **A question is
ready only when it can be answered**: its brief says why it came up (`why.text`) and exactly
what he can answer now (`answerable`); choices are optional, but each present one needs a
label (`option` is accepted for `label`, a bare string for an uncertainty). A declaration
without those is stored as `agent_checking` (`checking` is accepted for it) unless it carries
`onlyHeCan` without an explicit context, which is refused with what is missing; asking for
`ready` without them is refused with what is missing (`QUESTION_NOT_ANSWERABLE`); on a
revision an omitted `context` keeps the current one. `owner` is the documented object or a
bare session id. Every question read carries `readiness` (`ready`|`preparing`) and
`missing`; the app displays those and never recomputes them. `topics answer <inputId>` takes
`{"mappings":[{questionId,revision,passage,interpretation,state}],"unresolved":[…],"acknowledged":[…]}`,
records that answer against the retained human input, settles the mapped questions, marks
the acknowledged items, and clears the legacy `needs` entries whose recovered question is
now settled. It dispatches nothing: continuations still go out with `sessions ask` and are
attached with `topics request link`.

### Agent issue reports

`router-actions.sh report --source-input <id> --source-run <id> --action-id <stable id> --title "<issue>" [--file <path> ...] -- <observation, expected behavior, impact>` sends a likely bug or concerning issue the agent noticed outside its task. The local owner verifies the reporting run. A Mac report crosses the authenticated Concierge peer link to the server Inbox; no Mac Inbox is created. The server gateway marks only authenticated peer traffic, and the owner requires that mark before accepting Mac attribution; a local caller cannot assert it in a request header. The server retains the exact text and files under the agent's authorship, and atomically creates an Inbox thread in Agent reports with one open request before admitting it to the router. The receipt names the capture, thread and request. Repeating the action ID with the same text returns the same receipt; changing the text under that ID is refused. The router dispatches work from the report's capture root and links the dispatch to the existing request. Its stop check refuses an Inbox turn that received a report whose open request still has no linked dispatch; the router must check for a prior unlinked dispatch before sending another, or explicitly resolve the report. A settled answer closes the request under the normal thread upkeep rules; an uncertain end leaves it open for the router to resolve. The report cannot be imported silently or attributed to Tejas. A peer connection loss before a receipt is ambiguous; the caller retries the same action ID, and the owner returns the one retained report if it arrived.

The server Codex turn-exit audit has one narrowly scoped report group for surviving non-browser processes. A repeated sighting while its agent-report request remains open appends the new process evidence to that request and returns the first report's receipt, preserving its original agent attribution and Inbox work item. The group is recorded on the capture, so older ungrouped reports with the same title cannot absorb new evidence. The owner closes the grouped request itself, as completed, once every process recorded on it has exited (rechecked by PID and start time each minute); a sighting whose processes exit within ten minutes of its turn is never reported. Once the request closes, a newly observed survivor can open a fresh report. Ordinary agent reports keep their source-and-action identity above.

**A request names its thread.** `sessions ask` from the Inbox takes `--thread <message-id>`,
the capture, reply or post the work is for. The owner resolves it to its root at admission
and refuses, before anything is sent, an Inbox ask with no thread, one naming a message that
is not in the Inbox, or one whose thread is not yet placed in a topic; other sessions have
no threads and name none. The root is recorded on the request (`thread_root_input_id`, local
and peer rows), so progress and final returns file under that thread and its Timeline lists
the dispatch, whatever input started the turn that sent it. When the dispatch itself is placed
as a topic root, that placement owns the request and every answer to it, even if `--thread`
named an older topic. The Conversation shows the original request text as its root message;
the answer keeps its exact source and author. One dispatch may serve several explicit Inbox
requests, including requests in different topics. `topics request link` records that
association without moving the dispatch or its original answer. The owner copies the retained
answer into each linked topic once, retaining the answering agent's identity and the original
dispatch. A shared completion leaves each human request open for a check against its own scope;
an agent saying the combined dispatch is done cannot silently settle all of them. The Inbox
router closes each request with that thread's answer as evidence when it covers the whole
request, or sends only remaining work. On restart and when a late link is recorded, the owner
reconciles retained final answers. The request ledger is the one writer; the dispatch ID and
per-topic answer event provide stable identities across retries. A link receipt proves
association, while the later per-request closure proves completion.
Moving a root to another topic is refused once a human reply from that root has been
forwarded to an agent for its current topic. The move would silently relocate that
reply's later answers and requested notifications. Route the exact human message
instead; its source remains visible in the original conversation.

A `--route-message` work request also joins the topic's durable request ledger in the
same local transaction that records its dispatch, on both local and peer paths. If that
exact message already sources a request, the dispatch joins it. Otherwise it gets its
own request sourced to the exact message; sharing a thread does not prove that two
messages ask for the same work. This covers
the November 4 failure in which an exact human reply went to an agent without being
linked, while an earlier attempt's completion closed the only tracked task.
An agent's post promising a future answer is refused unless the exact
source already belongs to an open request or it names that request with
`--promise-request`. A post cannot create a promise merely by saying it; send the
work first. A retry of the same accepted post returns its original receipt even after
that work closes; the open-work guard applies to new posts. `sessions topics obligations` reads all open requests in
one view with their current destination and age, without creating another store. The
reported owner follows live attempts and existing decision waits, including a decision
in another thread that holds an agent's work; ended attempts return to Inbox recovery.
That full view rebuilds every request's owner and waiting reason, so thnkr.ing's Open
requests chip reads `GET /inbox/obligations?view=count` instead: the same open requests,
counted by one indexed statement, with no items. The full view is read only when he opens
the Open requests list (2026-11-05: the chip's re-reads cost 5 s and 15,800 statements each).

The request's source input and its named thread answer different questions. The source is
the event that caused this send; the named thread message is the return address for its
answer. An agent follow-up can start work today while naming a human message from weeks
ago as that address. The owner retains a new, dated request event in the topic and keeps
both identities on the dispatch. Readers use that dated event to show the new work,
including its sender, purpose, recipient and exact request on opening; they do not move
the event into the old message or present that message as new activity. A request caused
by the human message itself can stay as a handoff attached to that message. One request
identity yields one visible handoff in either placement, while its return still follows
the named thread root. This lets an audit reopen an October request in November without
making the October message appear to have been sent again.
Both canonical and prepared request messages carry the request's source input as
`promptInputId`, separate from their `replyToMessage` return address. The prepared-message worker refreshes earlier
request displays on upgrade, so the distinction remains readable for reopened work sent
before the browser change reached a device.

Both server and Mac startup reconcile requests placed after their answers arrived: they close
the answered request and move its existing reading item without notifying twice.
When the router links one dispatch after its final answer, the owner finds that answer through
the dispatch's indexed request events and its exact forwarded post. It does not scan historical
Inbox posts for every link; the linking command runs on the owner's admission thread and must
remain bounded while many retained requests are being placed.

**Threads keep themselves current** (thread upkeep in `session-topics.ts`; Tejas, 2026-10-12,
capture `d30a141a`: "you're not maintaining the threads, so a lot of threads that could be closed
are still in my thread view"). On that day 71 open threads held requests whose work had ended:
his replies to the agent working on a request were never counted as its work, a "could not finish"
answer posted into the thread closed nothing, and no thread ever closed itself. Now:
- His reply forwarded to an agent is linked to earlier work only when it replies to that
  work's posted answer (`topic-link:forward:<request>:<topicRequest>`). Its answer can then
  settle that request, and a later reply after closure reopens it even if its attempt
  stalled or ended. Sharing a
  thread or agent does not establish that a new question continues earlier work: the October 16
  Fully Kiosk answer otherwise closed an unfinished lyrics build in the same thread. If the
  forwarded reply has no one proven earlier request, it becomes its own request, sourced to
  his exact reply and linked to the forwarded agent attempt. The owner records when this
  rule starts before accepting new work after installation; older unlinked replies belong
  to the historical audit, not an automatic replay.
- Once nothing sent for an open request is running, an answer explicitly marked completed
  with a live check closes it `completed` under `refuseUnfinishedCompletion`. An honest
  `--not-checked` answer leaves the task open and returns verification to the router;
  that verification does not repeat an acknowledged external effect. A reply that only
  answers and changed nothing says so with `--nothing-changed "<what the answer rests on>"`
  (shown as "Answered; nothing was changed: …") and closes like a checked completion:
  there is nothing to see working, and on 2026-11-05 an honest not-checked answer to his
  question (`req:forward:c3148684`) looped back to the router for a verification nobody
  could do. Not-checked keeps meaning a change exists that nobody has seen working. His own Stop
  ends only the stopped attempt; the router is told not to restart it or its
  effects without new instruction. A reopened request records how many dispatches
  it already had. An answer from that earlier set cannot close it automatically again;
  the router must link the continuation or name a checked answer posted after reopening.
  Answers retained before work dispositions existed never gain a disposition by inference and
  never close a request automatically. The router may close one request after checking the
  historical answer against that request's whole scope, citing the exact final answer event as
  evidence. The owner accepts that evidence only when the linked dispatch ended `answered`, the
  named event is its unsuperseded final, and the retained request, source, responder and answer
  bytes agree. An uncertain outcome, a sibling answer, a different event, or an answer that does
  not prove delivery, deployment or live acceptance stays open. This request-specific closure
  does not edit the historical result or dispatch another worker. The same exact-final evidence
  also lets the router close a migrated request whose checked, completed answer predates its
  topic and was shared with another request: the router names the original final event for each
  request it has checked. Closure stores that event in the request's evidence; it does not post
  the answer again in the topic. A failed final or one marked not checked cannot qualify;
  for older answers without a structured check, the router must inspect the retained words
  and live evidence before making its request-specific closure judgment.
  A migrated request with no linked dispatch can also close against an exact later answer
  post in its own thread from an accepted Inbox successor. The owner compares the post's
  retained time and thread root with that request's creation and topic; a post in another
  thread or an answer predating the request cannot qualify. The router still checks that
  the words answer the whole human request before it names the post as evidence.
  Linked attempts are evaluated in admission order, including when an older failed
  attempt is discovered and linked after its checked successor. The old failure remains
  visible without becoming current merely because it was linked last.
  A failed,
  cancelled, handed-back or otherwise unfinished attempt leaves his request open. The owner
  gives the Inbox router a retained recovery input with the exact request and latest attempt.
  A request with an open decision question waiting on Tejas gets no recovery input. So does a
  request whose latest attempt is still unanswered with an agent that, when the attempt was sent,
  already held a ready question waiting on him (its declaring agent, or the agent its linked
  work went to), even in another request or thread. A decision
  question records its request on `owner.requestId`, derived when declared: the one open
  request its sources name, else the thread's only open request; with several open requests
  and no such evidence, `topics questions` refuses until the declaration names one or sets
  `owner.requestId` to null for a thread-level question. Questions asked before this rule
  (2026-11-04) are read by the same derivation; an ambiguous one is named in the recovery
  input so the router links it instead of restarting work. A linked question still being
  prepared (`agent_checking` or missing fields) is not shown to him, so it does not quiet the
  request; its recovery input names the question and its missing fields so the router finishes
  it. A declaration carrying `onlyHeCan` with missing fields and no explicit `context` is
  refused (`QUESTION_NOT_ANSWERABLE`) instead of being parked out of his sight. If the router's input ends without a replacement dispatch or checked completion, upkeep
  sends another attempt after a bounded delay, starting at fifteen minutes and capped at one
  day. Upkeep admits at most five recovery inputs on one reading pass, leaving the rest
  eligible on the next pass. The input and flag have stable identities across restart. After
  two recovery turns without a linked next attempt, the thread gets one notice that the task
  is still open and Concierge is continuing to try. A request with no certain linked human
  source still reaches the router for provenance investigation without inheriting authority
  from a nearby thread message. The router inspects prior effects before sending remaining work;
  it cannot close the request
  as failed merely because an agent could not finish. Declined or withdrawn closure of a human
  request requires his exact withdrawal words from a later retained message tied to
  that request: a reply to its agent answer, a thread with only that request open,
  or words naming the request. His message routed into this thread counts by its
  routed copy or original ID. The quote is retained with the closure.
  His Close control withdraws the requests it names; Stop ends the current attempt
  and leaves the human request open for reconciliation. An agent issue report may be
  declined with its reason when it needs no work. An agent cannot supersede a human
  request because another request shares its source message: both stay open until
  their work is individually checked. When one agent answer is linked to several
  requests, none closes automatically: the recovery input names the shared answer,
  and the router checks each request's remaining scope in a separate close command.
  A superseded close of an agent report cannot
  expire a live decision question. That question must be carried to the replacement or
  explicitly settled with a proven replacement question. A question only he can answer
  remains open in its thread. A question still being prepared by an agent is recovery work,
  not a reason to leave the task waiting on Tejas. When Tejas has replied to a question but
  the router has not reconciled that answer, the question no longer counts as waiting on him;
  the task returns to the router with his pending reply as the next thing to process. Recovery
  reads all explicit replies to open questions, including older replies beyond the bounded
  thread-list read. A thread he set aside holds recovery until he resumes it.
- When the router itself completes a human request without dispatching another agent, it
  names the later answer in that same thread as evidence. A bare completion claim with no
  linked work or answer is refused. Verification-only agent test reports remain distinct
  from human requests.
- His Close action names the requests still open in that thread. It withdraws those requests
  in the same durable topic event; Undo restores those exact requests. Upkeep recognizes
  older human Close events that left their named requests open and records the same
  withdrawal before considering recovery. A thread Concierge or an agent closed while work
  remained does not withdraw it: upkeep reads those open requests and returns them to the
  router. Close does not stop an agent's already running turn.
- A thread closes itself (`topic-autoclose:<topic>:<revision>`, closure `automatic:true`, by the
  owner) at the moment its last request or question ends or an agent's final answer arrives,
  when no request is open, nothing waits on him (an unread answer counts, as does a question set
  aside until a time), no work for its roots is running and it is not set aside. It is decided
  only at such an ending, never by a pass over quiet threads, so a thread reopened by hand stays
  open until something in it ends again.
- A closed thread reopens when he writes in it (`topic-reopen:his:<input>`), when new work is
  placed there (`place`, `request add`, `request link`, `request reopen`), bringing back the
  questions its closure ended, or when anything new waits on him there, such as an answer filed
  after it closed (`topic-reopen:waiting:<topic>:<revision>`).
- Both rules run after every live topic change, whatever path made it (the router's and his
  commands, the owner's filings, his "mark seen"); replay projects events without them.
- The pass runs on the owner's reading cadence (about every three minutes, first about 30 seconds after start) in both runtime
  compositions, over open threads and threads with his reply still being worked on.

**A thread's title is checked against what it holds.** When a thread's newest request shares no
word with its title and at least half of its last four requests do not either, `request add`
returns `titleDrift` and the router's `<topic>` block carries it with what to do: rename the
thread, or, when he named it himself, move the unrelated requests into their own thread.
A post's `--topic` must be the
topic its thread is in. A turn's result is marked `mixedThreads` when its asks or posts named
a thread other than its own input's, and `answeredByPost` when it posted into its own thread.
Thinkering keeps either closing text out of that thread's conversation. **A turn another agent opened owes its thread a post** (`threadOwedByTurn`): a worker's return or an agent's request filed in a thread is answered only by a post, because the closing text of such a turn is never shown there. `sessions outcome` is refused for that turn until it has posted into the thread (`failed` excepted); a turn that ends without posting has its closing text relayed into the thread by the owner as the router's reply (`post:relay:<turnId>`, payload `relayed:true`, projected `relayed:true` on the message), releasing the router's focus like any post, so an answer can reach the thread or be refused, never vanish. On 2026-09-24 a worker's result was answered only in closing text and Tejas found nothing in the thread for two hours. **A turn that answers his own message cannot end in unexplained silence** (`answersHisOwnMessage`): `sessions outcome done` on it is refused unless `--quiet-because "<why he need not read this>"` is given, and a turn that ends by marker or without declaring is raised to `response` so he is notified; the stated reason is recorded on the turn outcome (`quiet`) and projected on the reply message as `quiet`, which thnkr.ing shows under it. Nothing is inferred from the text (Tejas, 2026-09-25: "if you make a field mandatory … then you are forced to answer it. That's a system … we are not relying on good intention"). Both facts come
from that turn's recorded requests and posts, rather than comparing the post's root input
with a later reply's distinct input ID. A source input with a retained handoff is the
narrow exception to the `done` silence and owed-post rules: its receipt tells him where
it went, including when an agent authored a marked test capture. Its `done` closing
result adds no second message. A routed turn with an answer or question posts that
answer or question explicitly. A turn may route an input accepted after its opening
input; an explicit `done` result is hidden when any input in the turn has a durable
handoff, while each handoff stays attached to its exact source message. Tejas asked
for `mixedThreads` after a turn handling several topics filed another topic's
results and its closing note under the Questions-redesign thread (2026-09-23): "if you're
going to send this request, you have to tell me which thread it's for … Stop relying on good
intentions".

The router says what it is working on: `topics focus <topicId> -- <what it is doing>`
binds that topic to the exact run, and `sessions post --thread <id>` releases focus for the
inputs that thread covers unless `--keep-working` (`--topic` names the topic explicitly and
is refused when that thread belongs to another one). Focus belongs to the run that declared
it, so a run that ended, errored or was stopped stops claiming a topic without any timer.
A topic's `work` is `router_working` (its focus), else `router_queued` with its 1-based
position among queued Inbox inputs, else `worker_working` naming the target session of an
unsettled dispatch from this topic, else `idle`.

**In the Inbox, the only thing that can wait on him is a question record in its topic**
(design: `docs/plans/2026-09-23-attention-that-ends.md`). A question has a `kind`:
`decision` (he must answer; `needs_you`) or `reading` (an agent wants him to read it;
`response`; waits on nobody); an `origin` (`declared` with `topics questions`, `marker`
filed from a turn's end-of-turn marker, `recovered` by a migration); a `generation` (the
Inbox attention generation it was raised at); and an `owner` — the session that asked and
can retire it. **A reading item carries what he is to read**: `reads:[{messageId,text,at}]`
on the question view and on the Inbox's Needs-attention entry, resolved by the owner from its
own records and never copied — the posts the raising turn made into that thread, else the
turn's closing text when the input it answered is in that thread; a `topics questions`
declaration may name the messages itself (`reads:[messageId…]`, which must be in that
thread). A reading item with nothing to read is refused at every door (`NOTHING_TO_READ`:
filing a turn's outcome, declaring or revising a question, and `sessions outcome response`
before any post into the thread, while a finished turn's unreadable `response` is recorded
`done`), and any left from before the rule are `expired` at startup with that reason. Tejas met
two on 2026-09-24 that showed a heading, a link to his own message and a failing Read: "I
literally cannot read this … I want the answer I have to actually read".
An agent's prompt-answer partial is one post in the thread. Its later bodyless final closes
that exact request and exposes `closingLine` on the existing answer message: the disposition
and checked/not-checked facts. The closure is retained separately from the answer bytes. A
progress-only partial stays on the request's Work receipt and Brief instead of adding another
conversation reply; an agent's explicit notification request still posts it. Older unnotified
progress posts are removed from prepared conversation reads on upgrade, while their receipts
remain available by request identity. A
final containing new body text is posted as a new message with its own closing line. The
prepared topic view refreshes the existing answer on closure and catches up retained closures
after an update; its bounded preview carries the line as well as the exact message detail. The
owner never decides whether to show a post by comparing its words, files or hash with an
earlier post; historical duplicates remain visible.
`needsYou` counts decisions that are open or partially answered, **ready**,
blocking or not optional, and not `pendingReply`; `toRead` lists open reading items; both
are on every topic summary, and `questions.open`, `questions-read open|reading|checking`
and every question view's `waiting` come from the same two predicates, so no surface
recomputes or disagrees. A preparing question is the agent's, never his, and counts under
`questions.checking`. A question is `pendingReply` only when a human reply newer than its
`updatedAt` names it: a reviewed question on the reply, or a reply to one of the question's
source messages. An unrelated later message in the thread changes nothing (the approved
design; Tejas, 2026-09-22). Exposure is never an answer.

Every end is an explicit signal, recorded with its reason, and nothing ends on a clock:
`answered` (his mapped reply), `read` (his Read on a reading item — the human `question`
action with `state:'read'`, `acknowledge --item <questionId>` on a reading item, or his
"mark seen" `dismiss` on the Inbox session up to a generation; opening the thread is a
reading position, never an end), `superseded` (a replacement), `withdrawn`/`declined`
(whoever asked, or him), `deferred` (him), and `expired`: `topics close` and his Close end
every open question in the thread with "Thread closed: <reason>"; his Close also withdraws
the open requests named on its confirmation. `request close` ends only
the questions whose `owner.requestId` or `owner.dispatchRequestId` names that request, and a
worker's final reply with `completed` or `failed` ends the questions it declared for that
request (a `needs_decision` final keeps them; that reply is the question). `brief.endedBecause`
carries the reason and History shows it.

**An end-of-turn `needs_you`/`response` marker in the Inbox never files itself.** When the
run declared or revised a question (`topics questions`), the marker adds nothing. Otherwise
the entry is held **unfiled**, in no thread, on `topics list`'s `sorting.attention` (with the
thread its turn started from as `startedFrom`, a suggestion only — filing by that thread put
two questions about the Mac capture bar under "Signing my other accounts in"). The router files
it with `topics file <topicId> --need <eventId>`, or as `from` in a `topics questions`
declaration with a full brief; he files it from the sorting page (`file` action). The Inbox
session's own `attention.open` is the unfiled entries plus the questions waiting on him or to
read, so the Inbox card, the Threads rows and the Questions tab agree. Migration version 2
(`migrateInboxAttention`, once, guarded) filed the 2026-09-23 backlog: every entry no
question covered became a `marker` question under its thread (expired at once in a closed
thread, `read` when he had marked it seen), and the Inbox's `needs` kept only the unfiled ones.

A topic's `work` is `result_waiting` only when a worker's final return has no direct answer post
or later router post on that root. The prompt's `<topic>` block names it as `unrelayedResult`.
Since 2026-10-14 every request naming an Inbox thread posts each fresh reply there directly,
whether the request is work or informational. Work finals keep their existing attention filing;
informational finals close their linked request quietly unless the asking human input explicitly
requested a result. Progress remains quiet. A named-thread request does not wake its requester
unless it explicitly chose a requester return. The request receipt still retains the full brief,
all progress, the final disposition and stall evidence. The `<topic>` block lists direct posts as
`agentAnswers` when the router is next asked to act; it does not read the worker's session.

### Thread work lane

The thread's work lane reads `GET /sessions/v1/inbox/topics/:topic/coordination` in pages of at
most 20. Each handoff has a stable request identity, named recipient, one-line summary, current
request state, source input, original brief (up to 8 KiB inline), and the three latest retained
request events. The exact `GET /sessions/v1/requests/:id` read carries any longer brief or older
progress on explicit opening. Automatic earlier-work posts are separate `suggestion` items with
their exact retained text. The source capture remains its own message in the conversation;
clients show handoff and suggestion identities in the work lane rather than repeating them as
conversation messages. The work page seeks indexed request and suggestion identities in the
prepared Inbox ledger, so old unrelated conversation does not extend a page read.
The topic's current-work summary groups open deliveries by their current destination session:
several requests to one session still have separate receipts, but its worker row appears once
with the latest progress from those requests. An accepted session handoff moves open requests
to its successor, so the successor is the current worker. Distinct destination sessions remain
distinct; a shared title alone does not prove they are one agent.
Opening the private coordination view uses the same route with `mode=private`. It pages local and peer requests
that inherited this topic from their originating human task but did not ask to post a public
thread answer. Each item names the sending and receiving sessions, summary, state and exact
receipt for full detail. It does not post or notify Tejas on its own; he opens it when he wants
to inspect how the agents coordinated. The topic association is retained at request admission,
including when the agent did not name a thread on its private request.
When Tejas addresses a reply directly to an agent, its internal delivery request is excluded
from the conversation projection, including existing prepared rows on upgrade. His source
message remains once with its route receipt and the agent's eventual answer still posts there.
The Inbox session's own conversation (its Sessions view and history page) omits that forwarded
reply and its carrier request: the router never received either, and listing them there made
every thread's replies look delivered to the router (Tejas, 2026-11-05). Threads keep both.

### Routing handoffs on the source message

The accepted human message owns the visible routing handoff. A session route, a route into
another thread, and a direct reply forwarded to a working agent retain distinct delivery
identities; the message projection gives each destination its kind, recipient, destination
message, exact request identity when there is one, and a compact preview of the router's
one-line summary when it supplied one. An explicit thread request retains its full brief and status in its own
request receipt. A direct forwarded reply remains one human conversation message, with its
internal carrier request withheld from Conversation. The source message's route disclosure
points to that carrier request for details; routing the same source into several destinations
produces several entries under that source, not a guessed destination from the latest turn.
Routing one exact Inbox message to an existing session keeps the source thread as the
request's answer destination. The route receipt shows where the message went; the
recipient's final answer posts once under that exact message, including when the
recipient runs on a peer machine. The request's final event and the thread post have
stable identities, so retrying delivery neither resends the work nor duplicates the
answer. The request cannot be marked delivered to its conversation merely because the
agent settled it in its own session. Before this rule, route-message deliberately
suppressed the thread answer and marked the final event received, leaving a settled
request and a waiting card with no visible answer (Nov 5 Cloudflare copy question).

A router turn that routes Tejas's input and explicitly declares `done` has no second conversation reply
from its closing text, including the owner relay for an agent-authored routed input. The closing
text stays in the session history. A requested answer or
necessary question is posted into the thread deliberately; declaring `response` or `needs_you`
after routing is refused until the turn posts there. This rule belongs to the Inbox router alone:
a worker that asks another session for facts while answering a routed message has routed
nothing, and declares `response` with its answer as usual. A routed turn that fails, or an older
unclassified closing answer, remains visible rather than silently losing substance. The
prepared Inbox ledger removes already indexed explicit `done` narration when upgraded and also when
the outcome arrives after its result. Marker-only legacy closes remain visible because their
unclassified text might contain an answer. The route request and receipt are the durable evidence
of delivery; closing prose never establishes that the recipient accepted work.

The work item names both the requesting and receiving sessions, so a delivery or cancellation
does not inherit the requesting model's label as if it were the speaker in the conversation.
A canceled request's generated service notice stays in the exact request record and work state;
it is excluded from the conversation projection, including older prepared rows on upgrade.
Prompt-answer reminders, overdue notices and genuine agent answers remain conversation posts.
The public work item gives a canceled handoff `communicationKind: cancellation`, its retained
canceling actor when one is proven, and the exact human input when it directly sent the request.
Canceled internal thread-upkeep work is omitted from the public work lane; it has no message
from this conversation to attach to. Its exact request and cancellation remain available by
request ID through `sessions get`; this is not the private work-mode page. Cross-thread requests
remain in the thread they addressed. A missing actor or human source remains unknown, not
inferred from request prose.
The 20-item public page reads local and Mac request identities in two batches and canceled
source origins in one batch. Each batch has a page-sized SQL limit. The public read projects
only a short summary and at-most-8-KiB request preview, and short activity text in both
public and on-demand private coordination. Exact full request and result bodies remain available by request ID. Its storage budget includes those
bounded rows and bytes.

The Inbox router may post its own answer even while another agent works on the topic.
Its automatic `Sent to` receipt is the routing mark; the router's own instructions send
substantive questions about the worker's job to that worker, whose answer posts in the thread.
A service return already posted in that thread cannot be relayed from the Inbox, and it does
not create a second owed-post duty. If the router leaves an owed answer unposted, the owner's
fallback relays its closing text as the router's reply regardless of another agent's work.

Human Inbox inputs and agent-marked captures carry their thread in the prompt: `<topic>` with the topic's id, title,
summary, open requests, open questions and root count (plus `review` when his reply pinned
the exact questions it answers), or `<topic-placement>` for an unplaced capture, with the
eight most recently active open topics and the instruction to file it before routing.
An unplaced agent request to the Inbox carries neither a placement instruction nor a
filing obligation: its request/reply record is agent coordination. The Inbox's
Conversation and prepared topic pages omit its accepted input and turn result, while
deliberate agent posts remain visible. The request and reply stay in their exact
session receipts for the agents. The presentation worker rebuilds its prepared
messages once when this visibility rule is installed, so old coordination cards
leave the conversation without deleting their records.
The Inbox's standing instructions (its routing preamble and the attention rule) are in its
per-run instructions, read once per run; an input carries only its identity header, its capture
identity and these per-input facts. The routing preamble was prefixed to every input until
September 23, 2026; the attention rule moved there before its release.

Migration runs once at owner startup, guarded by a `topics_migration` event with
`version:1` on any Inbox session: a provider or folder cutover that makes a new Inbox
session does not rerun it (or attention migration version 2), because later threads are
filed live ([failure record](../incidents/2026-11-05-inbox-migration-reran-for-new-inbox-session.md)). Only a human-authored Inbox root or a marked, routable agent capture can
become a recovered request. Agent coordination, returned answers and service upkeep
remain in their exact receipts; a transcript root alone grants no human-work standing.
For each eligible root the migration creates one topic (`recovered:1`), one open request
with its linked dispatches, and one question per legacy attention entry retaining its id.
The manifest `{roots,topics,requests,questions,unresolved}` is written into the guard event.
An owner-ledger correction retires previously recovered service-notice requests (returns, upkeep,
allowance, area, cut-off turn, background-job and watch notices alike) only when every
root in their topic is a service-origin input, there is one request sourced to one of those
roots, no question is still unsettled, there is no human reply, and every dispatch added after migration
has its own home in another thread (where its request or original thread root is placed) whose open request lists it, which keeps
owning that work. A dispatch homed in this thread, in none, or in a thread with no open request listing it keeps the request open, unless it already finished with a checked answer (not a question for Tejas, a failure or an unverified completion), which holds no live work. A returned result and its later upkeep notices
can therefore share one synthetic topic without becoming human work. Agent-authored work roots stay open even
when the root itself is not human-authored: its source may carry Tejas's delegated work. The correction records
the exact migration event, all roots and each later dispatch's request as closure evidence, alongside the original request identity
and source input when retained. It reads recovered threads of every Inbox session, not only the current one, because a later Inbox session (provider cutover or acting router) does not adopt them by handoff, and records each retirement under the thread's own session. It keeps the original request, source inputs, result receipts
and topic history. The original migration event proves which dispatches were present before any later assignment.
Completion of original work remains governed
by its own request's checked answer.
New human roots stay unplaced until the router or a human
files them; they appear as the `sorting` pile on the topics read.

## Filing before stopping

“Never filed” means a retained Inbox message's root has no topic placement. It is
independent of execution: a queued message is waiting for the provider to receive it;
an answered message can still be unfiled. Both are stored in Concierge's server ledger,
not in the provider's conversation memory. The topic owner resolves replies through their
root, so replying inside an existing topic does not require another placement.

Each unplaced input carries the existing `<topic-placement>` reminder when delivered.
The router can inspect the sorting pile with `sessions topics list`; that display includes
queued messages too and previews only five. There is no periodic “pile nonempty” agent
notification. The shared owed-reply Stop hook now asks the owner on every normal Stop
attempt for all unfiled human message inputs that this Inbox session received, including
earlier turns. Initial delivery is evidenced by provider acknowledgment (or the exact
currently stopping turn); steering requires its sent receipt. Merely queued, imported,
corrected agent authorship, service returns, worker requests and topic actions do not block.
Outside-agent captures delivered into router turns follow the same filing check, providing
the live agent-marked acceptance path without claiming human authorship.

`/session-communication/owed` returns `unfiled` beside its existing reply obligations.
The hook names every input, a short data-only preview, its resolved root and ready-to-fill
`sessions topics place/create` commands with the current source pair and stable action IDs.
There is no five-item display limit. Repeated `stop_hook_active`, background jobs and
waiting on another request do not excuse filing; the existing one-reminder rule for
communication replies remains separate. A blocked Stop retains its browser processes.

Noise needs no new discard store: create a topic for that input, then use the existing
`sessions topics close <returned-topic-id> --scope <input-id> ... -- 'Noise: <reason>'`.
The close requires a scope and nonempty reason. The original message and closure remain
auditable in the closed thread. Filing into any topic also satisfies the check immediately;
the check enforces placement, not the router's judgment about the chosen topic.

This runs in Claude and Codex's existing Stop mechanism, not a new watcher or queue.
It prevents voluntary completion when the owner reports outstanding filing. It cannot
prevent a user Stop, crash or provider error. The hook's existing owner-unavailable
fail-open behavior remains; retained obligations are checked again on the next Stop.
Running turns keep their pinned hook version; the new hook applies to turns started after
activation. Outside CLI conversations without a running Concierge turn pass through.

## Authorized recovery continuation

Human `1789510460.238219` authorizes one bounded wake for Inbox recovery. The operator
CLI `bot/scripts/native-pipeline-continuation.ts enroll <id> <json-file>` sends the
authorization over the root-only owner socket. The owner validates the exact live
`sourceInputId`/`sourceRunId`, required Git commit, deadline and complete
continuation brief, then records it in existing owner events without
queuing a provider turn. The enrollment stays valid after that source yields; it is
not presented as a fresh live source later.

Remote-box's `concierge-native-pipeline-wake` timer invokes `tick <id>` once a minute.
Only a successful deployment of the required commit or descendant, the matching live
release and a responding native Inbox route count as ready. Otherwise the deadline
wakes the owner with the actual blocked state. The CLI asks the owner to retain
one `origin:service` input and queue its continuation.
The running runtime's native queue startup and existing 60-second liveness wake own
execution; no new public API, provider runner, deployment runner, Slack input or credential
is involved. This works before the pending cross-turn partial-return fix activates.
The timer stops after provider admission or a terminal queue failure, and Stop,
pause or archive cancel the continuation. Operator receipts contain IDs and state;
the private continuation text stays in the common ledger.

## Interpreting native Inbox intent

- The native Inbox interprets human intent, including “take a note”, “take action” and
  “ask ChatGPT”, without requiring magic prefixes. Ideas are not build authorization.
  Ambiguity asks the human. Note saves use the existing Thinkering capability host and
  original retained capture bytes; user edits survive retry. No extraction runner returns.

## Owner upkeep under held returns

The owner files a final agent answer, copies it to any linked requests, and brings its thread
current once per exact final event. A durable upkeep receipt is written only after all those
steps succeed. If the asking session is unavailable and its return remains held, delivery
polls may revisit the final, but the receipt prevents repeated Inbox work. A failed filing or
upkeep leaves no receipt, so the same exact event can finish safely on retry. The provider
usage watch checks open work in short, yielding owner turns; its per-thread transactions and
recovery identities remain the same. A recovery admission rechecks current work and his
answers after any yield, and a new reading joins an already running pass.
