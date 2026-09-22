# Native Inbox

Concierge owns the active canonical Inbox session, accepted inputs, attachment bytes
and request obligations. Thinkering opens it with its existing conversation surface.
The existing capture ingress and queue remain the producer boundary. A provider/cwd
cutover creates a new active session; earlier Inbox sessions and their source and
request evidence remain in the catalogue and visible Inbox history.

## Answering a thread

Tejas asked that answering a thread be an action the Inbox agent takes, not something
the app scrapes from whatever the agent said while it worked. His reply into a thread is
a human input carrying `replyToMessage`, which wakes the agent; the agent answers with
`router-actions.sh sessions post --thread <message-id>`. The owner records a `post`
ledger event, and the Inbox page and its `history?after=` delta both include it, since
they share one query. It appears as an assistant message with `author.communication:
"post"`, the `replyToMessage` it answers, and the thread's root `inputId`.

A post carries files: repeated `--file <path>` for its own bytes and `--attachment
<custodyId>` to place a file already in custody — a worker's returned mockups — without
downloading and re-uploading them. The owner retains every file before it accepts the post,
under an action identity derived from the source input, action ID and position, so a retry
reuses that custody while different bytes conflict; an unknown custody ID is refused. The
`post` event payload and the retained action carry the ordered custody IDs, and the history
page and its `history?after=` delta expose `attachments:[{id,name,contentType}]` on that
message. A result row exposes attachments when its own retained result payload names them.
A post with at least one file needs no text; one with neither text nor a file is refused.

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

Kinds are `pebble`, `thinkering`, `monologue`. Source IDs remain exact producer
identities: the public capture worker uses its immutable event ID; Monologue uses
note_id. The endpoint uses the existing private `requests.sock` and root filesystem
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
Tejas chooses otherwise. Acceptance retains a human input and files and queues it
atomically through the existing execution owner. Native human ingress is the
provenance; no Slack message is manufactured. Stopped/archived session policy
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

The Inbox agent interprets explicit verbs and ordinary clear requests. Ambiguity
asks Tejas; ideas or quoted proposals do not authorize implementation. Work routes
through common sessions search/context/ask, with exact source, model, project and
attachments. It must preserve scoped user exceptions rather than applying them to
unrelated pipeline work.

`sessions note <captureId> <source flags> --action-id A` validates the live source/run,
resolves original capture bytes, retains intent, then calls `POST /captures/note` on
the existing Thinkering capability socket with `{captureId,text,title,capturedAt}`.
The response is `{source:{objectId,revision},note:{objectId,revision},created}`.
The capability owns idempotent creation by capture ID and preserves edited notes on
retry. The owner retains confirmed note receipts; uncertain responses remain explicit.
Agents cannot replace source text through this command. No old transform runner is used.

Delivery follows the existing Git deployment channels. Current human policy forbids
agent-run tests, sandbox probes and review cycles for this pipeline. Runtime product
acceptance belongs to Tejas. Prior failed evidence remains unchanged.

## Topics

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
`question settle`, `answer`, `acknowledge`, `focus`, `release`. `topics questions` takes
the reconciliation array in `--json-file`; the owner assigns missing `questionId`s, bumps a
question's `revision` whenever its decision, why, known, choices, uncertain, answerable,
blocking, optional or context changed (a new revision is a new unread revision), and
supersedes a replaced question with the replacement's id. `topics answer <inputId>` takes
`{"mappings":[{questionId,revision,passage,interpretation,state}],"unresolved":[…],"acknowledged":[…]}`,
records that answer against the retained human input, settles the mapped questions, marks
the acknowledged items, and clears the legacy `needs` entries whose recovered question is
now settled. It dispatches nothing: continuations still go out with `sessions ask` and are
attached with `topics request link`.

The router says what it is working on: `topics focus <topicId> -- <what it is doing>`
binds that topic to the exact run, and `sessions post --thread <id>` releases focus for the
inputs that thread covers unless `--keep-working` (`--topic` names the topic explicitly and
is refused when that thread belongs to another one). Focus belongs to the run that declared
it, so a run that ended, errored or was stopped stops claiming a topic without any timer.
A topic's `work` is `router_working` (its focus), else `router_queued` with its 1-based
position among queued Inbox inputs, else `worker_working` naming the target session of an
unsettled dispatch from this topic, else `idle`.

`needsYou` counts open or partially answered questions that are blocking or not optional,
plus legacy attention entries in the topic that no question recovered. A question with a
human reply in the topic newer than its `updatedAt` is reported as `pendingReply` and
excluded from the count: he has answered, the router has not reconciled it yet. Exposure
and acknowledgement are separate facts and never an answer.

Every Inbox input's prompt carries its thread: `<topic>` with the topic's id, title,
summary, open requests, open questions and root count (plus `review` when his reply pinned
the exact questions it answers), or `<topic-placement>` for an unplaced capture, with the
eight most recently active open topics and the instruction to file it before routing.

Migration runs once at owner startup, guarded by a `topics_migration` event with
`version:1`, and is additive, resumable and safe while the Inbox is live: one topic per
existing thread root (`recovered:1`), one open request per topic with that root as its
source and its dispatches linked, and one open question per legacy attention entry, which
retains the entry's id so answering it clears the entry. Nothing is closed, notified,
dispatched or deleted, and the manifest `{roots,topics,requests,questions,unresolved}` is
written into the guard event and logged as counts only. New roots stay unplaced until the
router or a human places them; they appear as the `sorting` pile on the topics read.

## Authorized recovery continuation

Human `1789510460.238219` authorizes one bounded wake for Inbox recovery. The operator
CLI `bot/scripts/native-pipeline-continuation.ts enroll <id> <json-file>` validates
the exact live `sourceInputId`/`sourceRunId`, required Git commit, deadline and complete
continuation brief. It records this authorization in existing owner events without
queuing a provider turn. The enrollment stays valid after that source yields; it is
not presented as a fresh live source later.

Remote-box's `concierge-native-pipeline-wake` timer invokes `tick <id>` once a minute.
Only a successful deployment of the required commit or descendant, the matching live
release and a responding native Inbox route count as ready. Otherwise the deadline
wakes the owner with the actual blocked state. The CLI retains one `origin:service`
input and queues it through existing `retainSessionInput`/`enqueueSessionInput`.
The running runtime's native queue startup and existing 60-second liveness wake own
execution; no new API, provider runner, deployment runner, Slack input or credential
is involved. This works before the pending cross-turn partial-return fix activates.
The timer stops after provider admission or a terminal queue failure, and Stop,
pause or archive cancel the continuation. Operator receipts contain IDs and state;
the private continuation text stays in the common ledger.
