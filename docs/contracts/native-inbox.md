# Native Inbox

Concierge owns one canonical Inbox session, accepted inputs, attachment bytes and
request obligations. Thinkering opens that session with its existing conversation
surface. The existing capture ingress and queue remain the producer boundary.

`GET /sessions/v1/inbox` returns `{session: SessionView | null}` without creating
anything. `GET /sessions/v1/inbox/:captureId` returns `{item}` from retained custody.

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

First acceptance creates the Inbox if absent, retains a human input and files, and
queues it atomically through the existing execution owner. Native human ingress is
the provenance; no Slack message is manufactured. Stopped/archived session policy
remains owned by normal session controls. Provider selection is the existing `cx-sol`
alias at Inbox creation; later human session controls remain available.

`importOnly:true` retains the source in native history with a completed import
receipt and no provider turn. A duplicate cannot change its first disposition or
execute it. Later assignment is a separate explicit human input. Historical Slack
deliveries, previous assignments and uncertain work are not replayed during import.

Thinkering bug-report text is recognized from its report format. The readable part
before Complete diagnostics JSON appears in the conversation. The exact full report
is retained as `thinkering-bug-report.txt`, alongside original images. New intake and
imports share this conversion; the original digest binds all bytes. History pages
do not contain base64 file bodies or eagerly render diagnostic JSON. The Inbox reads
accepted dialogue through existing owner event sequence, including import-only inputs
that intentionally never entered a provider transcript.

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
