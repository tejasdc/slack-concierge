# Slack Concierge documentation

Use this index to distinguish current operational truth from reviewed history. Source, manifests, config, and focused tests remain authoritative for executable behavior and constants.

## Architecture

- [Turn lifecycle and durable projections](architecture/TURN-LIFECYCLE.md) — runtime ownership, Slack-visible terminal projections, recovery, and provider-process liveness.
- [Provider sessions, comparisons, and forks](architecture/PROVIDER-SESSIONS.md) — provider binding and the two explicit child-session surfaces.
- [Slack input, steering, and channel surfaces](architecture/SLACK-INPUT.md) — durable input classification, steering, inline capture, Canvas, links, and files.
- [Capture ingress](architecture/CAPTURE-INGRESS.md) — external routes, request authentication, durable delivery, deployment gating, and operational checks.
- [Deployment repair control plane](architecture/DEPLOYMENT-REPAIR.md) — staged protected state, role-separated commands, immutable releases, exact-session handoffs, and activation gates.

## Runbooks

- [Deployment and service operations](runbooks/DEPLOYMENT.md) — drain-aware rollout, service shutdown, runtime dependencies, and restore boundaries.
- [Slack app administration](runbooks/SLACK-APP-ADMINISTRATION.md) — manifest-first app features, OAuth scopes, reinstall, and verification.
- [Channel creation, adoption, and scaffold migration](runbooks/CHANNEL-ADOPTION.md) — canonical project shape and safe reconciliation workflows.
- [systemd unit inventory](../systemd/README.md) — repository-owned units and pointers to their runbooks.

## Plans

- [Durable per-session turn queue](plans/2026-08-20-durable-session-turn-queue.md) — reviewed FIFO admission, restart, drain, and Slack-status contract for contending provider turns.
- [Codex Remote and canonical TODO synchronization](plans/2026-08-19-codex-remote-and-todo-sync.md) — historical implementation plan; current one-way TODO projection behavior is documented in [Slack input ownership](architecture/SLACK-INPUT.md).
- [Agent instructions and canonical project scaffold](plans/2026-08-19-agent-instructions-and-project-scaffold.md) — approved implementation plan for the current instruction/scaffold work.
- [Post-deploy agent wake](plans/2026-08-20-post-deploy-agent-wake.md) — implemented durable deployment batching and exact-session live verification contract.
- [Deployment repair agent](plans/2026-08-24-deployment-repair-agent.md) — accepted design and implementation authority for attempt-independent deployment intents, safe last-known-good restoration, supervisor-launched repair incidents, and reviewed progressive learning.
- [Deployment repair activation](plans/2026-08-24-feat-activate-deployment-repair-plan.md) — independently approved executable rollout contract for the supervisor owner, non-root provider boundary, A/B coordinator, canary, evidence review, rollback, and atomic production activation.
- [Pebble webhook with Concierge-owned Slack delivery](plans/2026-08-19-pebble-concierge-handoff.md) — bounded implementation plan for the external Pebble transcript flow.
- [Future plans](future-plans/README.md) — three independent, self-contained proposals for provider security, disaster recovery, and Monologue reliability.
- [Design archive](archive/README.md) — superseded source explorations retained for provenance only; never current implementation authority.
- `../DESIGN.md`, `../IMPLEMENTATION.md`, `../REQUIREMENTS.md`, `../REQUIREMENTS-EXTRACTED.md`, and `../STATUS.md` are preserved historical design, requirements, and implementation records. They are useful rationale, not authority for current behavior.

## Incidents

- [Drain hang blocks all channels (2026-08-12)](incidents/2026-08-12-drain-hang-nested-codex.md) — dated evidence and lessons. Validate any present-tense inference against current architecture and source.
- [Pebble webhook review sprawl and rollout failures (2026-08-19)](incidents/2026-08-19-pebble-review-sprawl.md) — how an unbounded review contract expanded a bounded personal-system feature into unrelated platform work, and the proportional scope/review rules adopted afterward.

Add current behavior to architecture, repeatable operator procedures to runbooks, reviewed intent to plans, and dated failures to incidents. Do not add an integrations category; integration-specific behavior belongs with the architecture or runbook that owns it.
