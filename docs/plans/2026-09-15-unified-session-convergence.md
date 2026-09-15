# Unified session convergence — joint proposal

Status: approved for implementation by Tejas, relayed in input 1789455269.499469. The extended removal test remains required. The latest reduction, input 1789456026.592159, removes migration of old Thinkering extraction/transform bookkeeping entirely and supersedes the earlier backup/mapping and rollback proposals. Concierge edits this one document; the Thinkering native owner's incorporation amendment is input 1789454508.918469 (attachment F0C1F24EF1V). The independently approved hop-cap removal, overdue-notice tests and documentation repair continue separately.

## Decision and source

Tejas rejected the separate session universes in C0BNN5K4JSJ, root 1789432448.682319, input 1789454208.850399. The exact source is preserved with the attached routed request and accepted turn 1124 in the review packet. His requirement is one session universe: Concierge owns session identity and routing over native provider runtimes; Thinkering becomes the primary surface, and removing Slack must leave session sending and receiving functional. The reviewing session's interpretation is distinguished from his words. Its follow-up 1789454291.895059 asks both owners for this joint proposal before a speculative rewrite.

This supersedes the Thinkering-owned catalogue recommendation and the proposed owner-to-owner bridge. It does not discard existing code, replay historical tools, activate a second provider owner, or authorize migration of running work.

## Verified starting points

Concierge base 50da5b45620fbd8c1077a319aa00f268e964393e:
- `sessions.id` is the integer owner of `turns.session_id`, FIFO, provider binding and lineage. The session table requires Slack channel/root; turns require a Slack source timestamp. This is a schema dependency, not merely UI naming.
- Communication addresses encode version 1 plus exact session/channel/root. Ask provenance comes from a durably claimed Slack turn or steering input. Request and return records depend on routed Slack publication before native admission.
- Atomic return obligations, per-request replies, acknowledged steering, held/uncertain returns, exact dependencies and due times are already implemented. These owners survive convergence.
- A read-only September 15 production inventory found no repeated non-null `(provider_id, agent_session_uuid)` binding across session rows. This is current evidence, not permission to merge future matches or infer lineage.

Thinkering baseline 45bc303, with separately identified uncommitted consultation work:
- Native-created catalogue entries use UUIDs; imported exact branches use provider/scope/native/composite-branch keys. Entries retain runtime thread ID, explicit lineage and fidelity. Its `SessionOperation` store owns a second accepted-input queue and request/reply state today. Import scope is a source namespace, not proof of provider account authority.
- Accepted native input UUID equals its controller run UUID. Model tools derive source session/run from that admitted execution. User payloads cannot choose those authority fields.
- Native search, imports, session UI and provider adapters exist. Their existence does not establish completed Mac consultation product acceptance or authorization to keep a separate catalogue.

The preservation/adaptation inventory below incorporates the native owner's amendment. Claims about uncommitted work remain source evidence, not release claims.

The native owner's read-only production observation on September 15 identified release `7b8db83d32cc48cdd610edf5c42444010e94ab1a`, 140 catalogue rows, 148 provider-bound threads and 149 completed receipts, with zero session operations. Tejas explicitly removed preservation of those job records in input 1789456026.592159: “We don't need to save those. Those are not useful information here We're gonna replace that anyways with a router agent doing their job here.” They are not imported or mapped into the unified catalogue. The valuable notes and published proposals live separately in `workspace.sqlite`; that store remains untouched by convergence and completed work must never be replayed into it.

## One identity and one owner

Keep the existing Concierge `sessions` ledger as the canonical catalogue and execution owner. Its existing `sessions.id`, exposed with a versioned Concierge namespace, already identifies an exact branch. No second UUID catalogue is needed. Preserve every integer ID, turn foreign key, provider UUID, fork point and branch relationship. A new opaque address version contains that row identity and any necessary native binding generation, with no Slack channel/root. Changing a native binding cannot silently retarget an old address.

Slack channel/root, native provider/account/thread tuple and imported source/version/branch are bindings or source locators of that canonical session. Old Thinkering extraction records receive no aliases. Evidence similarity does not establish identity. An imported source can be indexed without a runnable binding; consultation creates a distinct child with explicit reconstruction fidelity. Compaction remains a checkpoint, not a fork.

The first identity change backfills surface-independent bindings/source-event mappings and permits a native session/source event without Slack. Every running turn continues using its current integer owner. Removing mandatory Slack columns requires an explicit schema and read-compatibility migration; placeholder channels, empty strings and fabricated timestamps are prohibited. An unused mapping table does not establish identity independence.

Imported archive composite branch keys remain exact source locators. A newly admitted branch receives one canonical record under Concierge ownership. A known provider tuple alone is insufficient to take a live writer: prove the exact native binding before admission. An import namespace or matching native UUID with unproven account/branch is not that proof. Ambiguous ownership remains non-callable and visible; no generic auto-adoption by search.

Do not spend on old extraction `/agents` links, drafts or history-position compatibility without Tejas's confirmation. New surface drafts remain browser-owned. Workspace notes, proposals and published effects remain intact: never replay completed extraction/transform calls or reapply their results. Duplicate archive replicas may share a source identity only with exact provider/account/branch evidence; title/path similarity and unproven account scope cannot merge branches.

## One addressed interaction contract

All surfaces and agent tools use the same versioned contract. Wire spelling is finalized with the native owner's amendments; semantics are fixed:

```text
admitHumanInput(authenticatedSurface, clientActionId, {
  targetAddress | createSession,
  content, attachments, evidence, requestedEffect
}) -> { acceptedInputId, sessionId, requestId, receipt }

submit {
  sourceInputId, actionId,
  targetAddress,
  content, attachments, evidence, requestedEffect,
  replyTo?, exactDependencies?
}
receipt {
  requestId, acceptedInputId, targetSessionId,
  admission, execution?, settlement?, returnDelivery?
}
reply {
  sourceInputId, actionId, requestId,
  kind: partial | final,
  text, evidence[]
}
```

For a new human input, authenticated surface admission atomically issues/validates its accepted-input identity from the authenticated ingress and stable client action. It does not presuppose a Slack input or a prior accepted source ID. Body actor fields are not authentication. Agent-origin ask/reply derives authority from that retained input and admitted run; service returns derive it from the exact obligation. A native source never manufactures Slack timestamps. An immutable source/action pair deduplicates one payload. The accepted request and mandatory return obligation commit together before any dispatch. Replies have stable event identities as well as exact request correlation.

Create/list/get/search/context/history, exact controls and read-event operations target the same owner. Thinkering's existing authenticated HTTP surface calls these operations; it does not implement a new owner behind its route names. Surface read/attention/outcome semantics remain available with exact catalogue identity and capability receipts. Explicit ChatGPT intent uses the existing provider-selection policy. Ordinary language requesting a ChatGPT session reaches authenticated native creation and first-input admission through this same owner, without Slack publication or another admission path.

The sender chooses the exact session and intended effect, not steer/resume/reconstruct. The existing single admission owner decides live steering versus FIFO, using exact active-interaction evidence where available. Archived, deliberately stopped or ambiguous executions preserve the request/result with visible disposition. Dependencies wait outside the provider queue. No requester process must stay alive to receive its result.

Partial and final replies belong to one request. General turn completion cannot answer unrelated questions. Events return to the sender's durable session inbox even when idle; automatic events create no reciprocal obligations. One due-time inspection reports known liveness/Stop/admission evidence, with no infinite silent wait or automatic uncertain replay. Cancellation and Stop are commands against exact requests/runs, never permission to assume success.

## Slack becomes an adapter

Native accepted inputs and session events become the admission and return identities. Slack's existing claim ledger remains its inbound adapter deduplication source. It resolves the exact visible root and selected session, then supplies that authenticated input to the shared contract. Existing explicit fork/comparison isolation and shared-channel rules remain adapter behavior. `buildQueuedTurnInput` and `startTurn` currently require Slack claims: adapt that preparation/admission boundary instead of bypassing it with another runtime.

Routed Slack publication remains available for human-visible routing, with its existing exact source/action receipt. It is no longer the prerequisite for session-to-session delivery. Slack projects already-recorded request/result facts; projection failure cannot lose an accepted native interaction. Thinkering's authenticated HTTP adapter calls the common owner API. It may cache read models and retain unsent drafts, but owns no second accepting queue or operation ledger.

Removal test: with Slack transport absent, discover and resume a real session originally created through Slack, then exchange correlated questions and partial/final answers in both directions with a newly created Thinkering session. The old branch must run and reply from its retained native history without a Slack callback, credential or publication. Its historical Slack bindings remain provenance, not an execution prerequisite. Also create two sessions without Slack bindings and verify new-to-new exchange, stop/restart the requester and recover the same return exactly once. Existing Slack-root regression cases must pass unchanged while Slack is enabled. New-to-new alone, a synthetic UUID or an owner-to-owner bridge does not satisfy the removal requirement.

## Keep, adapt and retire

| Existing work | Converged disposition |
| --- | --- |
| Concierge session/turn IDs, FIFO, input acknowledgement, Stop, recovery and ambiguity | Keep as the execution authority; add surface-independent addresses and native input references without renumbering old records. |
| Concierge communication request/event records, due time and correlation | Keep; adapt source and return addressing to canonical session/input IDs. |
| Concierge router publication/search | Keep as Slack adapter and one discovery source; preserve exact bindings for old requests. Archive discovery joins the same replaceable evidence interface. |
| Thinkering catalogue metadata, lineage, fidelity, read/attention state | Keep surface behavior over the sole catalogue. Do not import the discarded extraction catalogue. New drafts remain browser-owned. |
| Thinkering SessionService/SessionOperation/SqliteSessionStore queue, timers and correlated returns | Retire as independent authorities. Replace surface and model-tool calls with the shared contract; no historical operation import or second accepting writer. |
| Thinkering PersistentAgentController and direct provider dispatch | No independent session execution owner remains. Hold adaptation of extraction/transform dispatch pending Tejas's runner decision; preserve the workspace publication boundary and prohibit replay. |
| Thinkering native session workspace, drafts, navigation/history rendering | Keep and adapt to canonical IDs/capability receipts. Old extraction link/draft compatibility is pending explicit confirmation, not an assumed deliverable. |
| Archive parser, FTS reader, immutable snapshots and source evidence | Keep behind a read-only discovery/context port; originals remain immutable and evidence retains role/version/cutoff/hash. |
| Codex/Claude native adapters, workflow instruction/directory adapter | Concierge retains provider execution. Keep existing workflow data and workspace mutation authority in Thinkering. Do not invest in legacy runner preparation/result compatibility until its future is confirmed. Peer input grants no human instruction-write authority. |
| ChatGPT exact account/conversation browser adapter | Keep browser/parser/content/artifact and effect receipts with exact original account/conversation/message checks, one browser owner, no reconstruction or outbound model tools; unsupported controls remain unavailable. Explicit natural-language ChatGPT choice stays in common provider policy. Authenticated creation and first input, including host-triggered starts, use the same shared owner path. Unavailable, start and uncertain-send failures remain visible as ChatGPT failures, never silent provider substitution. Read-only inventory and snapshot/background refresh feed existing transcript/index custody with the same provenance and visible refresh state; they grant no execution and create no catalogue. Verified independent read-only handoff `9f7850bb535387b69129707bd87790c54d3b816d` on Thinkering `worktree-chatgpt-native` passed32tests: inventory689, captured207conversations/231branches, remaining482 explicitly partial after rate limiting. Retained source bytes remain readable without browser login. This ingestion is complete independently; creation/first input remains the convergence dependency. No ChatGPT MCP endpoint, outbound model session tools or Slack response feature. Source relay1789457351.955799 preserves the exact human-input packet1789454749.694639/1789454944.605889. |
| Mac reconstructed consultation | Preserve a labeled information-only child in the common catalogue. Initial, follow-up, retry and recovery enforce no actions, code changes, commit/push, network, tools or arbitrary outbound session messaging. Only the service returns correlated results. A native fork unable to preserve that policy is unavailable. |
| Thinkering regression and live acceptance tests | Adapt to the common owner while retaining behavioral oracles. Earlier standalone native receipts prove components, not convergence or release. |
| Proposed Thinkering-to-Concierge peer bridge | Do not build: it would preserve the rejected second catalogue/contract. |

## Smallest safe change and complete acceptance

The smallest first code change removes Slack as a prerequisite for session identity and source-event acceptance within Concierge's existing ledger. Backfill exact adapter mappings, preserve old addresses, and create/resolve a session plus source event with Slack absent. Prove backfill idempotency, no old ID/lineage/turn changes and unchanged old address resolution. This is an implementation ordering step inside one full convergence delivery, not a separately advertised completed product.

The convergence delivery makes native input/admission/return independent of Slack, points Thinkering at the shared catalogue and contract, and retires its duplicate accepting owner. There is no extraction-record migration, alias inventory or duplicate-claim cutover check. Keep raw archive source snapshots immutable; do not replay historical tools or silently retry unresolved effects. No existing Concierge turn is reassigned.

The confirmed production session operation count is zero. No old dispatcher rollback/quiesce/restore subsystem or store migration is required. The native owner already retained a private snapshot, but it is not an acceptance dependency. Do not delete or modify `/var/lib/thinkering/production/workspace/workspace.sqlite`; never replay completed extraction/transform calls or republish their proposals. The future router-agent replacement of those jobs is a separate decision; hold compatibility investment while common session work proceeds.

Acceptance for the whole approved change:
- Existing Slack steering, shared sessions, fork/comparison isolation, FIFO/claim ordering, terminal delivery and restart recovery remain intact.
- Existing Concierge conversations and newly created native branches appear in one catalogue with exact lineage and capability truth. Discarded Thinkering extraction rows are excluded by Tejas's reduction.
- Thinkering starts, sends, stops and receives results from canonical sessions without Slack, including cross-provider request/reply and an idle requester. An originally Slack-created session remains discoverable/resumable and exchanges correlated partial/final answers with a newly created Thinkering session in both directions with Slack absent. Explicit ChatGPT intent reaches a real authenticated ChatGPT create/first input, or visibly reports its unavailable/start/uncertain-send failure without substituting another provider.
- Duplicate fast replies cannot outrun return registration; multiple questions in one execution remain independently correlated.
- Restart after each relevant durable/native boundary preserves settled facts and parks uncertain effects without invoking the model twice.
- Archive evidence is searchable in the same discovery operation; imports remain non-callable unless an explicit capability exists. Historical candidates show “Consultation only — information, no actions” and `interactionPolicy: consultation-only` beside their exact address, with availability represented separately. C1/X1 Mac consultation answers and same-child follow-up retain exact source/branch citations and enforce forbidden actions at runtime. ChatGPT uses its original browser path.
- Evidence covers preserved Concierge identity and exact runtime boundaries; one final whole-delivery source-fidelity audit covers both owners' original requirement captures and later human corrections.
- Workspace notes and published proposals remain untouched. No completed extraction/transform provider call is replayed and no completed workspace effect is reapplied. No old extraction catalogue migration or alias check is required.

Both owners have contributed to this proposal, including native amendments 1789454508.918469 and 1789454645.572709, now narrowed by 1789456026.592159. The shared wire contract lives at [session owner v1](../contracts/session-owner-v1.md); no second queue, gateway or extraction-data reconciliation is required.

Source pointers: Concierge `bot/src/state.ts`, `session-communication.ts`, `queued-turn-execution.ts`; Thinkering pinned baseline `45bc303a6d80c6ca3eee3ea907a4357f722c9b32`, `scripts/application.mjs`, `packages/application/src/session-service.ts`, `session-ports.ts`, `agent-controller.ts`, `packages/adapters/src/session-store.ts` and `agent-projection.ts`. The native owner's uncommitted consultation changes remain separately preserved. This proposal does not claim they shipped.
