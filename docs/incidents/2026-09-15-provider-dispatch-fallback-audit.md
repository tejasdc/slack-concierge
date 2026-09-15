# Provider dispatch and usage-fallback audit

Audited 2026-09-15 at source `1e946d5`, including the exact-input fallback
correction `44b3881`. This is a dated inventory and incident finding, not a
second provider-selection policy. The [unified policy request](https://tejazz.slack.com/archives/C0BNN5K4JSJ/p1789436463575829)
owns the pending selection changes; the [comparison request](https://tejazz.slack.com/archives/C0BNN5K4JSJ/p1786151014153829)
owns counterpart inference and invocation from replies.

## What the reported comparison actually ran

The [failed comparison](https://tejazz.slack.com/archives/C0BNN5K4JSJ/p1789432448682319)
is turn **996**, session **2183**, originating from Codex session **1827**.
It selected Claude Code, model `claude-fable-5-1`.

| UTC on September 15 | Confirmed production evidence |
| --- | --- |
| 00:34:08.784 | `comparison_started`, source Codex, target Claude Code/Fable, one user prompt. |
| 00:34:13.142 | Turn 996 parked on exhausted usage. Its stack names release `0e4bd812…`, whose immutable manifest identifies commit `59c26ed`. That bundle has no usage-fallback implementation. |
| 00:39:49 | The service started release `6949bcb6…`, manifest commit `e38513e`, which includes fallback commits `66fbd4b` and `6aeb9b9`. |
| 00:40:55.190 | First observed production `claude_code_usage_fallback`: existing inbox conversation switched from Fable to Opus. |

**Conclusion:** this comparison failed before fallback reached production. Its
entry point does not bypass the Claude adapter. The failure is real, but it
does not demonstrate a comparison-specific defect in the installed fallback.

At this audit, turn 996 remains `parked/parked_terminal`, attempt 1. A new release
does not retry every parked turn. `resumeBlockedParkedHeadTurns` requires a queued
successor; an isolated parked comparison also has the explicit Retry control.
An already-saved result has a different recovery path: inbox turn 966 was
delivered by the earlier retry/progress fix without rerunning its provider work.
Do not conflate those states or claim the comparison was retried by this audit.

## Dispatch inventory

“Claude covered” below means the call reaches the shared adapter's configured
model chain after an acknowledged input and recognized usage rejection. It is
not a guarantee that another model has quota. Unknown model IDs do not opt in;
authentication and transport errors are not usage fallback. No path currently
gains automatic cross-provider continuation from that adapter.

| Entry point | Execution owner | Usage exhaustion in the audited design | Verification / uncovered boundary |
| --- | --- | --- | --- |
| Ordinary new session, including routed captures | `handleUserMessage` → `runClaimedTurn` → `executeAgentTurn` → `providers[…].run` | **Claude covered. Codex model fallback absent.** | Existing real Slack fallback case covers new Claude work; capture publication still precedes provider dispatch. |
| Resume or ordinary reply in an existing session | Same execution owner with the bound provider UUID | **Claude covered**, retaining the native conversation and preferred model. **Codex fallback absent.** | Real Slack two-turn fallback evidence; exact accepted input/steering replay tests. Changing a provider is a separate continuation contract. |
| Live steering | Existing provider turn's steering sender | **Claude covered** after acknowledged guidance; no second dispatch process | Focused tests cover guidance ordering, usage evidence reset, Stop, and exact fallback replay. |
| Deferred/routed work, FIFO queue promotion, safe parked Retry, startup promotion | `runPersistedQueuedTurn` → `runClaimedTurn` | Same Claude coverage once dispatched | Real DM parked-resume acceptance covers repeated park, preserved progress identity, final delivery and queued successors. A parked turn is not itself an automatic quota-reset timer. |
| Comparison / A-B | `dispatchComparisonTurn` → `handleUserMessage` with provider/model overrides, isolated session and prebuilt user-only replay → same execution owner | **Claude counterpart covered. Codex counterpart fallback absent.** | Source confirms the shared path. The reported failure predates rollout. No dedicated real Slack comparison-plus-quota case existed in the original validation. |
| Claude fork creation | `providers[…].fork` → `forkClaudeCodeSession` → `runClaudeCodeTurn` with native `--fork-session` | **Claude covered** inside the native fork conversation | Fork wrapper reaches the adapter, but lacks an explicit requested-model field and preferred-model callback. It uses provider initialization identity. No dedicated fork-plus-quota acceptance was established. Exhausting all candidates reaches fork failure/ambiguity handling, not the ordinary parked-turn Retry owner. |
| Codex fork creation and subsequent child replies | Native `thread/fork`; later replies use normal turn execution | Fork creation is a control operation; **later Codex quota fallback absent** | Do not add a model call merely to create a Codex fork. |
| Review requested as an ordinary managed Claude turn | Normal execution owner | **Claude covered** | The review role alone supplies no new behavior. |
| Review or implementation subprocess launched directly as `claude -p` / `codex exec` by an agent, skill or operator | Native CLI invocation outside `providers` | **Not covered by Concierge fallback** | Hardcoding Claude as reviewer in instructions does not route that CLI through `runClaudeCodeTurn`. Native CLI usage handling has not been established as an equivalent substitute. |
| Automated deployment repair and independent repair review | `runRepairAgent`, direct fresh/resumed `codex exec` | **Not covered by Claude fallback or automatic Codex model substitution** | Existing supervisor owns bounded attempt/review failure handling. Provider selection must preserve its trusted-root ownership and bound session identity. |
| Scheduled or external captures that publish to Slack/private routed intake | Capture/routed-request owners, then ordinary dispatch | Same Claude coverage after admission | Timer or capture origin does not create another model runner. Journal-only captures intentionally start no provider turn. |
| Other scheduled work in this repository | Unit-specific owner | **No additional scheduled provider runner found** | Monologue poll and journal ingest units are stubs. Historical `claimDeploymentWake` has no production caller; retired success-wake code is not an active entry point. |
| `/review-inbox` | Fixed external `journalmaxx-review` host command | **No Concierge fallback wrapper** | Command is not installed on the audited host; any future implementation needs its own verified provider boundary. |
| Codex Remote / externally initiated App Server turns | External client and shared App Server; Concierge observes mapped output | **Not controlled by Concierge fallback** | The observer must not silently start a replacement turn or change an external client's provider. |

## Evidence and boundaries

Compiler-backed references identify **one** managed `input.provider.run` call
([turn-execution.ts, line 441](https://github.com/tejasdc/slack-concierge/blob/1e946d5/bot/src/turn-execution.ts#L441)),
**two** production calls to `runClaimedTurn` (direct admission and queued work),
**one** provider fork dispatch, **two** production calls to `runClaudeCodeTurn`
(provider wrapper and fork wrapper), and **one** provider-wrapper call to
`runCodexTurn`. The separate direct CLI runner is
[deployment-repair-agent.ts, line 26](https://github.com/tejasdc/slack-concierge/blob/1e946d5/bot/src/deployment-repair-agent.ts#L26).
Text-level verification also searched the repository's process starts, RPC
`turn/start`/`turn/steer`, provider imports, and service/timer entrypoints.
This inventories repository-owned dispatch and named external boundaries;
arbitrary programs launched outside Concierge cannot be declared covered.

Relevant source:

- [Comparison dispatch preserves target and isolation](https://github.com/tejasdc/slack-concierge/blob/1e946d5/bot/src/turn-dispatch-seams.ts#L152).
- [Claude provider and fork wrappers](https://github.com/tejasdc/slack-concierge/blob/1e946d5/bot/src/providers.ts#L52), [native fork adapter call](https://github.com/tejasdc/slack-concierge/blob/1e946d5/bot/src/claude-code.ts#L711).
- [Exact configured fallback candidates](https://github.com/tejasdc/slack-concierge/blob/1e946d5/bot/src/aliases.ts#L35), [usage rejection handling](https://github.com/tejasdc/slack-concierge/blob/1e946d5/bot/src/claude-code.ts#L407).
- [Generic dispatch failure classification](https://github.com/tejasdc/slack-concierge/blob/1e946d5/bot/src/provider-failures.ts#L35) has no distinct cross-provider quota policy: some rate-limit text retries, other terminal errors park.
- [Actual-model footer](https://github.com/tejasdc/slack-concierge/blob/1e946d5/bot/src/turn-execution.ts#L498) exposes the terminal model. The switch itself currently goes to service logs; comparison anchors retain the originally selected target label.
- [Safe parked-turn resumption](https://github.com/tejasdc/slack-concierge/blob/1e946d5/bot/src/state.ts#L3519), [successor-based resumption](https://github.com/tejasdc/slack-concierge/blob/1e946d5/bot/src/state.ts#L3584).

Audit verification: **94 tests passed**, zero failed, across
`claude-usage-fallback`, `claude-code`, `comparison`, `fork-requests`, and
`provider-dispatch-execution`. These are regression evidence for existing
behavior, not new real-environment comparison/fork quota proof. No production
validation input, parked-turn mutation, provider restart, or runtime change was
performed during this audit.

## Requirements for the one policy already in flight

These are integration constraints for the existing policy request, not another
implementation lane:

1. **Choose intent and role, then handle availability.** Keep the requested
   provider/model, permitted fallback candidates, and actual provider/model
   distinguishable. A reviewer role must reach the same policy through its real
   runner; changing prose defaults alone leaves direct CLI reviews uncovered.
2. **Preserve the comparison.** Infer the other provider from the source session.
   When a Codex source selects Claude, an allowed Fable → Opus substitution still
   compares Codex with Claude, but identify the actual model and the usage reason.
   Do not silently fall back to the source provider and call that the requested
   A/B test. An explicitly selected exact model must have an explicit substitution
   rule or a visible deferred/unavailable outcome.
3. **Preserve session semantics.** A native model switch retains one provider
   UUID. Moving between Claude and Codex needs the policy's separately verified
   continuation/replay contract; it is not an automatic transfer of a native
   conversation. Preserve comparison isolation and user-only comparison input.
4. **Make exhaustion and work ownership visible.** Distinguish “using Opus,”
   “waiting for usage,” “parked for Retry,” and “result saved, delivery pending.”
   Do not claim that queued work started or an earlier failed comparison retried
   merely because a new release was installed.
5. **Exercise entry points, not only the adapter.** Include comparison with an
   exhausted inferred counterpart, explicit-target refusal/substitution behavior,
   fork creation, the actual reviewer runner, and automated repair/ingress
   boundaries selected by the policy. Keep the existing new/resumed/steered and
   parked-DM cases. Test any intended Codex-side or cross-provider fallback
   explicitly; the current Claude tests prove neither.
