# Codex empty report-back: evidence and exact recovery entrance

This artifact records the bounded evidence, source findings, offline checks, and parent handoff for the November 13 correction. It is not a production-ledger read, a deployment record, or proof that the historical guard cause was observed.

The parent subsequently performed the authorized recovery after the first correction shipped; the exact Astra conversation is now usefully working. This artifact's recovery command below is historical procedure only and must not be run again for this already recovered input. The parent retained before/after operation snapshots outside this artifact. They showed the retry replaced the accepted-input admission's prompt hash while keeping its original timestamp. The follow-up records each attempt's admission immutably and keeps the legacy receipt field pointing to the first admission.

## Exact identities and obligations

The original communication remains open: `11319298-53d9-4cca-9c7e-cc05bd56a4d3`.

| Role | Identity |
|---|---|
| Existing target session and native thread | `concierge:3012` / `01a0a799-9cfb-7243-acce-89c4500b80d7` |
| Original acknowledged work input | `request:11319298-53d9-4cca-9c7e-cc05bd56a4d3` |
| Original owner run / turn | `7e0ffaef-96ef-401e-86b6-3a8db27b2566` / `29055` |
| Candidate service report-back input | `report-back:11319298-53d9-4cca-9c7e-cc05bd56a4d3` |
| Candidate owner run / turn | `7ef1930d-593d-48ef-9444-ebfc964aacc6` / `30033` |
| Mapped empty native turn | `01a1d66e-f18c-73a1-9200-142a94103545` |
| Separate expired watch and its own native turn | `watch:3e79cae0e54f:expired` / `01a1d66e-e9ce-7e51-a91b-7fa264e46b9d` |

The original work input has a native `userMessage` and substantive final output. It must never enter this never-acknowledged recovery. The separate report-back input is the only proposed target. The three original product obligations stay open and separate: requests `0aac3e22-f76b-4da5-b6f2-9a067a1a80d8` (topic `a8d7fc8c-0dc7-4c8e-9c9a-7068a3c9c7e4`), `866beea1-e295-491a-a998-c1046e8275df` (topic `ddd0309b-7ba2-4bd1-ba80-aaf608d89f14`), and `44e19702-2a59-4e36-b661-01eb9547a4cf` (topic `9c419b01-f006-4174-ab1d-a03396d02e4f`). No recovery receipt settles any of these.

## What the evidence establishes

- Owner events show a nonempty service report-back accepted; its terminal result had empty text and no tools, with `acknowledgedAt: null` and no owner error. This confirms a false empty completion at the execution boundary, not that the original communication was closed.
- The native turn `01a1d66e-f18c-73a1-9200-142a94103545` is completed with `items: []` and no error. A bounded `thread/items/list` read filtered to this exact turn returned `data: []` and `nextCursor: null`, establishing complete item coverage. The other empty native turn, `01a1d66e-e9ce-7e51-a91b-7fa264e46b9d`, belongs to the distinct expired watch input `watch:3e79cae0e54f:expired` and run `f15e1a2d-b737-48c6-a624-7edda493ffa0`; that watch remains unrecovered. It is not attributed to or replayed with the report-back.
- The selected report-back's owner history retains dispatch attempt 1, its exact native turn ID, an empty immutable result, no provider acknowledgement, and a same-attempt prompt identity with `effort: xhigh`. Its accepted-input receipt retains the admission, model, and exact run, but omits `reasoningEffort`. This receipt format omits effort for both this legacy completed turn and newly parked turns; omission is accepted only when that exact attempt's retained prompt identity proves `xhigh`, and an explicit conflicting effort refuses. The same-work human instruction that explicitly chose Astra is reachable through retained source provenance. The old session has no modern runner pin; recovery accepts an absent/null pin only when this owner App Server proves the exact native thread and selected turn. A non-null foreign runner pin refuses.
- The completed turn's stored native delivery is a versioned envelope around that same empty provider result. Recovery compares the envelope's provider result to the immutable owner result and requires the native turn's complete item list to be empty. Any nonempty or mismatched envelope refuses.
- The owner recorded requested effort `xhigh`. The installed App Server JSON schema has no `reasoningEffort` field on `ThreadStartParams` or `ThreadResumeParams`, and has `effort` on `TurnStartParams`. This verifies the adapter parameter mismatch without running a provider.
- The exact historical UserPromptSubmit decision was not retained. Its block is a plausible explanation for the empty native turn, not an observed fact.
- Historical process audit recorded zero remaining processes for the selected thread. The new owner still checks the current host and exact thread at recovery time.

Source evidence supplied with the parent request: `/tmp/recovery3012-events.json`, `/tmp/recovery3012-native-turns.json`, `/tmp/recovery3012-authorization.json`, `/tmp/recovery3012-schema/v2/ThreadStartParams.json`, `/tmp/recovery3012-schema/v2/ThreadResumeParams.json`, `/tmp/recovery3012-schema/v2/TurnStartParams.json`, and `/tmp/recovery3012-human-source.txt`. These are historical evidence, not current eligibility proof.

## Checks performed

- `bun run scripts/codex-turn-contract-fixture.ts` — requested `xhigh` reaches native `turn/start`, thread resume has no unsupported effort field, and an unacknowledged empty completion becomes a terminal provider-dispatch failure.
- `bun run scripts/codex-unacknowledged-contract-fixture.ts` — selected attempts must map to completed empty native turns; the distinct earlier empty watch remains independent; incomplete arrays, acknowledged/nonterminal turns, unknown selected attempts, wrong thread, and missing CLI action ID refuse.
- `bun run scripts/codex-unacknowledged-state-fixture.ts` — historical and newly parked admission receipts with omitted effort are accepted only with same-attempt `xhigh` prompt proof; explicit conflicting effort refuses on both paths; restart reconciliation cannot consume the old empty delivery envelope after reservation, while its immutable result remains; duplicate recovery is refused.
- `bun run scripts/codex-unacknowledged-route-fixture.ts` — the composed command follows exact human model custody and work scope, returns the durable reservation after a simulated lost action receipt, deduplicates a second action ID, and refuses an informational-only caller.
- `bun scripts/provider-admission-history-fixture.ts` — invokes the actual admission method for two Codex attempts with different prompts; the first receipt admission remains unchanged, the operation exposes both attempt records, and a changed ChatGPT prepared admission is still refused.
- `bun run scripts/implementation-edit-gate-fixture.ts` — exact same-session service continuation is allowed through the retained open work request and verified model choice; unrelated agent continuation remains refused.
- `bun run scripts/codex-resume-notice-fixture.ts` and `bun run scripts/codex-connection-loss-fixture.ts` — existing wait and lost-connection behavior still passes with explicit accepted-input notifications.
- `bun run scripts/undefined-name-check.ts` — all 14 bundle entry points pass.
- `bun build src/index.ts --target bun --outdir /tmp/concierge-codex-recovery-build` — application entry bundles.

These are scratch-ledger and fake-App-Server checks. No live provider, production ledger, deployment, merge, or recovery action was used. The parent must review the integrated code and check live eligibility after deployment before invoking recovery.

## Parent recovery procedure after review and deployment

Historical only; already completed by the parent. Do not run this again for report-back `11319298-53d9-4cca-9c7e-cc05bd56a4d3`. For any future case, follow the current runbook only after a separate exact eligibility proof and review:

```sh
router-actions.sh sessions codex-recover 11319298-53d9-4cca-9c7e-cc05bd56a4d3 \
  --source-input '<parent accepted input ID>' \
  --source-run '<parent native run ID>' \
  --action-id codex-report-back-recovery-11319298
```

The owner selects only `report-back:11319298-53d9-4cca-9c7e-cc05bd56a4d3`. It never selects `request:11319298-53d9-4cca-9c7e-cc05bd56a4d3`. Before requeueing, it checks that exact operation's retained admission and attempt/result records, verifies the exact native turn and complete item pages, and rechecks current binding, send controls, open work request, work authority, host state, side effects and later admissions. The separate expired watch remains untouched. A refusal leaves the accepted report-back and original communication in custody.

If admitted, the owner atomically reserves the report-back input by its stable accepted-input ID, clears the prior native delivery envelope, and places that same turn in the existing FIFO. The immutable historical empty result event remains, but restart reconciliation cannot mistake its old envelope for the new attempt's result. Lost responses and different action IDs return the retained reservation before checking the turn's now-changed queued state; they do not create a second replay. A later native attempt is retained under its own result identity so existing Inbox readers can surface the useful answer. Observe the exact report-back's new native acknowledgement and useful work separately. The request-return protocol and all three obligations remain open until their own supported final outcomes are accepted.
