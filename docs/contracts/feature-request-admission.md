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

The trusted **local thnkr.ing service** uses
`POST /sessions/v1/sessions/:id/feature-requests/held-message` with required
`resolution`. This typed sibling uses the same bound handler; an old owner returns
404 without admitting an unbound wake. Consumers never fall back to the generic
route. Generic feature requests remain compatible; their optional binding uses
the same validation, but capability preflight is not a rollout safety boundary.

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

`originalRequestId` names the exact retained assigned target input operation. No
bare UUID, prefix guessing or alternate-operation lookup is used. Direct-human
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
questions use normal native `needs_you`, his exact verified human
words and the remaining gap; the retained binding maps that input to its original
dispatch and frozen return thread. System/model faults belong to the existing
software repair owner, never a fabricated human question. Ordinary agent-authored
`sessions post --thread <retained-root>` remains available. Before a question-bearing outcome or reply, one fresh bounded product read must
still prove this same eligible assessment, then native custody is rechecked. Stale
product context cannot post a new human question. The original request
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
 messageId, sourceInputId, failedReadingId, failedReadingSha256,
 failedReadingFormat:"assessment-manifest-v1", failedReadingJson, quoteSourceInputId,
 contextHash, envelopeHash, resolutionKind:"human-choice"|"revise-content"|"repair",
 reason, question:string|null, supportingQuote:string|null,
 state:"pending"|"admitted", eligible:true, consumed:false}
```

The product proves these fields from its current retained unsent task and reading,
including the exact executable envelope and any human Stop/withdrawal/consumed
or uncertain effect. `failedReadingId` identifies the retained diagnostic reading and is distinct from
the source-context hash. `id` is lower-case SHA-256 of UTF8
`JSON.stringify(["send-resolution",taskId,failedReadingId])`.
`contextHash` and `envelopeHash` are separate 64-hex identities. `failedReadingJson`
is the exact retained compact assessment manifest JSON string (at most 64000
characters); the native owner verifies its UTF8 SHA-256 against
`failedReadingSha256`. It is not a truncated full reading or a relabeled full-reading
hash. Its versioned shape is:

```text
{format:"send-resolution-assessment-v1", reading:{id:failedReadingId,sha256},
 contextHash,envelopeHash,
 assessment:{kind:resolutionKind,reason,question,supportingQuote,quoteSourceInputId},
 receipt:{...retained assessment receipt...}, artifacts:[{id,sha256}]}
```

`reading.sha256` identifies the full retained reading bytes, separately from the
manifest hash. Artifact digests pin retained artifact bytes. The product retains
and proves those full bytes; native admission validates the bounded manifest,
not every referenced page. All caller identities must exactly match the fresh
response. `reason` is nonempty, at most4000 characters; nullable question and quote
are at most4000 each. For `human-choice`, question and quote are nonempty and
`quoteSourceInputId` names a native-proven human input in the bound conversation;
the quote must be its exact substring. This may be a later same-task amendment.
The product proves same-task membership in its verified current context; topic
proximity alone is not that proof. The original return thread never changes to
the amendment's position. Service/model words never become his words.

A failed product read cannot silently use the caller payload. Duplicate historical
readback makes no product call and never starts another turn. This is evidence at
admission time, not a lock or a send grant across two services: the product's own
execution/cancellation/consumed-effect guard remains authoritative when an agent
later acts. No historical accepted/sent task is a live acceptance seed.

### Effect progress and completion

The same `GET /operations/:id` receipt exposes top-level
`heldMessageResolution:{version:1,state,...}` independently of provider execution:

- `pending` or `unresolved`: no exact effect proof; the product keeps its local
  resolution obligation. A terminal provider turn alone is never resolution.
- `question`: `question:{questionId,state,postId,topicId,threadRootInputId}` names
  the actual normal native question in the frozen original thread. Each resolution
  has separate question custody even when several share a turn or topic.
- `repair-handoff`: `handoff:{requestId,targetSessionId,operationId,status,outcome}`
  names an accepted work request to a non-writing engineering session.
- `repair-report`: `report:{captureInputId,requestId,topicId,state},resolved:false`
  means the existing Inbox owns the exact agent issue report; it does **not** mean
  an engineer has accepted it. Product reconciliation preserves that distinction.
- `revision` or `retired`: `completion` is positive current product evidence below.
- `fenced`: native custody no longer permits continuation. No replay follows.

A bound agent cannot declare `done` or `response` without the exact question,
verified product completion, accepted repair work or durable Inbox repair report.
Otherwise its command returns `FEATURE_RESOLUTION_UNRESOLVED`. Failure or an
involuntary provider ending remains visibly unresolved; it never causes another
semantic reread, automatic resubmission or a new session. The product must not
mark its pending/admitted obligation resolved from an admission or terminal turn.

For a real applied revision, withdrawal or consumed effect, the **same trusted
GET** may retain the immutable original evidence and return `state:"resolved"`,
`eligible:false`, plus:

```text
completion:{kind:"revision"|"withdrawn"|"consumed",receiptId,messageId,envelopeHash}
```

`consumed` is true only for kind `consumed`, otherwise false. The product proves
this exact effect from its own retained records; ordinary source/envelope drift
is insufficient. Initial admission rejects resolved records. Before accepting
`done`/`response` without existing native effect proof, the owner makes one bounded
fresh read, rechecks native custody, and retains the verified completion event.
An unavailable completion read returns `FEATURE_RESOLUTION_PRODUCT_UNPROVEN`
through the existing communication command error response (HTTP400); it leaves the
obligation open. This is not a send operation or permission to replay an effect.
