# Slack Concierge agent guide

Slack Concierge is a Bun/TypeScript Slack bot that routes messages to Codex or Claude Code, preserves provider sessions, and delivers durable Slack-visible turn state. Treat this file as the routing layer; use the linked current-state documentation and focused tests for subsystem detail.

## Response contract

Every final response delivered through Concierge starts with `TL;DR:`. Make it a concise cumulative summary of the visible Slack thread, covering every request and delivered outcome through the current turn, then give the detailed response.

## Start here

- [Documentation index](docs/README.md) — current architecture, runbooks, reviewed plans, incidents, and their authority boundaries.

The top-level `DESIGN.md`, `IMPLEMENTATION.md`, `REQUIREMENTS.md`, `REQUIREMENTS-EXTRACTED.md`, and `STATUS.md` are preserved planning and implementation records. They explain intent and history but are not authoritative for current behavior; verify their claims against source, focused tests, and the current-state docs above.

## Working invariants

- Respect the lifecycle ownership map in [the turn lifecycle architecture](docs/architecture/TURN-LIFECYCLE.md). Extend the responsible component instead of adding another orchestration branch to `bot/src/index.ts`.
- Treat every provider, Slack, process, and SQLite boundary as non-atomic. Persist intent before side effects, use stable identities for retries, preserve ambiguous outcomes, prove a prior owner dead before recovery, and keep confirmed response delivery monotonic.
- Never reconstruct comparison or fork history from raw Slack text when the canonical provider input or exact provider boundary is unproven. Reject an unrepresentable history explicitly rather than contaminating another session.
- Claim and classify each Slack user input durably before routing or capture side effects. Live-thread steering and deployment drain routing must be decided before command-shaped capture.
- Keep user-visible terminal projections durable. Heartbeats may be lossy; terminal status, cumulative summary, failure notices, response delivery, and hourglass cleanup must be delivered, retried, or explicitly parked by their owning projection.
- Preserve external-ingress compatibility and least privilege. Capture changes must keep the historical `/audio` contract, route-security coverage, the credential-free public ingress boundary, and [the capture architecture](docs/architecture/CAPTURE-INGRESS.md) in sync. Only the trusted Concierge service may hold the Slack credential used for capture delivery.
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
| Channel Canvas rendering and refresh | `bot/src/canvas.ts`, its callers in `bot/src/index.ts` and `bot/src/turn-execution.ts`, and `bot/tests/canvas.test.ts` |
| Managed-project creation, adoption, migration, Git propagation, and cutover state | `bot/src/project-scaffold.ts`, `bot/src/project-registry.ts`, `bot/src/project-migration.ts`, `bot/src/project-git.ts`, `bot/src/project-cutover-state.ts`, their CLI callers, `bot/scripts/project-scaffold-cutover.sh`, and focused project scaffold tests |
| Deploy behavior and health gates | `bot/scripts/deploy.sh`, `bot/scripts/bootstrap-deploy.sh`, health scripts, and `bot/tests/deploy.test.ts` |

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
