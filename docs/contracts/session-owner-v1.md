# Unified session owner wire contract v1

Implementation contract for the approved [joint convergence](../plans/2026-09-15-unified-session-convergence.md), not a second design. Concierge is the sole catalogue, accepted-input, execution FIFO, request/reply and recovery owner. Thinkering implements authenticated surface and application/provider capability adapters.

## Transport and authentication

Concierge extends its existing owner-only Unix HTTP socket `<CONCIERGE_STATE_DIR>/requests.sock` with `/sessions/v1`. Production Thinkering currently runs as root (read-only systemd observation September 15); the root-private socket therefore needs no new public ingress or shared token. Socket availability is separate from Slack readiness. Native calls never cause Slack publication as a prerequisite.

Thinkering's existing authenticated owner HTTP session and origin guard remain its public ingress. Its trusted server adapter constructs human-origin calls after validation; public/model JSON cannot supply principal, source-session, source-run, cwd, permission or provider-binding claims. Concierge's human-admission handler is a trusted-surface operation; agent tools expose only source/run-bound operations, never that handler. Existing root access is the host trust boundary, not a claim of isolation from a malicious root process. Agent-origin actions validate a retained accepted input and its admitted run inside Concierge. Service results validate an existing obligation.

Read-only source and ChatGPT provider capabilities use a configured, owner-private Unix HTTP socket hosted by the existing Thinkering process, with the path registered by service configuration rather than a model/caller URL. This is a capability adapter, not a return bridge between session owners. Thinkering must not accept model execution outside an exact Concierge-owned run or retain its former independent session queue. The root-private peer transport assumes trusted server adapters; browser-authenticated owner context must never be copied into model-facing envelopes.

All request/response bodies are JSON, `Content-Type: application/json`, except the event stream, which is `text/event-stream`. Receipt IDs, accepted input IDs, event IDs and client action IDs are strings. Canonical session IDs are `concierge:<positive integer>`; opaque versioned addresses pin the exact row and binding generation. A `runId` is the stable UUID alias of one existing Concierge turn, including when multiple accepted inputs steer into it; it is not an input ID or a provider turn ID. Internal integer turn IDs remain unchanged. Archive composite source keys remain evidence locators. Old Thinkering extraction UUIDs receive no migration or aliases following Tejas's reduction1789456026.592159 and explicit link/history reduction1789456322.159849. Native account/thread IDs are bindings, never caller-chosen session ownership.

## Common envelope and durable receipt

Mutating owner operations carry `clientActionId` (stable UUID or existing stable action string, never regenerated on retry). The authenticated ingress scopes it. Reusing an identity with identical immutable input returns its existing receipt; changed input returns HTTP409. Malformed input returns400, unknown identity404, unavailable capability409, and authentication failure401/403. A transport failure does not establish refusal: inspect the same operation before retry. Source custody and provider capabilities below reuse exact content/run identities; they do not create another client-action ledger.

An accepted operation returns202 (or200 for an idempotent existing receipt) in the route-specific wrapper below. Read-only operations return200. This is the common receipt, also returned directly by operation inspection:
```json
{
  "version": 1,
  "operationId": "stable-operation-id",
  "sessionId": "concierge:123",
  "kind": "input",
  "origin": "human",
  "text": "A synthetic pending input.",
  "createdAt": "2026-09-15T12:00:00.000Z",
  "updatedAt": "2026-09-15T12:00:00.000Z",
  "inputId": "20000000-0000-4000-8000-000000000001",
  "requestId": null,
  "runId": null,
  "state": "recorded",
  "request": null,
  "childSessionId": null,
  "admission": null,
  "acknowledgedAt": null,
  "result": null,
  "settlement": null,
  "returnDelivery": null,
  "error": null
}
```
`state` is recorded/queued/running/waiting/completed/failed/canceled/uncertain. Acknowledgement, native execution terminal state, request settlement, application publication and requester return delivery remain separate fields; no adapter infers “answered” from a containing run ending.

All illustrated receipt keys are present; absent identities and unavailable facts are JSON `null`. `kind` is create/input/action/stop/reconcile/cancel/bind/fork/consultation/request/reply; `origin` is human/agent/service and is assigned by the owner. `text` is the immutable accepted input/question/reply text, or null for a control. Timestamps are UTC ISO8601 strings with milliseconds. `request` is null or immutable accepted request metadata: human input may retain its delivery/expectedRunId, attachment IDs, application references and server-resolved `context`; bind retains `{reference}`; agent requests retain `{sourceInputId, sourceRunId, targetSessionId, requestedEffect, afterRequestIds}`. Dependencies are exact request IDs. These are accepted content and validated request values, never private provider preparation, cwd or authority. `childSessionId` is null until a fork/consultation child is durably created, then its canonical ID. It never names the immutable imported source. An input's `runId` can be populated while queued; its non-null execution `admission` proves provider admission. A bind receipt instead uses the verification admission defined below, with null inputId/runId and no provider execution. `result` is retained native output text or null; it is not proof that any request was answered or workspace effect published. Errors are null or `{code, message}` with a stable code and safe explanatory text. Execution result, settlement and return evidence remain owner facts; surface adapters must preserve fields they do not render rather than translate them into a second operation ledger.

`GET /sessions/v1/operations/:operationId` returns the same durable receipt, including exact native outcome/evidence and any app-publication disposition. Read-only calls have no action ID and cannot dispatch a provider.

## Surface operations

| Route | Contract |
| --- | --- |
| `POST /sessions/v1/sessions` | Trusted authenticated human surface: `{clientActionId, provider, purpose, title?, workflowId?, firstInput?}`. Provider is codex/claude-code/chatgpt; purpose is chat/extract/transform/develop. Returns canonical session and operation receipt. Optional firstInput is accepted atomically with creation. Explicit provider intent is retained; unavailable ChatGPT never silently becomes another provider. |
| `POST /sessions/v1/sessions/:id/inputs` | Trusted surface admission of a new input: `{clientActionId, text, attachments?, evidence?, selection?, intent?, procedure?, promptRevision?, workflowId?, context?, delivery?, expectedRunId?}`. `context` is server-resolved as specified below; browser/model bodies cannot author it. The same content/reference/context fields are available in create's `firstInput`. Server-issued input identity derives from authenticated ingress, not Slack or a preexisting source ID. |
| `POST /sessions/v1/attachments` | Trusted human surface: `{clientActionId, name, contentType, base64}`; returns `{attachment:{id,name,contentType,sha256}}` after retaining exact decoded bytes. Input attachments are these custody IDs, never filesystem paths. |
| `GET /sessions/v1/sessions`, `GET /sessions/v1/sessions/:id` | Canonical session views with aliases, exact address, title/summary/project/workflow, origin/lineage/fidelity, execution/latest run, outcome/archive/suspension/read/attention, and capability truth. |
| `POST /sessions/v1/search` | `{query, limit?, includeTools?}` (includeTools defaults false) returns ranked sessions/evidence plus coverage, freshness and omissions. Historical candidates expose `interactionPolicy:"consultation-only"`, display text “Consultation only — information, no actions,” and consult availability separately before contact. |
| `POST /sessions/v1/context` | `{address, sourceId?, sourceVersion?, eventId?}`: exact dialogue window, opening goal/relevant decisions/outcome/artifacts, role/version/locator/hash evidence and omissions. |
| `GET /sessions/v1/sessions/:id/history?cursor=...&limit=...` | Stable native/source message IDs and roles, page cursor, exact binding/fidelity; no reconstruction from Slack prose. |
| `GET /sessions/v1/sessions/:id/artifacts/:artifactId` | Exact authorized artifact metadata/bytes; arbitrary filesystem paths are not client identifiers. |
| `GET /sessions/v1/sessions/:id/details/:detailKey` | Exact retained history detail key, URL-encoded as one segment; returns `{content}`. The key resolves its provider message/version under the canonical session binding, never an arbitrary file. |
| `GET /sessions/v1/attachments/:id` | Authenticated custody read for an attachment ID returned by upload or owned history. Returns `{name,contentType,base64,sha256}` with verified retained bytes. It does not read a caller-supplied path or create another attachment store. |
| `POST /sessions/v1/sessions/:id/actions` | `{clientActionId, action}`; title/summary/model/outcome/pin/read/dismiss/archive/restore/pause/continue retain existing semantics. Read/dismiss name the observed attention generation. |
| `POST /sessions/v1/sessions/:id/stop` | `{clientActionId, runId}`; targets only that exact run, returns actual disposition/capabilities. |
| `POST /sessions/v1/sessions/:id/reconcile` | `{clientActionId, operationId}`; inspect/recover only replay-safe known effects under existing ownership; ambiguity is visible, never a blind retry. |
| `POST /sessions/v1/sessions/:id/bind` | Trusted authenticated human surface: `{clientActionId, reference:{accountScope,sessionId,anchor}}`. Explicitly verify and adopt an imported ChatGPT conversation under the same canonical session, with durable verification intent and binding-generation protection as specified below. It sends no provider input. |
| `POST /sessions/v1/operations/:operationId/cancel` | Trusted authenticated human surface: `{clientActionId}`. Cancel exactly this owner's queued human input, as detailed below. |
| `POST /sessions/v1/sessions/:id/forks` | `{clientActionId, boundary, provider?}`; exact native boundary and capability/policy checks. No retrospective policy escape. |
| `POST /sessions/v1/consultations` | `{clientActionId, address, sourceId, sourceVersion, boundary, text}`; creates one labeled information-only child, preserves immutable source. Initial/follow-up/retry/recovery retain no-tools/no-actions/no-network policy and service-only correlated returns. |
| `POST /sessions/v1/imports` | Trusted surface body `{clientActionId, name, content, scope}`; imports exact UTF8 source bytes through retained source custody and returns source/version/branch evidence and canonical aliases without claiming runnable ownership. |
| `POST /sessions/v1/sources/refresh` | Trusted authenticated host/surface control: `{provider:"chatgpt"}` returns `{refresh: Refresh[]}` from one explicit pass through the existing source refresh owner. No provider send, automatic startup pass, timer or immediate retry after rate limiting. Unknown providers and unavailable capabilities fail explicitly. |

Session views preserve native-product DTO semantics, while provider/source bindings stay explicit. No compatibility for old extraction links/drafts/history positions is assumed. Model-facing search/context/history use the same read primitives with admitted-run authority. Search includes current catalogue titles, summaries and project names; a metadata-only candidate carries its exact session view/address and an empty evidence array. Catalogue labels are never fabricated user/assistant dialogue. Equal labels remain distinct candidates, and context must resolve the selected exact address. Unsupported controls return an explicit unavailable capability and reason. Purposes and workflow metadata are retained values, not approval to rebuild the extraction/transform runner.

### Exact response wrappers and native view fields

These wrappers resolve the native owner's four integration questions in input1789456322.159849. They apply to the Unix owner API; Thinkering may retain its authenticated browser route spelling while forwarding to these routes.

| Operation | JSON response body |
| --- | --- |
| List | `{sessions: SessionView[]}` |
| Get session | `{session: SessionView, operations: Receipt[]}` |
| Create, actions, Stop, reconcile, bind | `{session: SessionView, operation: Receipt}` |
| Input, fork, consultation, queued-human cancel | `{operation: Receipt}` |
| Get operation | `Receipt` directly, without a wrapper |
| History | `{messages: Message[], nextCursor: string|null}` |
| Search | `{results: [{session: SessionView, evidence: Evidence[]}], coverage: Coverage}` |
| Context | `{session: SessionView, evidence: Evidence[], hasMore: boolean}` |
| Import | `{sessions: SessionView[], sources: Source[]}`; source-only custody creates no executable input |

Every `SessionView` has the following fields. Explicit nulls make unavailable bindings distinguishable from an incomplete response.

| Fields | Wire value and native UI mapping |
| --- | --- |
| `id`, `address`, `bindingGeneration` | Canonical `concierge:<row>`; opaque discovered address; positive integer generation. `id` is the UI session ID, never a legacy job alias. |
| `provider`, `purpose`, `mode` | Provider codex/claude-code/chatgpt. Only Thinkering's surface adapter maps wire claude-code to UI claude, and maps UI claude to wire claude-code on ingress. `purpose` is chat/extract/transform/develop; `mode` is the same retained purpose as a presentation alias. Transform must not silently become extract. |
| `nativeKey`, `runtimeThreadId` | Null or exact retained source key/native provider conversation ID. Neither is a canonical session ID nor proof of callability. |
| `nativeBinding` | `Binding` or null: the owner's retained native account/conversation/anchor at this `bindingGeneration`. Absent, unproven and source-only imports are explicitly null, even when source or runtime IDs are known. An owned ChatGPT view carries its exact retained binding after verification, including a human-explicitly bound import whose `origin` remains imported. It survives completed runs independently of operation admission; it is never inferred from `runtimeThreadId` or copied from a historical operation. |
| `title`, `summary`, `project`, `workflowId`, `model` | Title/summary strings; other fields string or null. Metadata does not authorize a workspace effect. |
| `createdAt`, `updatedAt` | UTC ISO8601 timestamps, retained across refresh/reconnect. |
| `origin`, `lineage`, `fidelity` | Origin native/imported/reconstructed. Lineage null or `{parentId, kind, boundary, sourceVersion}`; kind forked_from/reconstructed_from. Fidelity shape and enums appear in the fixtures and preserve the native DTO. |
| `outcome`, `archived`, `suspended`, `pinned`, `generation` | Outcome open/done/shipped; booleans; nonnegative attention generation. Archive/pause/read/outcome do not imply execution success. |
| `execution`, `activeRunId`, `latestRunId`, `pendingCount` | Execution idle/queued/running/waiting/completed/failed/canceled/uncertain. Run aliases are UUID or null; latest survives terminal execution. Pending count is a nonnegative integer. |
| `attention`, `needsAttention`, `unread` | `{sessionId, actorId, readGeneration, dismissedGeneration}` for the authenticated reader; booleans derived by the owner. Actor identity is a returned view, not a permitted authority field on input. |
| `capabilities` | `{send, stop, steer, fork, consult, recover, models, attachments, reason}`; control fields booleans, model/MIME lists strings, reason string or null. Unavailable remains false with an explanation. |
| `interactionPolicy`, `consultationSource` | Policy standard/consultation-only. Source null or `{sourceId, sourceVersion, boundary, packetVersion:"dialogue-v1"}`. Historical results visibly say “Consultation only — information, no actions.” |

The native adapter maps receipt `operationId` to its presentation `id` and `childSessionId` to a presentation child link; these are aliases of the same owner records. Pending input display uses receipt `text`, `request`, `createdAt`, `updatedAt` and `state`. Do not serialize the retired `SessionOperation.payload`, independent sequence/deadline machinery, or extraction job IDs into this wire contract. Session, operation, request, input, run and native-message identities remain distinct even if a fixture happens to reuse a value.

Fidelity is `{mode:"native"|"evidence", dialogue:"preserved"|"partial", branch:"verified"|"unknown", compaction:"native"|"historical-expansion"|"unknown", tools:"native"|"historical"|"missing", attachments:"available"|"partial"|"unknown", environment:"current"|"unavailable", omissions:string[]}`. An older native UI adapter may omit nullable optional workflow/consultation fields and omit the standard interactionPolicy; it must retain the wire values and must not upgrade fidelity or capability.

`action` preserves the native discriminated union: `{kind:"title"|"summary"|"model", value:string}`, `{kind:"outcome", value:"open"|"done"|"shipped"}`, `{kind:"read"|"dismiss", generation:nonnegative integer}`, `{kind:"pin", value:boolean}`, or `{kind:"archive"|"restore"|"pause"|"continue"}`. The owner clamps read/dismiss to the observed generation; a stale action cannot hide a later generation.

Queued-human cancellation authenticates the current human owner and resolves the existing operation server-side. The target must be that owner's human-origin input with no provider-admission intent and no attempted steering effect; queued or recorded-and-held inputs are eligible. Cancellation atomically wins against promotion or returns409 `OPERATION_NOT_CANCELABLE`, leaving the exact target and provider unchanged. It cancels only that input, never the active run or a sibling input. The response's operation is the target receipt with state canceled; repeated identical cancel action returns that same target. Cancel of another principal's operation returns403; agent/service inputs require their existing source-bound request/return policy. Canceling an admitted input requires an explicit native Stop decision through the exact-run route, never an automatic conversion of cancel into Stop.

Human composer semantics (native owner clarification1789457007): omitted `delivery` lets the existing coordinator choose. Explicit `delivery:"queue"` retains a later human input in the existing FIFO and must not steer the active turn. Explicit `delivery:"steer"` requires `expectedRunId` naming the observed active run; the owner checks exact current session/run and provider steering capability at admission. A stale run, Stop, unsupported steering or ambiguous send returns a retained refusal/uncertainty rather than falling back to a new queued turn. `expectedRunId` without steer is malformed. These deliberate human controls are authenticated surface operations; model tools cannot supply delivery/expectedRunId, and agent request delivery remains coordinator-owned. Repeating the same human action returns its existing receipt; it cannot retarget a later run.

Human input and create's `firstInput` accept optional `evidence:{sourceId:string,sourceVersion:string,eventId:string}`: one exact retained source reference, not an array of search results or caller-authored dialogue. The authenticated surface validates that reference against retained source evidence; the owner retains it unchanged as input metadata. Supplying it never adopts a provider binding, grants consultation capability, or selects a different branch. Search/context responses and agent request/reply evidence arrays are separate shapes. This pins the existing native input representation and corrects the illustrative array in the earlier imported-ChatGPT input fixture.

The trusted surface validates selection/intent/procedure/prompt/workflow metadata against retained workspace references before constructing an input. `ObjectRef` is `{objectId:string,revision:string}` with nonempty exact retained identities. Selection is an array of ObjectRefs; intent and promptRevision use one such reference or null. Procedure retains its native `{definition:ObjectRef,step:nonnegative integer}` shape. Other application metadata retains its native typed representation; it does not start the deferred extraction/transform callbacks.

For input or `firstInput`, the authenticated surface server resolves those exact revisions and adds `context:[{kind:"selection"|"intent"|"procedure"|"prompt",reference:ObjectRef,text:string,sha256:string}]`. Each selection reference, non-null intent, procedure.definition and non-null promptRevision has its matching kind/reference context item; unrelated context references are refused. The `text` is the server-resolved textual content for that retained revision and `sha256` hashes its exact UTF8 bytes, without trimming, Unicode normalization or JSON serialization. The browser may choose references and human message text but cannot provide resolved context bytes or hashes; the surface adapter rejects caller-authored context and constructs this envelope only after authenticated workspace validation. A missing/unavailable revision is refused at that surface before owner admission, never silently replaced by the latest revision. Agent/model request tools cannot supply this human context envelope or use it to grant workspace authority.

The common owner verifies context shape, kind/reference correspondence and hashes, retains its exact order and bytes with the accepted input, and includes them as labeled reference material in provider preparation. It does not reread the workspace, synthesize context from an object ID, or invoke the held extraction runner. Its execution prompt hash covers the complete prepared prompt, including these retained bytes. `receipt.text` remains the original human message; references/context remain separately inspectable in `receipt.request`. Identical action/content/context returns the same input and pinned bytes even if the workspace later changes. The same action with changed references, context bytes, hashes or order returns409 `IDEMPOTENCY_CONFLICT` without retargeting or another provider admission. Missing context for supplied references returns400 `WORKSPACE_CONTEXT_REQUIRED`; mismatched reference/hash returns409 `WORKSPACE_CONTEXT_MISMATCH`.

An attachment upload is authenticated owner custody, not an executable operation. Receipt ID/hash/name/type are stable on an identical action; conflicting bytes/metadata return409. The accepted input pins authorized custody IDs before preparation; provider handoff verifies decoded bytes against those pins. Session artifact responses are `{name,contentType,base64,sha256}` and require an artifactId returned by that session's history/result. Native detail/artifact reads survive completed runs and do not replay work.

Public source import validates `clientActionId` at authenticated ingress; this is source custody, not an executable accepted-input operation. The owner forwards only `{name,content,scope}` to the private `/sources/import` capability. Exact content/version/branch identities supply import deduplication, as specified by the source-custody exception above; importing bytes creates no additional client-action ledger, provider run or workspace replay.

### Explicit imported ChatGPT binding

An imported source or input `evidence` alone never acquires a runnable binding. The explicit human bind route accepts an exact source anchor already retained under that canonical session: sourceId, sourceVersion, branch, messageId and textHash must all match. The owner records a `kind:"bind"`, `origin:"human"` operation before capability verification. Its immutable `request` is `{reference}` and its verification `admission` is `{bindingGeneration,reference}`, pinned to the owner's current generation; inputId/runId/requestId remain null. The owner supplies that operationId and generation to the private capability bind call. The peer independently reads this exact owner operation and current session/source, verifies the human bind intent and pins, and then verifies the signed-in native account, original conversation and exact browser anchor. It never requires an already-populated nativeBinding as proof of the first bind, and cannot substitute an old execution admission or caller-supplied receipt.

After verification, the owner adopts the returned exact binding only if the pinned generation still holds and the session is eligible for binding. Active native work cannot be retargeted. Adoption changes bindingGeneration from g to g+1 exactly once, invalidating the prior opaque address while preserving the canonical session ID, imported provenance, source evidence and lineage. The bound ChatGPT branch uses standard interaction policy and actual ChatGPT capabilities; this does not relax the policy of any distinct information-only consultation child. Binding itself admits no provider turn and replays no historical tool or workspace effect. The completed control receipt has null result; its SessionView carries the adopted nativeBinding and current capability truth.

An identical action/reference returns its existing operation (200) without another generation advance or verification. A changed reference under the same action returns409 `IDEMPOTENCY_CONFLICT`. A generation change during verification returns409 `BINDING_CHANGED`, preserving a failed control receipt and leaving the newer binding untouched. Unavailable capability, wrong account or mismatched source/version/branch/event/hash returns a concrete refusal with no binding adoption. A lost verification connection does not adopt a binding; the retained operation remains inspectable. Input evidence, source search and ordinary input never call bind implicitly.

These explicit bind and server-resolved workspace context semantics implement the native-owner clarification1789459294. They do not activate legacy extraction/transform callbacks.

## Agent request/reply and return

`POST /sessions/v1/requests`:
```text
{ clientActionId, sourceInputId, sourceRunId, targetAddress,
  text, attachments?, evidence?, requestedEffect, afterRequestIds? }
```
Concierge resolves/validates the source principal/session/run from its retained input. Atomic acceptance persists the request and mandatory return obligation before dispatch. Requested effect is informational or work within existing authority; a peer message cannot grant workflow write/deployment permission. Exact existing request dependencies wait outside provider FIFO.

`POST /sessions/v1/requests/:requestId/replies`:
```text
{ clientActionId, sourceInputId, sourceRunId, kind: partial|final, text, evidence? }
```
Only the exact target execution may answer. A final settles exactly this request; a whole turn ending with unanswered questions yields their unconfirmed-answer dispositions plus retained output references. One due-time inspection reports known health for unresolved work. Returns enter the canonical requester inbox/queue, waking idle sessions automatically and retaining stopped/archived/uncertain deliveries. Live steering is permitted only into the original asking run identified by the retained request; a later run receives returns through FIFO, including when that later run handles an earlier partial answer. Automatic results create no reciprocal obligation.

`GET /sessions/v1/requests/:requestId` inspects receipt/return events. `POST .../:requestId/cancel` requires source-bound authority and stable action identity. Cancellation remains distinct from native Stop.

## Observations and application callbacks

`GET /sessions/v1/events?after=<cursor>` reads durable events; `GET /sessions/v1/events/stream?after=<cursor>` streams new events using the same cursor. Event shape:
```text
{ cursor, eventId, sessionId, operationId?, inputId?, runId?,
  kind, at, payload, transient? }
```
Reconnect replays observations only, never resubmits a run. Durable admission, acknowledgement, terminal results, requests/replies, capabilities and application-publication state have ordered IDs. Transient progress may be lossy and cannot overwrite a terminal result.

`GET /sessions/v1/events` returns `{events, nextCursor}`; cursor/nextCursor are opaque strings (null before any event). SSE uses each event's cursor as its `id`, `event: session`, and its complete JSON event as `data`. Optional sessionId/runId query filters select exact owned aliases and do not change the global cursor. Consumers retain the last processed cursor across disconnect; they never convert reconnect into input admission. The following two kinds provide the existing native AgentObservation/AG-UI view without another run stream owner:

- `kind:"run"`, payload `{run:RunView}`. RunView is `{id, threadId, provider, purpose, state, createdAt, updatedAt, sessionId, turnId, error, worktree, changedFiles, verification, selection, nativeBinding}`. Here id is the common run UUID and threadId the canonical session ID; the nested sessionId/turnId retain the native provider session/turn identity (nullable). State is queued/running/completed/failed/canceled/uncertain. Worktree is a trusted configured path or null, never an authority accepted from a caller; changedFiles is string[]; verification is null or `{state:"not-run"|"passed"|"failed",fingerprint:string|null}`; selection is pinned object references; nativeBinding is Binding or null. Error is a safe string or null, matching the existing run UI.
- `kind:"message"`, payload `{message:Message}` with exact stable message ID, common run alias on the envelope, native turn/tool/detail/rich-content fields retained and submission attribution as specified below. A proven native input match uses that input's ID for event inputId/operationId, including steering. The surface adapter can emit `{kind:"run",run}` or `{kind:"message",message}` after provider spelling conversion. A terminal run event remains terminal when a delayed transient progress event arrives.

These are views of existing turns, not a new run store. Existing UI `/api/agents/runs/:id/connect` may adapt this stream using the exact run UUID and a retained cursor. History/tool parts obtain detailKey from the matching Message; original provider detail and artifact IDs are not guessed from rendered prose. Retired job history routes/UUIDs are not aliases of this new run view.

The previously specified legacy workflow preparation/result callbacks are on hold under Tejas's reduction1789456026.592159. Do not implement them or import old completed receipts to preserve a runner that may be replaced. The retained invariant is that Thinkering alone owns semantic validation and idempotent publication of workspace effects. `workspace.sqlite` remains untouched by convergence, and completed model calls or publication effects are never replayed. Any later runner integration must retain stable run/output correlation and this boundary; it does not block the common session surface.

### Source capability bodies

These are POST routes on the configured Thinkering private socket, not on the Concierge socket. They adapt the existing source custody/index/refresh implementation. Import and refresh may retain immutable source bytes and update the existing index, but never accept executable work, publish workspace effects, or create a second session catalogue. A `scope` is an import namespace, not authenticated provider-account authority. Paths and upstream browser URLs come from configuration or verified provider responses, never caller-selected network targets.

| Route | Request body | Response body |
| --- | --- | --- |
| `/sources/search` | `{query, includeTools, limit?}` | `{sources: Source[], matches: SourceEvidence[], complete, reason, indexedAt, refresh: Refresh[]}` |
| `/sources/context` | `{sourceId, sourceVersion, branch, eventId?, limit?}` | `{source: Source, evidence: SourceEvidence[], hasMore}` |
| `/sources/import` | `{name, content, scope}`; content is the exact UTF8 source text | `{sources: Source[]}`; repeated identical bytes preserve source/version/branch identity |
| `/sources/history` | `{sourceId, sourceVersion, branch, cursor, limit}` | `{messages: Message[], nextCursor}`; each message includes its pinned `source` evidence |
| `/sources/refresh` | `{provider:"chatgpt"}` | `{refresh: Refresh[]}`; one explicit pass through the existing coalesced refresh owner, with no execution admission or new scheduler |

`Source` is `{id, provider, scope, nativeId, synthetic, title, createdAt, project, version, branch, messages, omissions, consultation}`. IDs/branch are opaque source locators; provider uses the wire provider spelling. `project` is string or null, `synthetic` boolean, `omissions` string[], `messages` SourceEvidence[], and consultation is the pinned dialogue-v1 source reference or null. A source does not contain a new canonical session ID. `SourceEvidence` is `{sourceId, sourceVersion, eventId, ordinal, role, locator, textHash, text}` with role user/assistant/tool and nonnegative ordinal. The owner adds its canonical `sessionId` to form surface `Evidence`. It never mistakes the source adapter's composite key for a canonical ID.

`sourceVersion`/`Source.version` is lowercase SHA256 hex of the exact retained UTF8 source bytes, including whitespace. `textHash` is SHA256 of the exact UTF8 `text`, with no trim, newline conversion, Unicode normalization or JSON serialization. Source-version, branch, event, role, locator and text hash stay together. Context/history must reject missing or changed pinned evidence (404/409); they cannot silently substitute the latest version or a nearby branch. Cursor is null for the first page and otherwise the returned opaque string, valid only for that source/version/branch. A page with missing assets or incomplete ancestry preserves its omissions. The source fixture includes literal source bytes so consumers can independently verify hashes.

`Refresh` matches native source coverage: `{accountScope, state, inventoryComplete, discovered, saved, indexed, failed, reportedTotal, lastAttemptAt, lastCompleteAt, reason}`. State is idle/refreshing/partial/failed; counts are nonnegative integers; reportedTotal is integer or null; account/timestamps/reason may be null. An idle refresh is not complete unless inventory and saved/indexed counts prove it. Surface `Coverage` is `{complete, indexedAt, sources, reason, refresh, omissions}`; `sources` is a count, indexedAt/reason nullable, omissions string[]. Search adds no tools or contact capability merely because an evidence result exists.

`Message` retains the native history fields `{id, role, content, tool, phase}` (tool/phase nullable), and optional `detailKey`, `submissionId`, `toolCallId`, `turnId`, `attachments`, `richContent`, `source`. Message/native-turn IDs retain provider identity. For a Codex/Claude user message matched to exact retained native identity and prepared input bytes, `content` is the immutable accepted text, `submissionId` is its accepted input ID and attachments are its retained custody descriptors; generated authority, context and attachment-path scaffolding stays in raw execution evidence. This same projection applies to history and message events. Unmatched native and unbound source messages remain unchanged; JSON inside content cannot claim another input. For owned ChatGPT input, `submissionId` remains the common run UUID used as its provider effect ID. History attachment descriptors are `{id,name,contentType}`. Rich content preserves the existing version1 `parts` union (markdown/writing/file/unsupported); a file's native path is evidence, not permission to read a host path. The compatibility examples include stable source and native message identities.

## Provider capability hosting

Concierge retains native Codex App Server and Claude Code execution ownership, live registry, FIFO and recovery. Reuse useful native Thinkering adapter code behind that owner as needed; Thinkering's PersistentAgentController must not remain a second dispatcher.

The existing Thinkering-hosted ChatGPT browser adapter may remain in its process as a configured capability. The adapter retains its existing idempotent effect receipts and single browser ownership but never admits or queues a new session request itself. Exact unavailable/start/uncertain-send failure is returned without substitution. Unsupported Stop/fork/tool/consultation controls remain unavailable. Native account/conversation/message identities and policy are validated at this adapter; discovery alone cannot bind execution.

### Exact run verification and ChatGPT bodies

All routes below are POST on the configured Thinkering socket, prefixed `/session-capabilities/v1/provider/`. They are trusted owner-to-capability requests, never browser/model forwarding of provider fields. `RunRef` is `{operationId, sessionId, inputId, runId}`. Canonical sessionId, accepted inputId and run UUID are independent identities. `Binding` is `{accountScope, sessionId, anchor?}`, where nested sessionId is the **native ChatGPT conversation**. An anchor is `{sourceId, sourceVersion, messageId, branch, textHash}` and binds the exact retained evidence. The adapter validates the signed-in account, native conversation and anchor using its existing provider reads. An import scope alone does not pass that validation.

Before the first send for a run, the common owner receipt exposes this immutable admission object:

```text
admission = {
  provider: "chatgpt", purpose: "chat", inputId, runId,
  bindingGeneration, admittedAt, promptHash, model,
  attachments: [{id, name, contentType, sha256}],
  policy: "standard", nativeBinding: Binding|null
}
```

`admittedAt` is UTC ISO8601; model is string or null; bindingGeneration is a positive integer; promptHash and attachment sha256 are lowercase SHA256. `promptHash` covers exact UTF8 prompt bytes by the same no-normalization rule as textHash. Attachment hashes cover decoded bytes, not base64 spelling. The common owner computes the admission pins from retained, prepared input and trusted configuration; request body claims cannot set or override them. No `cwd`, filesystem path, authority/principal, permission, browser URL, credential, callback or tool definition is accepted in providerInput. The adapter supplies any required local cwd from trusted configuration. This preserves the useful native provider seam without reviving the old controller's queue.

| Route suffix | Request body | Response body |
| --- | --- | --- |
| `start` | `RunRef` plus `{providerInput:{id, prompt, purpose, model, attachments, policy, nativeBinding}}` | `{runId, state, acknowledgedAt, nativeBinding, result, error}`; 202 once the existing provider effect is durably recorded, 200 for existing-effect inspection |
| `observe` | `RunRef` plus `{after: string|null}` | `{runId, events, nextCursor, complete, result}`; observes the existing effect only |
| `stop` | `RunRef` | 409 `{error:{code:"CAPABILITY_UNAVAILABLE",message},capability:"stop",runId}` for current ChatGPT; never reports native cancellation from stopping local observation |
| `reconcile` | `RunRef` | Same provider receipt as start,200; inspect exact existing receipt/binding, never resubmit uncertain text |
| `history` | `{sessionId, bindingGeneration, binding, cursor, limit}` | `{messages: Message[], nextCursor}` |
| `detail` | `{sessionId, bindingGeneration, binding, detailKey}` | `{content}` for the exact native message/version key from history |
| `bind` | `{operationId, sessionId, bindingGeneration, reference:{accountScope, sessionId, anchor}}` | `{binding: Binding}` after independently verifying the exact human bind operation/admission plus native account/conversation/branch/event/hash; operationId names a bind control, never an execution run |
| `snapshot` | `{sessionId, bindingGeneration, binding}` | `{name, content, scope, branch, sourceVersion}`; sourceVersion hashes exact content |
| `artifact` | `{sessionId, bindingGeneration, binding, messageId, path}` | `{name, contentType, base64, sha256}`; validates exact native message/file reference before download |

In start, providerInput.id **equals the common run UUID**, preserving the native provider's stable UUID effect identity. Attachments are `{id, name, contentType, sha256, base64}`; bytes match the owner admission descriptors, with order preserved. Unsupported purpose/model/attachment/policy is explicit capability refusal, never provider substitution. The current ChatGPT adapter supports chat/work model selectors and image PNG/JPEG/WebP attachments; it does not support native Stop, steering, fork, session tools or enforced information-only consultation. Those limitations remain capability truth until the adapter proves otherwise. A source may still be consulted through a distinct child using a provider that enforces the required policy.

The capability adapter obtains `GET /sessions/v1/operations/:operationId` itself over the configured Concierge socket. It never accepts a client-supplied copy of the receipt as proof. For a new send it checks: the receipt has exactly RunRef's operation/session/input/run identities; state is running with non-null admission; admission's input/run/provider/purpose/model/policy/binding/attachment descriptors and exact prompt hash match; the current owner session's activeRunId and bindingGeneration still equal that admission, its provider is chatgpt, and it is neither archived nor suspended. A Stop/cancel/owner-loss disposition must prevent a new send. This is an extension of the existing execution owner; the capability cannot acquire work by finding a UUID in history. A missing receipt, changed generation, mismatched prompt/attachment/account/anchor or noncurrent admission yields409 before a browser send. An unavailable owner yields503 without creating an effect. Owner-authenticated execution context remains a host trust boundary, not a model-callable endpoint.

For an already-started effect, the same immutable identity and pins select its existing native receipt. `observe`, `reconcile`, and an identical repeated start can return retained evidence even after the owner run is terminal, stopped or no longer active; they do not require state running and cannot send again. An uncertain/dispatched effect remains uncertain unless the existing native receipt proves acknowledgement/result. Read-only bind/history/detail/snapshot/artifact likewise do not require an active run: they read the current `SessionView` through the configured owner socket and validate its `bindingGeneration` and retained `nativeBinding` or exact source anchor under trusted owner authority. A runtime thread ID alone cannot prove the account or anchor, and an old operation's admission cannot substitute for the current session binding. Null `nativeBinding` preserves absent/unproven/import-only status; read-only bind verification against retained source evidence may return a binding for the owner to adopt. Bind never updates the canonical row itself. The owner resolves public artifactId to the exact retained native message/path; the capability rejects a path absent from that message. It never treats `path` as an arbitrary host filesystem path.

The retained `SessionView.nativeBinding` field is the bounded native-owner amendment from input1789458885.631629. It adds no endpoint, catalogue or execution authority.

Provider receipt state is recorded/running/completed/failed/canceled/uncertain. `acknowledgedAt` requires the existing native exact user-message acknowledgement. `result` is null or the native `{sessionId, turnId, text, state, error, nativeBinding}` result with completed/failed/canceled/uncertain state; nested IDs refer to provider identities. It cannot settle an unrelated session request. Observe events are `{cursor,eventId,runId,inputId,kind,at,payload}`, with kind identity/message/result; payload retains native identity/message/result fields. Cursors/event IDs belong to this exact effect and replay observations only. A lost observer connection never starts a provider. No idle polling is introduced; active observation uses the existing provider's liveness behavior and stops at terminal or explicitly parked uncertainty.

No new broker, gateway process, credential, catalogue or accepting queue is introduced. Endpoint and payload compatibility are checked with shared JSON fixtures in both repositories. This document is the one integration contract; changes are coordinated through its Git revision before callers depend on them.

## Shared compatibility fixtures

The JSON files in [session-owner-v1/](session-owner-v1/) are synthetic consumer/producer examples, not captured user data or a second API definition. Each has `{version:1,cases:[{name,request:{method,path,body?},response:{status,body},...}]}`. Wrapper and field types are normative; example IDs, opaque addresses, timestamps, titles and counts are sample values. Fields such as `ownerReceipt`, `ownerSession`, `ownerContext`, `existingProviderReceipt`, `existingOwnerReceipt`, `verificationIntent`, `sessionAtAdoption` and `expect` supply test preconditions/assertions, never additional HTTP request fields or caller-supplied authority. Consumers execute their own adapter against these exchanges and reject mismatched pins. Successful fixture parsing alone is not runtime or live acceptance.

- [surface.json](session-owner-v1/surface.json): response wrappers, complete native metadata, pending receipt, child identities, cancel, deliberate human delivery, attachment custody, run/message events and historical evidence without old job aliases.
- [sources.json](session-owner-v1/sources.json): exact source bytes/hashes, source search/context/import/history/refresh and incomplete coverage.
- [chatgpt.json](session-owner-v1/chatgpt.json): start and owner verification, exact native bind/history/snapshot/artifact, observation, unsupported Stop, mismatched pins, terminal inspection and no uncertain replay.
