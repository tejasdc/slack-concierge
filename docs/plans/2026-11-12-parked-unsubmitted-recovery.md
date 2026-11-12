# Shared Codex pre-submission transport boundary

## Requirement and operating profile

Request cad80fb0-2049-49b9-84af-cbe6616d91f6: "Restore the Twitter daily delivery path. The first Codex firing is parked after a WebSocket closure and five later daily firings were skipped. Establish the exact prior provider/effect boundary and fix the owning Concierge invariant or safely recover the retained blocker through supported controls." "Do not replay any digest" and "Do not change, start, cancel, recreate, or migrate the repeat."

One person, server owner and runner, sleeping Mac. Repair session 9486 owns the Codex transport correction, independent review, normal Git/release path, and installed no-replay readback. Session 9255 owns scheduler release and migration. Session 9232 owns digest publication. This code change does not alter repeat state, publish a digest, or recover/retire the old turn.

## Evidence and boundary

Journal: turn 25518 attempt 1 was held by usage on Nov 7 at 11:00 UTC; attempt 2 was held Nov 12 at 18:55:51; attempt 3 parked ambiguous at 18:57:08 on a WebSocket closure. Five daily skips preceded that closure. The supplied owner-firing evidence records all three attempts as `released` `codex-daemon` executions, zero adoptions/adopted-live attempts, and an explicit `run.sessionUUID: null` for each. Current provider generation is 1 with a null UUID; no provider messages, turn, or acknowledgement are recorded. These facts are not alone proof that no effect occurred.

The exact firing is preserved without attempting recovery. Source inspection confirms parked native turns are excluded by `EARLIER_TURN_BLOCKS_SQL` in `bot/src/state.ts`, while a matching held execution only fences when its state remains `intended`, `live`, or `exited`. All three attempt records supplied for turn 25518 are released `codex-daemon` executions, so the original parked native turn does not block later native work under the current claim path. The saved-work overlap query includes queued/running/delivering rows only. This is a source finding; no production readback of future delivery is claimed.

The original session binding proof remains relevant to diagnosis but does not authorize an action: source requires the binding mutation to complete before `turn/start`, and the durable barrier precedes provider submission. The evidence supplied for all three attempts says each began with explicit null `sessionUUID`, was not adopted, and the provider generation stayed 1 with a null UUID. This report does not infer no effect from missing acknowledgement and does not add a retirement operation.

## Incident state card (read-only disposition)

- Entity/writer: exact accepted native turn 25518 in its current Concierge session; any state mutation belongs to the canonical owner storage boundary.
- Identity: preserve the exact turn, session, source input/run, all dispatch attempts and their original failure evidence.
- Current disposition: turn 25518 remains parked ambiguous. The current claim path excludes parked native turns from `EARLIER_TURN_BLOCKS_SQL`; an execution fences only while its matching attempt is held in `intended`, `live`, or `exited`. All three supplied attempt rows are released. Saved-work overlap only sees earlier `queued`, `running`, or `delivering` rows. Thus source plus supplied exact facts establish that the old park is not blocking the later native firing.
- Retained state: no turn, attempt, provider history, repeat row, queued successor, failure timestamp, artifact, or publication evidence is changed. No digest was replayed. This source/ledger readback does not prove a future firing or publication.
- Lifetime and owner: existing Concierge owner and runner; no new API, service, watch, timer, store, or recovery action.
- Diagnostic boundary: missing acknowledgement alone cannot prove no effect. Source shows the durable provider-session binding precedes `turn/start`; supplied complete attempts are explicitly initially unbound, non-adopted, and released, with unchanged generation 1/null binding. This supports the incident diagnosis but does not authorize retirement or replay.

## Implementation state card and invariant

- Entity/writer: one shared Codex dispatch attempt, handled by its existing controller. No storage or scheduler mutation.
- Identity: preserve the existing accepted turn and its attempt identity; the fixture uses a fake App Server client and temporary state directory.
- Acceptance: ambiguous client failures during connect/config/thread setup before `turn/start` become terminal-confirmed retryable dispatch errors. Once submission is attempted, existing exact-history reconciliation remains responsible. Adopted work remains ambiguous because its provider effect predates this controller.
- Retained state: no provider call or live ledger change. The original parked turn, repeat rows, exact failures and evidence remain untouched.
- Lifetime: existing owner and client only; no new service, watch, timer, store, command or API.
- Failure trace: setup socket closure -> raw ambiguous client error -> previously parked; corrected path -> retryable error before submission. A disconnect observed during setup also ends that attempt so an obsolete `turnStarted` rejection cannot poison a later request.
- Falsifier: any `turn/start` in a setup-fault fixture, retry-safe classification for adopted work, or loss of post-submission reconciliation fails acceptance.

## Choice and existing mechanisms

Retiring the historical parked turn was initially proposed because the general parked-turn documentation described FIFO blocking. Inspection of the actual native claim predicate and saved-work overlap showed that the proposal was unnecessary for this incident: released attempts leave no held execution fence, and parked native rows do not participate in the generic earlier-turn blocker. Adding an inspect/retire route would therefore introduce an unused state-changing operation and risk conflating ambiguity with proof. The request to restore normal daily delivery and the no-replay/no-repeat-change constraints remain recorded here; neither the repeat nor the parked firing is modified.

Fix the confirmed future defect: shared Codex ambiguous transport failures before `turn/start` must be classified using the controller's actual submission boundary, including connect/config failures. Once submission is attempted, preserve exact-history reconciliation and ambiguous parking. A disconnect observed during setup must not poison a later admitted turn with a stale start rejection. Adopted work is excluded from the unsent classification. No automatic replay or global retirement of historical parked turns.

## Acceptance and release

Focused disposable fixtures exercise the real shared dispatch controller with connect, config, thread-response disconnect, healthy later attempt, adopted reconnect, pre-submit Stop, and an admitted turn whose exact history fails. They assert only the setup failures are retryable, Stop submits nothing, adopted work is not called unsent, and post-submission ambiguity remains parked without a second `turn/start`. Run relevant static checks and the undefined-name check; the legacy test command is disabled and must not be bypassed. Preserve the exact incident evidence in `/tmp/parked-presubmit-repro.md` and the supplied owner-firing review. The implementation helper commits locally and does not invoke a provider, recover the turn, mutate the scheduler/repeat, publish a digest, or claim delivery. Repair session 9486 owns the independent review and normal delivery path, followed by a live no-replay/readback check; future publication remains owned by session 9232 and unobserved until it normally runs.
