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

The source candidate adds a read-only `codex-recover --inspect` path and retained
owned model-guard decisions. Inspection uses the same live work authority as
recovery, reads a consistent owner snapshot, and never reserves or queues work.
Its continuation witnesses are explicitly diagnostic and unauthorized. Both
unproved native interval coverage and the absent receiver fence remain visible
refusal reasons. The normal model policy remains in force; an inability to retain
its own decision now refuses the prompt rather than silently allowing it.

No recovery permission is activated by this candidate. A coherent
implementation must resolve the missing boundary before relaxing any public,
historical-effort, native-proof or reservation check. The same owner-verified
`accepted_binding_continuation` decision must then reach the real start guard,
preserve Medium all the way to `turn/start`, and permit one additional provider
attempt durably. Both guard allow and refusal need attributable retained evidence.
Empty or uncertain completion must not spend a second attempt automatically.

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

The existing contract, state and route fixtures all exited zero on November 13:
`bun run scripts/codex-unacknowledged-contract-fixture.ts`,
`bun run scripts/codex-unacknowledged-state-fixture.ts`, and
`bun run scripts/codex-unacknowledged-route-fixture.ts`, from `bot/`. These preserve
the existing exact recovery behavior; they do not cover the proposed continuation
extension. No broad local suite or model/provider experiment was run.

The new `codex-continuation-inspection-fixture.ts` exercises exact legacy omitted
effort/null-native-binding shapes at Medium, acknowledged source custody, held and
control inputs in the watermark/digest, conflicting effort refusal, no writes on
inspection, actual guard refusal of the diagnostic candidate, persisted allow and
refusal evidence, unknown effective effort, and audit-sink failure. The public
route fixture also proves that inspection invokes no recovery host and that an
informational caller cannot invoke it. These checks do not prove the still-missing
receiver fence or one-attempt continuation execution.

Source navigation used scoped `rg` references followed by direct reads of the
public operation, owner delegation, host proof, atomic reservation, registry,
observer, model guard, retry transaction and actual native start. No LSP tool was
exposed in this session. Large files were read at those boundaries, not claimed as
whole-file audits. Attached evidence bytes have a separate 13-file SHA-256 manifest
retained for parent review. No production ledger or outside obligation inventory
was read, and no installed or physical-device behavior is claimed.
