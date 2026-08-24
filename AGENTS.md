# Slack Concierge agent guide

Slack Concierge is a Bun/TypeScript Slack bot that routes messages to Codex or Claude Code, preserves provider sessions, and delivers durable Slack-visible turn state. Treat this file as the routing layer; use the linked current-state documentation and focused tests for subsystem detail.

## Response contract

Every final response delivered through Concierge starts with `TL;DR:`. Make it a concise cumulative summary of the visible Slack thread, covering every request and delivered outcome through the current turn, then give the detailed response.

## Start here

- [Documentation index](docs/README.md) — current architecture, runbooks, reviewed plans, incidents, and their authority boundaries.

The top-level `DESIGN.md`, `IMPLEMENTATION.md`, `REQUIREMENTS.md`, `REQUIREMENTS-EXTRACTED.md`, and `STATUS.md` are preserved planning and implementation records. They explain intent and history but are not authoritative for current behavior; verify their claims against source, focused tests, and the current-state docs above.

## Development stance: earn complexity

Slack Concierge is a personal, single-operator application. Build it as an evolving simple system: ship the smallest reversible change that satisfies an observed need, learn from real use, and add the next mechanism only when evidence earns it. A current acceptance criterion, an observed failure, an upstream contract, or a non-negotiable security/data-integrity boundary can justify complexity; a hypothetical future, imagined scale, or possible P99 edge case cannot. Record worthwhile speculation as non-blocking future work instead of implementing it. Do not wait for preventable credential exposure, irreversible data loss, or a documented provider-contract violation to occur.

Every new component, abstraction, fallback, retry path, cache, queue, worker, scheduler, poller, reconciliation pass, or durable state must be the minimum sufficient response to that evidence. Prefer the provider's native contract and the direct path through the existing owner. Healthy idle systems should do no recurring application work unless an external protocol requires liveness. Prefer event delivery and explicit lag, disconnect, or lifecycle signals over periodic repair. If recurring or accumulating work is genuinely required, state before implementation: its trigger, work per trigger, growth variable, current-cardinality cost, idle cost, bound, stop/retirement condition, and why a simpler event-driven or on-demand path is insufficient. An unbounded answer is a design blocker, not a future optimization.

Implementation and review agents enforce the same evidence gate. Review against the real operating profile and approved scope; do not turn speculative hardening into a ship blocker or preserve an unjustified mechanism merely because it already exists. Reject machinery whose complexity exceeds the demonstrated problem, and prefer deletion or simplification when new evidence makes an old fallback unnecessary. Use a focused performance/complexity review only when a change actually introduces long-lived background work, persistent growth, a full-collection scan, or cost coupled to retained history or mapping count; quantify that path rather than adding a standing reviewer to every change.

## Working invariants

- Respect the lifecycle ownership map in [the turn lifecycle architecture](docs/architecture/TURN-LIFECYCLE.md). Extend the responsible component instead of adding another orchestration branch to `bot/src/index.ts`.
- Serialize provider work by durable `session_id` FIFO. Contention remains an ownerless queued turn with a monotonic Slack status projection; only the queue coordinator may promote it, and both the deployment gate and process-local drain close promotion.
- Treat every provider, Slack, process, and SQLite boundary as non-atomic. Persist intent before side effects, use stable identities for retries, preserve ambiguous outcomes, prove a prior owner dead before recovery, and keep confirmed response delivery monotonic.
- Never reconstruct comparison or fork history from raw Slack text when the canonical provider input or exact provider boundary is unproven. Reject an unrepresentable history explicitly rather than contaminating another session.
- Claim and classify each Slack user input durably before routing or capture side effects. Live-thread steering and deployment drain routing must be decided before command-shaped capture.
- Keep user-visible terminal projections durable. Heartbeats may be lossy; terminal status, cumulative summary, failure notices, response delivery, and hourglass cleanup must be delivered, retried, or explicitly parked by their owning projection.
- Keep provider-generated Slack artifacts turn-owned and durable. A turn may advertise and scan only its exact random-token staging directory, `<cwd>/.artifacts/turn-<turn-id>-<ownership-token>/`; reject symlinks, persist immutable per-file delivery intent before response side effects, retry only explicit Slack rate-limit rejections, and park transport failures or dead-owner uploads as ambiguous instead of risking a duplicate. Never infer ownership from timestamps in a shared directory or upload a sibling turn's files.
- Preserve external-ingress compatibility and least privilege. Capture changes must keep the historical `/audio` contract, route-security coverage, the credential-free public ingress boundary, systemd's unit-private credential semantics, and [the capture architecture](docs/architecture/CAPTURE-INGRESS.md) in sync. Only the trusted Concierge service may hold the Slack credential used for capture delivery.
- Keep service-peer deployment non-interactive and fail before closing admission when Git origin is unreadable. The deploy entrypoints own their credential environment; callers must not reconstruct or inject GitHub tokens.
- Keep agent-requested deployment and post-deploy verification one durable workflow. Coalesce requests into one active target run, re-prove the deployed commit and unchanged current service invocation immediately before success, wake each exact persisted idle provider-session/Slack-thread mapping once, and emit notices rather than provider turns for failed, ambiguous, wrong-commit, non-idle-session, or mapping-drift outcomes. A resumed managed provider thread may retain its original shell environment: validate the exact turn first, then resolve only the single owned running turn in the same persisted session/channel/thread; reject zero, multiple, or mapping-drift candidates. Never substitute a fresh provider session after restart or replay after provider admission becomes ambiguous.
- Keep persistent goals and wait mechanisms scoped to development and implementation. Persistent goals, polling loops, background waiters, scheduled wakes, and repeated status checks are valid for implementation and sub-agent coordination. They must never wait for, monitor, or verify a Concierge deployment, and deployment completion must never be a persistent goal's success condition. At the deployment boundary, durably hand the request to the detached supervisor, conclude the development goal, and end the provider turn. The detached workflow owns drain, activation, health proof, notification, and exact-session wake; follow-up verification runs only through that persisted wake or a later user-initiated turn after notification. A provider turn that resumes while the workflow is draining is active work and can indefinitely prevent the zero-active-turn gate.
- Keep the deployment-repair control plane fail-closed during staged rollout. The protected root kernel is the only control-DB, canonical-Git, release, provider-admission, and notifier-effect writer; role-specific sockets fix caller identity; the non-root coordinator and bot submit typed requests only. Only bot `intent.request` may load application deployment state; operator, runner, and coordinator control commands must remain independent of `CONCIERGE_STATE_DIR`. A repair worker gets one standalone remote-free repository and incident capability; a fresh review worker gets only a root-owned read-only snapshot. Persist worker and per-turn provider launch admission before either side effect; any restart after provider admission is ambiguous and must park rather than replay a bound turn or create another session. Incrementally bound adapter requests and streamed responses, persist and reconcile pending capability rotation before resuming an exact repair session, and reconcile ambiguous deterministic notices without reposting. Declare persistent namespace paths through repository-owned tmpfiles and order them before units; `ReadWritePaths` is resolved before `ExecStartPre`, so a service cannot create its own missing namespace source path. Never invoke Git as root against a worker-owned repository: inspect and export it as the repair UID inside the no-network Bubblewrap boundary, then pass inert archive/patch bytes across the root boundary. The real provider credential stays inside the adapter, and integration requires the unchanged origin base, installed path policy and enforcement digests, exact reviewed tree, independent `SHIP`, and a non-force push. `CONCIERGE_DEPLOYMENT_CONTROL_ENABLED`, `CONCIERGE_ENABLE_CONTROL_REQUESTS`, and `CONCIERGE_AUTONOMOUS_REPAIR_ENABLED` remain disabled until the documented non-root application candidate, end-to-end incident, real-unit security-negative, and live rollback gates all pass. `deploy.sh` remains the operator fallback until that cutover is verified.
- Keep normal deploy readiness independent of best-effort Canvas maintenance. Ordinary startup opens Slack and capture delivery before refreshing Canvases, and Canvas maintenance must not consume interactive Slack rate-limit capacity; only a persisted `canvas_required` cutover may refresh them before `concierge_bot_online`.
- Keep Codex Remote observational and mapping-safe. Slack starts sessions; the shared managed App Server owns their lifetime; only uniquely mapped external follow-ups may project into an existing Slack thread; never synthesize a Slack root for an unmapped provider session.
- Keep shared Codex App Server restart coordination inside Concierge's admission boundary. The Codex daemon owns provider-thread runtime; this repository owns the host startup integration and restart-safety policy because `concierge-bot.service` starts the already-bootstrapped daemon. Concierge and Codex Remote are clients of its Unix socket. Do not run `codex app-server daemon bootstrap`, enable its updater, or restart the daemon as incidental setup: in Codex 0.149.1 the updater initiates restart after installing a new version and force-kills after a 60-second turn-drain grace period. Installation may be staged while the service runs; activation requires an explicit maintenance boundary that closes Concierge admission and proves provider work idle. The canonical procedure is [the Codex App Server runbook](docs/runbooks/CODEX-APP-SERVER.md).
- Treat `notes/TODOS.md` as the canonical high-level action index. Slack Lists is a read-only outbound projection with transient row IDs, never an input surface, prompt context, durable item identity, agent-output control protocol, design document, requirements record, research log, or work journal. Keep each agent-authored row to one concise action or pointer. Put material context in the appropriate Git-tracked `docs/` file and give the row a bare durable URL to it; the List projector renders bare URLs as native links while preserving canonical text. Multi-paragraph rows remain a capture and round-trip format for user-authored detail, not a place for agents to accumulate work. File changes are watched outside the interactive turn queue and List API calls use an isolated rate-limit lane.
- Run managed-project scaffold apply only through the reviewed cutover wrapper after its branch is integrated into `main`. Exact exception fingerprints, persisted per-repository propagation intent, the existing drain/capture gates, durable pre-mutation cutover state, and strict Slack-visible Canvas refresh are one fail-closed boundary.

Any lifecycle change needs a focused state-transition test and a multi-turn test proving that later heartbeats cannot overwrite the thread's cumulative status. Update the applicable current-state document in the same commit whenever a documented subsystem contract or ownership boundary changes.

## Executable authorities

Do not duplicate these values in agent instructions:

| Concern | Authority |
| --- | --- |
| Provider aliases, defaults, models, and parser rules | `bot/src/aliases.ts` and `bot/tests/aliases.test.ts` |
| Slack app features and OAuth scopes | `slack-app-manifest.json` |
| External capture routes and limits | `config/capture-routes.toml` |
| Capture queue ownership and delivery | `bot/src/capture-state.ts`, `bot/src/capture-queue-api.ts`, `bot/src/capture-delivery-worker.ts`, and focused capture tests |
| Primary and capture service definitions | `systemd/concierge-bot.service`, `systemd/agent-inbox.service`, and `systemd/concierge-capture.conf` |
| Runtime state transitions and schema | `bot/src/state.ts` plus the focused `bot/tests/*` state/lifecycle tests |
| Provider-generated Slack artifact ownership and delivery | `bot/src/artifacts.ts`, `bot/src/artifact-delivery-worker.ts`, artifact state in `bot/src/state.ts`, coordinator/startup call sites, and focused artifact/turn-execution tests |
| Channel Canvas rendering and refresh | `bot/src/canvas.ts`, its callers in `bot/src/index.ts` and `bot/src/turn-execution.ts`, and `bot/tests/canvas.test.ts` |
| Managed-project creation, adoption, migration, Git propagation, and cutover state | `bot/src/project-scaffold.ts`, `bot/src/project-registry.ts`, `bot/src/project-migration.ts`, `bot/src/project-git.ts`, `bot/src/project-cutover-state.ts`, their CLI callers, `bot/scripts/project-scaffold-cutover.sh`, and focused project scaffold tests |
| Deploy behavior and health gates | `bot/scripts/deploy.sh`, `bot/scripts/bootstrap-deploy.sh`, health scripts, and `bot/tests/deploy.test.ts` |
| Deployment batching, protected repair state, immutable release provenance, post-deploy wake turns, and failure notices | `bot/src/deployment-state.ts`, `bot/src/deployment-worker.ts`, `bot/scripts/deploy-state.ts`, `deployment-control/`, `config/deployment-repair-policy.toml`, `bot/src/deployment-repair/`, `bot/scripts/deployment-repair/`, provider environment plumbing, and focused deployment tests |

All Slack OAuth scope changes are manifest-first; never edit scopes only in Slack's UI. Deploy with `bot/scripts/deploy.sh`, never by editing installed systemd units or project files on the service peer.

## Validation

Run the smallest focused Bun test during iteration from `bot/`, for example:

```bash
bun test tests/aliases.test.ts
```

After the documentation and implementation reach a milestone, run the full gate once:

```bash
cd bot && bun test
```

For an instruction-only change, also verify repository links and the `CLAUDE.md -> AGENTS.md` symlink, search the whole repository for stale moved references, and inspect the complete diff for lost or duplicated authority.
