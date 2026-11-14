---
failure: An existing writing conversation ends before acknowledging its retained work reminder.
date: 2026-11-13
fix_commits: []
cause_status: best-explanation
---

# Preserved writing continuation: source diagnosis and recovery hold

## What was seen

The supplied receipts identify writing session `concierge:8245`, native conversation
`01a1a72e-75d8-7151-96da-9e751b6e90d6`, running Codex with GPT-6 Astra at **Medium**
on the server in `/root/workspace/thinkering`. These are retained evidence, not a
current live eligibility certification. This implementation work has no authority
to submit to, unload, restart, compact, fork, upgrade or recover that conversation.
The outside repair session `concierge:9626` retains those actions and release review.

The selected candidate is exclusively
`report-back:4b2a671c-abcc-4b8b-b5f7-0bd460c79ea7`, owner turn `29500`, run
`0dc18ec3-ef7c-4fc1-8f95-341a707ef778`, native attempt
`01a1d26a-611a-7472-835b-085327ad52ed`. Its original source request was already
acknowledged in run `7be6d104-9f83-4b88-abc6-2e1c63c0dde1`; that source is never a
replay candidate. The later `eacd714e-7951-49bc-a2e5-3d1e48038d98` is a closed,
failed informational consultation, not the writing recovery target.

The creation receipt is agent-authored, acknowledges actual prior work, and asks
for Medium. The original human words do not select Astra. Accepted binding
continuation therefore cannot be described as an explicit human model choice or
a newly proved historical escalation. The selected attempt's exact
`prompt-cache-identity:29500:1` event independently retains `effort: medium`;
the legacy admission's omitted effort is not permission to default to extra-high.

The supplied native item pages and parent's bounded raw-span corroboration show
the selected attempt empty and the independent maintenance turn
`01a1d5ff-0e9f-7ee0-ac4a-d935c033ef01` compaction-only. Generated AGENTS.md and
environment context with a user role are not submitted-message acknowledgements.
These observations do not establish the current accepted-input interval or make
the evidence atomic with a future submission.

## Cause

**Unknown incident cause:** prior Sol evidence places the failure before recorded
input and model sampling. A stopping hook is plausible, but the exact owned guard
outcome was not retained. A prior runtime exit and completed compaction did not
cure it. No source observation here attributes the stop to another hook or to
provider cancellation.

**Confirmed source barriers**, traced at source revision `cd91f068`:

| Boundary | Present behavior and evidence |
| --- | --- |
| Public recovery | `bot/src/session-communication.ts:1372` requires the exact retained human Astra choice before calling the owner. |
| Actual start guard | `bot/src/session-communication.ts:879` admits a service continuation only with explicit-choice evidence; it does not consume a recovery-specific binding decision. |
| Historical attempt | `bot/src/session-execution-host.ts:2060` requires extra-high in the retained effort witness, despite this attempt's Medium witness. |
| Native evidence | `bot/src/session-execution-host.ts:2100` loads items only for the selected attempts and constructs a new thread containing only those turns. It cannot certify a later accepted/native interval. |
| Reservation | `bot/src/state.ts:4233` rejects later admissions and `bot/src/state.ts:4314` writes extra-high. Its transaction does not compare an inspected accepted-input watermark or a native activity boundary. |
| Execution exclusion | `bot/src/session-owner.ts:3281` delegates recovery directly to the host. Normal execution enters `ActiveTurnDispatchRegistry.run` at `bot/src/session-execution-host.ts:1299`; recovery does not. |
| Native observation | `bot/src/codex-session-observer.ts:255` processes external status/history asynchronously. `bot/src/codex-session-lifecycle.ts:38` records observations; it is not a provider submission fence. |
| Native submission | `bot/src/codex.ts:1741` submits the input, client identity and effort. It passes no inspected native-history boundary. Connection generation in `bot/src/codex-app-server-client.ts:26` identifies a connection, not an unchanged conversation. |
| Additional-attempt budget | `bot/src/turn-execution.ts:1410` can send provider failures into ordinary retry scheduling. The unique recovery reservation is not itself a durable provider-attempt limit. |

The existing strict later-admission refusal remains a protection. This report does
not claim that it has allowed the proposed replay or that these extension hazards
caused the historical incident. Removing that refusal without replacing its proof
would be an authorization change unsupported by the selected-only helper.

The additional-attempt gap was exercised in an isolated copy of the existing state
fixture: reserve the parked report-back after attempt one, set its exact claimed
recovery execution to attempt two, then call the actual
`retryRunningTurnAfterProviderFailure` with that execution's identity. It returns
`true` and queues the turn again. The reservation is unchanged. This demonstrates
the state boundary's missing recovery budget; it does not assert that such a
retry happened in production. The replay script is retained with the parent
evidence packet, not installed as a second recovery mechanism.

## Eligibility result and missing safe ability

**Read-only result: not certified; no recovery authorized.** The missing predicate
is `NATIVE_ACTIVITY_BOUNDARY_NOT_FENCED`: the existing recovery path does not bind
an authoritative native activity boundary, together with the complete accepted
input interval, to atomic reservation **and** the eventual provider dispatch.

The concrete falsifying schedule is: inspect empty selected native turns; native
activity starts and finishes; its asynchronous observation has not yet become an
owner event; the session is idle again; reserve and later dispatch using the old
proof. Checking idle twice or comparing the connection generation does not
distinguish this schedule from no intervening activity. The project explicitly
supports externally submitted Codex turns; those cannot be assumed absent just
because there is no active owner run.

This is a missing guarantee in the inspected Concierge path, **not** a claim that
Codex's upstream protocol cannot provide a suitable primitive. The next source
step is to identify or extend the existing common execution/native entrance so it
can pin and validate that boundary through dispatch, including external/adopted
activity. A supported conditional start or an exclusive admission boundary would
need evidence of its actual semantics. A timer, second idle read, static file
digest, outside obligations export or new parallel recovery controller is not a
substitute. If the native boundary cannot be established, retain this refusal.

The complete accepted-input interval must separately include held inputs without
turns, controls, steering, custody changes and actual runnable FIFO predecessors.
Earlier terminal reminders are not automatically runnable predecessors and must
not be marked superseded from similar text. The outside repair session does not
acquire authority to close, cancel, merge, transfer or reclaim original requests
or children, including `concierge:8866`.

## Fix

The first source commit adds a read-only `codex-recover --inspect` path and retained
owned model-guard decisions. Inspection uses the same live work authority as
recovery, reads a consistent owner snapshot, and never reserves or queues work.
Its continuation witnesses are explicitly diagnostic and unauthorized. Both
unproved native interval coverage and the absent receiver fence remain visible
refusal reasons. The normal model policy remains in force; an inability to retain
its own decision now refuses the prompt rather than silently allowing it.

No recovery permission is activated by this candidate. The implementation must
resolve the missing boundary before relaxing any public,
historical-effort, native-proof or reservation check. The same owner-verified
`accepted_binding_continuation` decision must then reach the real start guard,
preserve Medium all the way to `turn/start`, and permit one additional provider
attempt durably. Both guard allow and refusal need attributable retained evidence.
Empty or uncertain completion must not spend a second attempt automatically.

The follow-up source correction now spends the additional-attempt allowance in
the same immediate SQLite transaction that retains provider-admission intent.
Only the next dispatch after the proven attempt count may consume it. Generic
provider retry scheduling and the dispatcher both refuse a spent allowance.
The marker survives process restart; legacy reservations also consult retained
admission intent and immutable attempt/result events before granting anything.
This corrects the reproduced budget defect without granting a continuation basis
or relaxing the existing native-history and authorization barriers.

The subsequent integrated source composes the factual accepted-binding decision,
complete paginated native projection, atomic reservation, exact model/effort queue
and actual resume/start, ephemeral one-dispatch capability, prompt invocation and
digest matching, and retained guard audits. The common owner mediates local
bridge, runner relay and versioned raw Desktop proxy writes. Direct CLI/TUI uses
durable lifetime custody. Exact native-terminal callbacks reconcile issued starts
and owned interruptions; RPC replies and process exits do not impersonate that
witness. The [current source contract](../architecture/CODEX-MUTATION-FENCE.md)
records the writer inventory and trust boundary.

The normal CI gateway isolation check caught a transport integration defect:
the foreground gateway imported the Node bridge's HTTP/socket discovery helper,
crossing its storage-free dependency boundary. The gateway now uses its existing
asynchronous private forwarding transport with a bounded authority response and
no retries. The standalone Node bridge retains its own endpoint discovery.
The boundary check remains unchanged; a disposable socket fixture covers exact
identity forwarding, refusal, malformed/oversized replies and unavailable owner,
and the composed runner-relay fixture exercises the actual gateway path.
CI then reached the writable-constructor guard and rejected the new disposable
fixture databases because their exact sites were not registered. Those temporary
roots and child-worker paths are now explicitly registered in the existing
fixture-only list, with exact constructor counts; production enforcement and the
missing-registration refusal remain unchanged.
The next CI pass reached cold-construction acceptance and correctly refused
unreadable identities in the shared CI host's process inventory. The synthetic
cold/configuration fixtures had accidentally depended on the implementation
host being privileged. They now supply a controlled process source through the
existing classifier dependency; the composed worker uses a fixture-only worker
bootstrap. Actual process classification and unknown-scope refusal remain in
production, and separate fixtures exercise old/unreadable installer blockers.
CI subsequently completed the sealed-release assertions but failed their cleanup:
the fixture tried to remove its sealed read-only directories as an ordinary user.
Cleanup now restores write permission only on directories under that fixture's
temporary root, skipping symlinks, before removing them. This follows the existing
installed-control fixture pattern and changes no release permission or authority.
The following CI run then stalled inside the aggregate fixture gate with child
output suppressed; its exact stuck fixture was not observable. The gate now
names each fixture before starting it and enforces the requested two-minute
overall budget, including an inherited output pipe. This is a test-process
deadline, never provider recovery/retry or authority. The stalled duplicate was
cancelled only to retain its partial CI log; no live provider was involved.
The instrumented run identified the original-history worker fixture. Its race
setup waited only for an observed native-read barrier, ignoring an operation
that could finish or refuse before reaching that barrier. The fixture now races
the observation against operation completion so an early result is reported
instead of becoming an indefinite test wait. This does not classify the early
runtime result as safe or change its authority.

The omitted-boundary source audit also found that account activation and managed
daemon replacement use running-turn checks, which do not exclude a queued
recovery fence. Global lifecycle intents now serialize those local operations and
the actual runner-machine forwarding entrance with thread permits. Verified
successful setup receipts and exact owned native-terminal witnesses reconcile
normal managed writes; ordinary response acceptance alone is not used for
asynchronous work. An uncertain lifecycle response remains a durable blocker.

**Activation remains refused before reservation.** Parent review has not supplied
a supported witness that previously issued handlers from the old unmediated
Desktop connection drained. Separately, no supported current cold-reconstruction
configuration witness establishes the managed hook. The final history audit also
found that pagination does not certify lossless original effect history. These
are enforced as `LEGACY_NATIVE_ISSUED_SEND_DRAIN_UNPROVEN`,
`COLD_RESUME_HOOK_CONFIGURATION_UNPROVEN` and
`NATIVE_ORIGINAL_EFFECT_HISTORY_COVERAGE_UNPROVEN`, not waived by idle/process
absence, projected terminal cursors, historical `notLoaded`, helper pinning or a capability response. This is an
incomplete activation prerequisite, not a completed live recovery or evidence
that Astra caused the incident. Parent retains the same prerequisite review;
no alternate controller, diagnostic provider input or native reset was started.

The original writing owner reconciles its own current authorized obligations after
acknowledgement. Delivery recovery and useful product work are separate acceptance
states; neither reservation nor an empty completed native turn proves restoration.

## Acceptance scenario

- **Seed:** an acknowledged legacy agent-created Astra/Medium conversation; the
  exact failed service report-back with immutable first admission and attempt
  results; later empty informational attempts; independently identified
  compaction; distinct retained original requests and transferred child work.
- **Action:** inspect through the existing owner, then race native activity,
  accepted-but-never-admitted input, controls and custody changes before reservation
  and dispatch; separately lose the recovery receipt and restart after attempting
  admission.
- **Expected:** a changed or unprovable boundary refuses without queuing; a complete
  unchanged boundary allows only the exact selected input once at Medium, under
  the same recorded decision as the actual model guard. Duplicate commands expose
  retained reservation/progress and cannot spend a second provider attempt. All
  other input bytes, results and custody stay unchanged. Restored delivery requires
  the exact persisted input acknowledgement; useful work requires separate evidence.
- **Replayable offline:** partially. Disposable fixtures can exercise owner races,
  custody, guards and attempt budgets. No fixture alone proves the actual native
  boundary primitive or restored writing work. Parent-owned sealed release and
  live acceptance remain required.

## Verification boundary

### Requirement review

- T10: repeated failure gets executable guards: durable forwarding permits,
  dispatch budget, exact prompt identity and activation refusal. The normal build
  includes a bounded custody fixture gate. This extends the existing owner,
  recovery command and execution lane rather than adding a parallel controller.
- T8: source fixtures are explicitly insufficient for real acceptance. Parent
  owns installed release, target delivery acknowledgement and useful-work proof;
  this source-only assignment authorizes none of those live actions.
- The software-owning implementation session builds this correction; the writing
  conversation receives no implementation work [decision: writing-agents-do-not-build].
  Sol implements the bounded cross-boundary repair without changing any running
  binding [decision: escalate-stuck-work-to-sol]. The Inbox router is unchanged
  [decision: inbox-remains-claude-while-work-recovers]. The explicit exact-session
  continuation request fits the recorded exception to the temporary exhausted-credit
  routing preference [decision: do-not-resume-codex-sessions-for-now]. No policy
  manufactures an explicit human Astra choice.

The existing contract, state and route fixtures all exited zero on November 13:
`bun run scripts/codex-unacknowledged-contract-fixture.ts`,
`bun run scripts/codex-unacknowledged-state-fixture.ts`, and
`bun run scripts/codex-unacknowledged-route-fixture.ts`, from `bot/`. These preserve
the existing exact recovery behavior. The integrated continuation extension has
separate focused checks below. No broad local suite or model/provider experiment
was run.

The new `codex-continuation-inspection-fixture.ts` exercises exact legacy omitted
effort/null-native-binding shapes at Medium, acknowledged source custody, held and
control inputs in the watermark/digest, conflicting effort refusal, no writes on
inspection, actual guard refusal of the diagnostic candidate, persisted allow and
refusal evidence, unknown effective effort, and audit-sink failure. The public
route fixture also proves that inspection invokes no recovery host and that an
informational caller cannot invoke it. These inspection checks do not prove
continuation execution. The state fixture additionally claims
the real recovery queue entry, spends admission once, opens the retained database
in a separate process, refuses repeated/next admission and automatic retry, and
checks that the first admission and recovery proof remain unchanged. It also
checks that a legacy reservation with an already-retained later result cannot
receive a fresh allowance after migration.

### Integrated source checks

The normal build now includes `codex-continuation-contract-check.ts`. Its twelve
isolated fixtures passed after integration: durable mutation permits, exact
dispatch/hook authorization, composed accepted-binding recovery, real raw
WebSocket launcher transport, owner mutation policy, global daemon lifecycle,
native-terminal reconciliation, actual local activation, actual runner relay
lifecycle forwarding, canonical SessionOwner controls, strict original-history
source parsing and checkpoint validation, and the actual history worker over its
App Server bridge. Two independent clients and explicit barriers cover delayed
old permits, competing writes, ambiguous replies, Stop, unrelated threads,
duplicate invocation, stale fences and a control change during source reading.
The worker fixture also accepts only an exact retained owned-resume response and
one matching settings append before the owner stores the private checkpoint. All
state, files and native endpoints in these checks are disposable; no target input
was sent.

Additional focused checks passed: accepted-binding proof and snapshot fixtures,
projected native interval, managed process registration/lineage, mutation channel,
the existing contract/state/route recovery fixtures, real runner relay socket
check, installed-control command selection, human model-choice custody,
inspection/audit, and the existing Stop/control/account-switch receipt fixtures.
The undefined-name check passed for fourteen bundle entry points; bounded-logging
source guard passed for 465 server source files. The six changed owner, runtime,
foreground gateway, history worker, model-start hook and managed launcher entry
points bundled successfully together (802 modules). `git diff --check` and the
installer shell syntax check passed after the source and documentation edits.

These are source checks, not installed activation or provider acceptance. All
explicit activation refusals remain enforced; the old Desktop connection and
current native hook reconstruction remain parent-owned unresolved prerequisites.

The implementation now adds a private source-prefix proof alongside projected
pagination. Under the exact thread fence, the isolated host history worker derives
the current accepted binding and source identity, repeats the native turn/item
watermark, reads the exact thread through the App Server, then parses every
newline-terminated record in the local source file and rechecks the file revision,
owner controls and fence. It retains only a safe witness of hashes, counts,
spans and native identities in the recovery proof; source paths and physical
custody stay private. After a real accepted owned resume, the worker permits one
append only when the retained intent and fence match, the original prefix remains
byte-identical, and the single record preserves the exact thread/model/effort
and complete prior settings snapshot. The source audit caught and corrected an
intermediate model/effort-only comparison: permissions, working directory, roots,
plugins and unknown fields now participate in full settings/context equality.
World-state patches require a known full baseline and unchanged reconstructed
state. Missing baselines and unassessed output usage refuse. Only hashes of these
baselines are retained; raw settings/configuration are not logged. The
canonical owner stores that derived witness and custody in its private immutable
checkpoint ledger.

The reader still refuses unsupported remotes and paths outside the configured
Codex home, legacy recovery mode, inherited/forked history, rollback, malformed
or partial source, unknown or unclassified rows/metadata, missing ordinals,
unproven accepted user/tool/configuration effects, or any non-exact resume
append. These conditions keep activation closed when source coverage cannot be
established. Plain compaction may preserve prior projected items, but the
materializer can omit original effects while advancing its projection checkpoint;
therefore pagination remains a separate and insufficient witness. The two other
activation holds remain independent: no positive native cut/drain receipt exists
for the old Desktop receiver, and no current cold hook configuration witness
exists for the exact target. The exact target's original source history, installed
worker path and activation behavior remain unobserved. No local witness or caller
assertion clears those holds. See the pinned
[materializer](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/thread-store/src/local/thread_history_materialization.rs)
and [projection](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/app-server-protocol/src/protocol/thread_history_projection.rs).

The final direct-writer audit found that an interactive `resume UUID` can attach
another conversation through the in-process picker. Startup identity therefore
does not bound lifetime scope. The shared classifier now keeps all interactive
commands, fork and other unproven direct commands global. Only the inspected
one-shot `exec resume` path with an explicit UUID receives exact-thread custody.
The real launcher fixture refuses an unrelated-startup-UUID interactive resume
before creating its native child when any recovery fence is active. This replaces
the earlier source candidate's overly narrow interactive lifetime classification;
neither candidate was activated.

Source navigation used scoped `rg` references followed by direct reads of the
public operation, owner delegation, host proof, atomic reservation, registry,
observer, model guard, retry transaction and actual native start. No LSP tool was
exposed in this session. Large files were read at those boundaries, not claimed as
whole-file audits. Attached evidence bytes have a separate 13-file SHA-256 manifest
retained for parent review. No production ledger or outside obligation inventory
was read, and no installed or physical-device behavior is claimed.

## Real-source compatibility correction before whole review

Parent's bounded structural diagnostic demonstrated two candidate defects without
granting recovery authority: an ordinary preselected token-count record carried a
typed non-null quota snapshot, and the compaction checkpoint carried the pinned
native retained-context and resume sidecars. Rejecting all such values made the
candidate incompatible with supported native history. The diagnostic's earlier
prefix was hashed, not parsed; its summaries are not payload preimages and do not
certify current eligibility. No target transcript or provider read was performed
by this implementation lane.

The correction follows the pinned 0.162 protocol/history producers. Known typed
quota telemetry is classified separately from acknowledgements and output effects.
Retained messages and resume state require causal references to original native
records, exact identities/revisions/order and matching content hashes. A matching
replacement string alone provides no provenance. Unknown sidecars, shortened or
unreconstructible retained content, missing source identities and conflicting
settings still refuse. Focused fixtures include ordinary quota metadata and typed
compaction checkpoints instead of omitting those real source shapes.

The other confirmed source gap was construction binding: installed hook files and
separate configuration reads did not bind a later cold resume. The source now
integrates configuration-writer exclusion with the existing mutation ledger,
recaptures cold/configuration evidence immediately before forwarding, and binds
the actual resume parameters and terminal result digest to immutable private
construction evidence. The actual legacy receiver admission cut remains separate;
the running daemon cannot acquire that historical fact from a new log statement.
This section records the diagnosis before the parent's whole implementation review.

The final producer audit exposed a separate rollback boundary: retaining modern
deployment control does not make an older restored application's mutation policy
compatible. Parent directed reuse of the existing durable file-only release
compatibility mechanism, with application-origin capability in hybrids and
checks on activation, rollback, startup and explicit control recovery. Its
requirement is monotonic, published before protected authority and never cleared
by idle, terminality or rollback. Old incompatible LKG artifacts become ineligible;
this availability change is explicit rather than a silent protection bypass.

Publication alone cannot exclude old in-flight application requests, pinned
helpers or configuration writers across first protection. No existing host
authority proves that first transition under this lane's no-live-action boundary.
The operational preflight therefore refuses
`FIRST_PROTECTION_WRITER_EXCLUSION_UNPROVEN` without publishing a requirement or
issuing protected database authority. Deployment checks before drain, pointer
selection and service stop. Once a requirement has legitimately been published,
failure retains it; no marker/SQLite atomic commit is claimed. The legacy native
admission cut remains a second independent missing fact. This checked source
candidate does not complete the human repair or establish current target
eligibility, a compatible live rollback artifact, or installed Mac behavior.
