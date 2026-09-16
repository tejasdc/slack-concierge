# Native Inbox

Concierge owns the active canonical Inbox session, accepted inputs, attachment bytes
and request obligations. Thinkering opens it with its existing conversation surface.
The existing capture ingress and queue remain the producer boundary. A provider/cwd
cutover creates a new active session; earlier Inbox sessions and their source and
request evidence remain in the catalogue and visible Inbox history.

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
