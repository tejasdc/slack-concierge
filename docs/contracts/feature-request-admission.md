# Feature request admission

A thnkr.ing feature sometimes has to ask an agent for work it composed itself: the writing
partner sends a thread's `%% … %%` notes to its co-writer, sentence feedback goes to the agent
that wrote the sentence, the Reader asks about a passage. Through the ordinary
`POST /sessions/v1/sessions/:id/inputs` route those arrived as Tejas's own messages ("You ·
web"), text he never typed, which is the provenance break he called lying (Sept 17–23).

`POST /sessions/v1/sessions/:id/feature-requests` with `{clientActionId:"feature:<feature>:<id>",
feature, text}` admits the text with **service** origin, prefixed by one line naming the feature
and saying it is not a message Tejas typed. The conversation shows it as a service message and
the agent reads it as such. Where his own words matter (his note, his question), the feature
quotes them inside `text` and says they are his; he is never the sender. A repeated
`clientActionId` is the same admitted input.

Creating the conversation still uses `POST /sessions/v1/sessions` without a first input, which
records no message. The journal keeper keeps its narrower
[journal observation admission](journal-observation-admission.md), which also fixes the
destination. Release order: Concierge first, then thnkr.ing, which calls this route after
activation.

## Bound held-message resolution

The trusted **local thnkr.ing service** may supply optional `resolution` on the
same feature-request route. Generic requests without it remain compatible.

```json
{
  "clientActionId": "feature:held-send:<resolution-id>",
  "feature": "held-send",
  "text": "Retained diagnostic evidence and bounded resolution brief",
  "resolution": {
    "kind": "held-message",
    "id": "<resolution-id>",
    "originalRequestId": "request:<assigned-request-uuid>",
    "taskId": "<retained-product-task-id>",
    "messageId": "<retained-product-message-id>",
    "sourceInputId": "capture:<original-human-input>",
    "failedReadingId": "<retained-reading-id>",
    "failedReadingSha256": "<64-lowercase-hex-digest>"
  }
}
```

`originalRequestId` names the exact retained task operation. A native accepted
target input, or a bare communication UUID whose retained request proves its exact
assigned target, is supported. An outgoing request operation can resolve through
its own retained request ID. Ambiguous aliases are refused. Direct-human
operations are explicitly unsupported in this first release; no guessed dispatch
or thread is created. The owner resolves the exact assigned local request;
it accepts no caller-selected thread, run or provenance claim. `id` is 1–200
word/colon/dot/comma/at/hyphen characters beginning with a word character.
`clientActionId` equals `feature:<feature>:<resolution.id>` and is at most 200 characters. Other identity fields
are nonblank strings up to 500 characters without control characters; digest is exactly 64 lowercase hex.
Extra resolution fields are refused.

The owner requires the assigned request's admitted target, proven human source
matching `sourceInputId`, and exact native Inbox return thread. Inbox lineage
preserves router handoffs. It atomically retains one service input plus a
`feature_resolution_bound` event containing the original input/request/session,
human source/thread and immutable product references. These references and digest
are **service evidence**: the product owns semantic truth/freshness. Before new
admission the native owner reads the exact current product snapshot described
below, verifies all identity fields and the raw diagnostic SHA-256, then rechecks
native custody after the awaited read. The response is retained in the binding. A settled original request may
still have a held product task; this operation does not reopen or rewrite it.

Response is `{operation}`, the existing native receipt. `operationId` equals
`clientActionId`; `origin:service`, `humanAuthored:false` and
`provenance.effectScope:informational` preserve attribution and confer no new send
grant. `operation.request.featureResolution` contains `version:1`, `resolution`,
`originalInputId`, communication `requestId`, numeric `sessionId`/`inboxSessionId`,
`threadRootInputId`, `sourceInputId`, `continuationOnly:true`, and `snapshot` (below). Shared owner/read
projections require the separate owner event and accepted input to agree. An open
original work request can supply only its existing work authority; settled work
supplies no new delegated work authority. Admission, provider acknowledgement,
thread posting and completion remain separate receipts.

Identical retry returns the retained receipt **without redispatch**. Changed text,
recipient, feature or binding conflicts. New admission honors Stop/cancel/archive/
pause and pending/accepted recipient handoffs; queued execution and agent writes
recheck original custody and Stop. Duplicates after handoff are historical readback,
not resume. No session, scheduler, timer, external send or notification is created
by this admission contract itself.

Only a product snapshot classified `human-choice` may declare a human question;
`repair` and `revise-content` wakes return `FEATURE_RESOLUTION_REPAIR_REQUIRED`
if they attempt native `needs_you` or a question-bearing reply. Genuine human-only
questions use normal native `needs_you`, his exact initiating
words and the remaining gap; the retained binding maps that input to its original
dispatch and frozen return thread. System/model faults belong to the existing
software repair owner, never a fabricated human question. Ordinary agent-authored
`sessions post --thread <retained-root>` remains available. The original request
can close only through its ordinary reply protocol.

Errors: `400 FEATURE_RESOLUTION_INVALID`, `409 FEATURE_RESOLUTION_CONFLICT`,
`409 FEATURE_RESOLUTION_REQUEST_UNPROVEN`, `409 FEATURE_RESOLUTION_SOURCE_UNPROVEN`,
`409 FEATURE_RESOLUTION_THREAD_UNAVAILABLE`, `409 FEATURE_RESOLUTION_FENCED`.
`409 FEATURE_RESOLUTION_DIRECT_HUMAN_UNSUPPORTED` explicitly refuses unsupported
human-direct origins. `503 FEATURE_RESOLUTION_PRODUCT_UNPROVEN` means the fresh
product snapshot could not be read or validated; nothing is admitted. Normal
unknown-session/predecessor errors remain. Network agents/peers receive
`403 FEATURE_RESOLUTION_SERVICE_REQUIRED`; the existing root-owned local service
socket is the authority boundary for this typed extension.

This follows T10's protocol extension, T5's held-work preservation
[decision: wait-means-hold-not-cancel], T6's original-thread delivery and
[decision: questions-carry-his-words]. Software repair remains with its project
owner [decision: writing-agents-do-not-build]. Provider bindings stay unchanged
[decision: do-not-switch-live-session-model].


### Trusted current product snapshot

The owner makes one GET (no retry, five-second total deadline, 128KiB response cap)
over its existing authenticated Thinkering capability transport:
`/session-capabilities/messages/held-resolutions/:resolutionId`. This read has no
send, wake, classification retry or admission effects. Missing, stale, consumed,
withdrawn or unavailable records must not return eligible evidence.

The HTTP200 body is:

```text
{version:1, id, originalRequestId, callerSession:"concierge:<id>", taskId,
 messageId, sourceInputId, failedReadingId, failedReadingSha256, failedReadingJson,
 contextHash, envelopeHash, resolutionKind:"human-choice"|"revise-content"|"repair",
 reason, question:string|null, supportingQuote:string|null,
 state:"pending"|"admitted", eligible:true, consumed:false}
```

The product proves these fields from its current retained unsent task and reading,
including the exact executable envelope and any human Stop/withdrawal/consumed
or uncertain effect. `failedReadingId === contextHash`, and `id` is lower-case
SHA-256 of UTF8 `JSON.stringify(["send-resolution",taskId,contextHash])`.
`contextHash` and `envelopeHash` are separate 64-hex identities. `failedReadingJson`
is the exact retained diagnostic JSON string (at most 64000 characters), never a
reconstruction from a summary; the native owner verifies its UTF8 SHA-256 against
`failedReadingSha256`. All caller resolution identities must exactly match the
fresh response. `reason` is nonempty, at most4000 characters; nullable question
and quote are at most4000 each. For `human-choice`, question and quote are nonempty
and the quote must be an exact substring of the owner's proven original human
words. Service reason/diagnostic/model output is never treated as his words.

A failed product read cannot silently use the caller payload. Duplicate historical
readback makes no product call and never starts another turn. This is evidence at
admission time, not a lock or a send grant across two services: the product's own
execution/cancellation/consumed-effect guard remains authoritative when an agent
later acts. No historical accepted/sent task is a live acceptance seed.
