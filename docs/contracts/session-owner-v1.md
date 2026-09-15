# Unified session owner wire contract v1

Implementation contract for the approved [joint convergence](../plans/2026-09-15-unified-session-convergence.md), not a second design. Concierge is the sole catalogue, accepted-input, execution FIFO, request/reply and recovery owner. Thinkering implements authenticated surface and application/provider capability adapters.

## Transport and authentication

Concierge extends its existing owner-only Unix HTTP socket `<CONCIERGE_STATE_DIR>/requests.sock` with `/sessions/v1`. Production Thinkering currently runs as root (read-only systemd observation September 15); the root-private socket therefore needs no new public ingress or shared token. Socket availability is separate from Slack readiness. Native calls never cause Slack publication as a prerequisite.

Thinkering's existing authenticated owner HTTP session and origin guard remain its public ingress. Its trusted server adapter constructs human-origin calls after validation; public/model JSON cannot supply principal, source-session, source-run, cwd, permission or provider-binding claims. Concierge's human-admission handler is a trusted-surface operation; agent tools expose only source/run-bound operations, never that handler. Existing root access is the host trust boundary, not a claim of isolation from a malicious root process. Agent-origin actions validate a retained accepted input and its admitted run inside Concierge. Service results validate an existing obligation.

Read-only source and ChatGPT provider capabilities use a configured, owner-private Unix HTTP socket hosted by the existing Thinkering process, with the path registered by service configuration rather than a model/caller URL. This is a capability adapter, not a return bridge between session owners. Thinkering must not accept model execution outside an exact Concierge-owned run or retain its former independent session queue. The root-private peer transport assumes trusted server adapters; browser-authenticated owner context must never be copied into model-facing envelopes.

All request/response bodies are JSON, `Content-Type: application/json`. Receipt IDs, accepted input IDs, event IDs and client action IDs are strings. Canonical session IDs are `concierge:<positive integer>`; opaque versioned addresses pin the exact row and binding generation. Archive composite source keys remain evidence locators. Old Thinkering extraction UUIDs receive no migration or aliases following Tejas's reduction1789456026.592159. Native account/thread IDs are bindings, never caller-chosen session ownership.

## Common envelope and durable receipt

Mutating operations carry `clientActionId` (stable UUID or existing stable action string, never regenerated on retry). The authenticated ingress scopes it. Reusing an identity with identical immutable input returns its existing receipt; changed input returns HTTP409. Malformed input returns400, unknown identity404, unavailable capability409, and authentication failure401/403. A transport failure does not establish refusal: inspect the same operation before retry.

An accepted operation returns202 (or200 for an idempotent existing receipt):
```json
{
  "version": 1,
  "operationId": "stable-operation-id",
  "sessionId": "concierge:123",
  "inputId": "accepted-input-id-or-null",
  "requestId": "correlated-request-id-or-null",
  "runId": "exact-run-alias-or-null",
  "state": "recorded",
  "acknowledgedAt": null,
  "settlement": null,
  "returnDelivery": null,
  "error": null
}
```
`state` is recorded/queued/running/waiting/completed/failed/canceled/uncertain. Acknowledgement, native execution terminal state, request settlement, application publication and requester return delivery remain separate fields; no adapter infers “answered” from a containing run ending.

`GET /sessions/v1/operations/:operationId` returns the same durable receipt, including exact native outcome/evidence and any app-publication disposition. Read-only calls have no action ID and cannot dispatch a provider.

## Surface operations

| Route | Contract |
| --- | --- |
| `POST /sessions/v1/sessions` | Trusted authenticated human surface: `{clientActionId, provider, purpose, title?, workflowId?, firstInput?}`. Provider is codex/claude-code/chatgpt; purpose is chat/extract/transform/develop. Returns canonical session and operation receipt. Optional firstInput is accepted atomically with creation. Explicit provider intent is retained; unavailable ChatGPT never silently becomes another provider. |
| `POST /sessions/v1/sessions/:id/inputs` | Trusted surface admission of a new input: `{clientActionId, text, attachments?, evidence?, selection?, intent?, procedure?, promptRevision?, workflowId?}`. Server-issued input identity derives from authenticated ingress, not Slack or a preexisting source ID. |
| `GET /sessions/v1/sessions`, `GET /sessions/v1/sessions/:id` | Canonical session views with aliases, exact address, title/summary/project/workflow, origin/lineage/fidelity, execution/latest run, outcome/archive/suspension/read/attention, and capability truth. |
| `POST /sessions/v1/search` | `{query, limit?}` returns ranked sessions/evidence plus coverage, freshness and omissions. Historical candidates expose `interactionPolicy:"consultation-only"`, display text “Consultation only — information, no actions,” and consult availability separately before contact. |
| `POST /sessions/v1/context` | `{address, sourceId?, sourceVersion?, eventId?}`: exact dialogue window, opening goal/relevant decisions/outcome/artifacts, role/version/locator/hash evidence and omissions. |
| `GET /sessions/v1/sessions/:id/history?cursor=...&limit=...` | Stable native/source message IDs and roles, page cursor, exact binding/fidelity; no reconstruction from Slack prose. |
| `GET /sessions/v1/sessions/:id/artifacts/:artifactId` | Exact authorized artifact metadata/bytes; arbitrary filesystem paths are not client identifiers. |
| `POST /sessions/v1/sessions/:id/actions` | `{clientActionId, action}`; title/summary/model/outcome/pin/read/dismiss/archive/restore/pause/continue retain existing semantics. Read/dismiss name the observed attention generation. |
| `POST /sessions/v1/sessions/:id/stop` | `{clientActionId, runId}`; targets only that exact run, returns actual disposition/capabilities. |
| `POST /sessions/v1/sessions/:id/reconcile` | `{clientActionId, operationId}`; inspect/recover only replay-safe known effects under existing ownership; ambiguity is visible, never a blind retry. |
| `POST /sessions/v1/sessions/:id/forks` | `{clientActionId, boundary, provider?}`; exact native boundary and capability/policy checks. No retrospective policy escape. |
| `POST /sessions/v1/consultations` | `{clientActionId, address, sourceId, sourceVersion, boundary, text}`; creates one labeled information-only child, preserves immutable source. Initial/follow-up/retry/recovery retain no-tools/no-actions/no-network policy and service-only correlated returns. |
| `POST /sessions/v1/imports` | Trusted surface imports source bytes/locator through the retained source custody adapter; returns source/version/branch evidence and canonical aliases without claiming runnable ownership. |

Session views preserve native-product DTO semantics, while provider/source bindings stay explicit. No compatibility for old extraction links/drafts/history positions is assumed. Model-facing search/context/history use the same read primitives with admitted-run authority. Unsupported controls return an explicit unavailable capability and reason. Purposes and workflow metadata are retained values, not approval to rebuild the extraction/transform runner.

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
Only the exact target execution may answer. A final settles exactly this request; a whole turn ending with unanswered questions yields their unconfirmed-answer dispositions plus retained output references. One due-time inspection reports known health for unresolved work. Returns enter the canonical requester inbox/queue, waking idle sessions automatically and retaining stopped/archived/uncertain deliveries. Automatic results create no reciprocal obligation.

`GET /sessions/v1/requests/:requestId` inspects receipt/return events. `POST .../:requestId/cancel` requires source-bound authority and stable action identity. Cancellation remains distinct from native Stop.

## Observations and application callbacks

`GET /sessions/v1/events?after=<cursor>` reads durable events; `GET /sessions/v1/events/stream?after=<cursor>` streams new events using the same cursor. Event shape:
```text
{ cursor, eventId, sessionId, operationId?, inputId?, runId?,
  kind, at, payload, transient? }
```
Reconnect replays observations only, never resubmits a run. Durable admission, acknowledgement, terminal results, requests/replies, capabilities and application-publication state have ordered IDs. Transient progress may be lossy and cannot overwrite a terminal result.

The previously specified legacy workflow preparation/result callbacks are on hold under Tejas's reduction1789456026.592159. Do not implement them or import old completed receipts to preserve a runner that may be replaced. The retained invariant is that Thinkering alone owns semantic validation and idempotent publication of workspace effects. `workspace.sqlite` remains untouched by convergence, and completed model calls or publication effects are never replayed. Any later runner integration must retain stable run/output correlation and this boundary; it does not block the common session surface.

Read-only source capabilities on that same private adapter expose `/sources/search`, `/sources/context`, `/sources/import`, `/sources/history` and `/sources/refresh` with the preserved source/version/branch/event/role/locator/hash and refresh coverage. Inventory/refresh never grant execution or create another catalogue.

## Provider capability hosting

Concierge retains native Codex App Server and Claude Code execution ownership, live registry, FIFO and recovery. Reuse useful native Thinkering adapter code behind that owner as needed; Thinkering's PersistentAgentController must not remain a second dispatcher.

The existing Thinkering-hosted ChatGPT browser adapter may remain in its process as a configured capability. Concierge issues an exact admitted run to `/session-capabilities/v1/provider/start`; `provider/observe`, `provider/stop`, `provider/history` and `provider/reconcile` address only that same run/binding. The adapter retains its existing idempotent effect receipts and single browser ownership but never admits or queues a new session request itself. Exact unavailable/start/uncertain-send failure is returned without substitution. Unsupported Stop/fork/tool controls remain unavailable. Native account/conversation/message identities and policy are validated at this adapter; discovery alone cannot bind execution.

No new broker, gateway process, credential, catalogue or accepting queue is introduced. Endpoint and payload compatibility are checked with shared JSON fixtures in both repositories. This document is the one integration contract; changes are coordinated through its Git revision before callers depend on them.
