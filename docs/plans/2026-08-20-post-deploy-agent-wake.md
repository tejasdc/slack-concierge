# Post-deploy agent wake implementation plan

Status: implementation complete, independently reviewed with a `SHIP` verdict,
and rolled out successfully in deployment run
`0693538c-2a2a-49c2-844f-bc94b723a87f` at commit
`4e297e77e23077e05716cb9fdb1750469aec802e`. The architecture below also
received a `SHIP` verdict before code changes began. Its attempt-terminal request
and failure-notice behavior is the production baseline that the accepted
[deployment repair agent design](2026-08-24-deployment-repair-agent.md) proposes
to replace.

## Current deployment topology

`bot/scripts/deploy.sh` is the ordinary deployment entrypoint. When an agent invokes it from `concierge-bot.service`, the script creates one transient `systemd-run` unit and returns; that per-invocation unit owns drain, pull, restart, functional probes, and gate release. There is no standing global deploy service.

Two exceptional entrypoints exist. `bootstrap-deploy.sh` is a one-time bridge for a runtime that predates durable drain ownership, and `project-scaffold-cutover.sh` is a one-time fail-closed migration wrapper that sources the ordinary deploy functions after its own mutation gates. Neither is an alternative ordinary deployment path and neither creates post-deploy verification turns.

## State-machine contract

```yaml
template: state-machine-contract
owner: bot/src/deployment-state.ts, persisted in the main Concierge SQLite database
behavior_or_operation: one deployment batch for the canonical Concierge service target
source_of_truth: deployment_runs plus append-only deployment_run_events; requests, wakes, and notices are separate durable projections
actors:
  - deploy.sh launcher and transient runner
  - Concierge startup/periodic deployment recovery worker
  - ordinary Slack-started provider turns
  - explicit deployment-verification turns
resources:
  - canonical /root/workspace/slack-concierge checkout
  - concierge-bot.service and agent-inbox.service
  - deployment and capture admission gates
  - persisted provider session and immutable visible Slack thread
states_or_modes:
  run: prepared -> draining -> updating -> restarting -> verifying -> releasing -> succeeded | failed | ambiguous
  request: pending -> included | not_included | failed
  wake: pending -> running -> delivered | parked
  notice: pending -> sending -> delivered | parked
allowed_transitions:
  - one nonterminal run per deployment target; later requests join it
  - every phase transition appends a run event before the next external effect
  - success requires canonical checkout SHA, functional health, gate release evidence, and a final functional re-proof of the same current service invocation and runtime SHA
  - only included requests in a succeeded run create verification wakes
  - a wake waits while its exact persisted session is running, proceeds only from idle, and parks every other session state
invalid_states:
  - two live mutation coordinators for the same deployment target
  - a wake without a succeeded run and included request
  - a verification turn in a different provider session or Slack thread
  - retrying a wake after provider admission became possible
  - reporting a failed or ambiguous deployment as ready for verification
contracts:
  - deploy invocation identity is derived from the owning turn environment and validated against its live database owner
  - expected commit, source turn/session, provider configuration, provider UUID, user, channel, and visible thread are immutable request data
  - Codex and Claude tool environments receive the current turn identity without prompt-injected controls
  - the verification prompt is an immutable packet naming the requested and deployed commits plus probe evidence
producers:
  - deploy-state request CLI
  - deploy.sh phase and terminal commands
  - deployment recovery worker
consumers:
  - deployment verification worker
  - durable failure-notice worker
side_effects:
  - one deterministic transient systemd unit per batch
  - canonical Git update and service restarts
  - one real provider turn per distinct session/channel/thread waiter
  - deterministic Slack failure notice per affected thread
deny_cases:
  - missing or stale source turn ownership
  - dirty/noncanonical production checkout or requested commit absent from deployed ancestry
  - missing provider UUID, missing channel, or ambiguous session mapping
  - failed/ambiguous health or provenance proof
protected_classes:
  - active provider work and capture delivery
  - provider-session continuity
  - exactly-once Slack-visible wake/notice intent
runtime_surfaces:
  - bot/scripts/deploy.sh
  - bot/scripts/deploy-state.ts
  - bot/src/deployment-state.ts
  - bot/src/deployment-worker.ts
  - bot/src/index.ts and provider transports
observability:
  - deployment_run_events phase history
  - deployed SHA and systemd InvocationID on the run
  - structured logs for request, phase, outcome, wake, park, and notice
tests:
  - coalescing and per-thread wake fan-out
  - failed/not-included runs create notices but no wakes
  - session-busy serialization and provider-session continuity
  - dead-owner recovery before and after provider admission intent
  - transient unit identity and runtime SHA proof
  - later heartbeats cannot overwrite cumulative thread status
dry_run_or_fixture: focused Bun state, worker, provider, and deploy-script fixtures
rollback_or_restore: code rollback is safe; persisted terminal history remains readable and nonterminal work is parked fail-closed
verified: 455-test Bun gate, focused deployment/state tests, shell syntax, bundle build, and independent high-risk diff review
not_verified: live rollout proof pending
confidence_limits: bootstrap and the completed one-time scaffold cutover remain specialized operator flows, not agent wake producers
```

## Implementation checklist

- [x] Persist deployment run history, request snapshots, wake intents, and failure notices.
- [x] Convert ordinary agent deploy invocations into one deterministic transient unit per active batch.
- [x] Prove the canonical runtime SHA and current service invocation before success.
- [x] Inject durable turn identity into Codex and Claude tool environments.
- [x] Run explicit deployment-verification turns in the exact persisted provider session and visible Slack thread.
- [x] Park ambiguous provider admissions; never substitute a fresh session.
- [x] Add focused state-transition, multi-waiter, failure, transport, and deploy tests.
- [x] Update current-state architecture, runbook, and project routing guidance.
- [x] Pass the full Bun gate and an independent high-risk diff review.
- [x] Roll out through the canonical deploy path and capture live evidence.
