# Slack Concierge documentation

Use this index to distinguish current operational truth from reviewed history. Source, manifests, config, and focused tests remain authoritative for executable behavior and constants.

## Architecture

- [Turn lifecycle and durable projections](architecture/TURN-LIFECYCLE.md) — runtime ownership, Slack-visible terminal projections, recovery, and provider-process liveness.
- [Provider sessions, comparisons, and forks](architecture/PROVIDER-SESSIONS.md) — provider binding and the two explicit child-session surfaces.
- [Slack input, steering, and channel surfaces](architecture/SLACK-INPUT.md) — durable input classification, steering, inline capture, Canvas, links, and files.
- [Capture ingress](architecture/CAPTURE-INGRESS.md) — external routes, request authentication, durable delivery, deployment gating, and operational checks.
- [Trusted-root deployment repair](architecture/DEPLOYMENT-REPAIR.md) — immutable releases, last-known-good restoration, root repair/review sessions, integration, retry, and crash recovery.

## Runbooks

- [Deployment and autonomous repair](runbooks/DEPLOYMENT.md) — drain-aware rollout, one-time immutable cutover, root repair, service shutdown, and restore boundaries.
- [Codex App Server lifecycle](runbooks/CODEX-APP-SERVER.md) — shared-daemon ownership, updater restart semantics, version inspection, non-disruptive staging, and repair.
- [Slack app administration](runbooks/SLACK-APP-ADMINISTRATION.md) — manifest-first app features, OAuth scopes, reinstall, and verification.
- [Channel creation, adoption, and scaffold migration](runbooks/CHANNEL-ADOPTION.md) — canonical project shape and safe reconciliation workflows.
- [systemd unit inventory](../systemd/README.md) — repository-owned units and pointers to their runbooks.

## Plans

- [Durable per-session turn queue](plans/2026-08-20-durable-session-turn-queue.md) — reviewed FIFO admission, restart, drain, and Slack-status contract for contending provider turns.
- [Codex Remote and canonical TODO synchronization](plans/2026-08-19-codex-remote-and-todo-sync.md) — historical implementation plan; current one-way TODO projection behavior is documented in [Slack input ownership](architecture/SLACK-INPUT.md).
- [Event-driven Codex Remote observer](plans/2026-08-24-codex-remote-event-driven-observer.md) — reviewed replacement of periodic transcript scans with pushed App Server events and wake-driven durable delivery.
- [Preserve the Slack root request beneath its cumulative TL;DR](plans/2026-08-25-preserve-slack-root-request-with-tldr.md) — proposed Rich Text projection that keeps the original request visible, handles roots beyond 4,000 characters, and repairs the bounded set of roots already replaced.
- [Agent instructions and canonical project scaffold](plans/2026-08-19-agent-instructions-and-project-scaffold.md) — approved implementation plan for the current instruction/scaffold work.
- [Post-deploy agent wake](plans/2026-08-20-post-deploy-agent-wake.md) — implemented durable deployment batching and exact-session live verification contract.
- [Trusted-root autonomous deployment repair](plans/2026-08-25-trusted-root-autonomous-deployment-repair.md) — approved replacement of the abandoned multi-principal design with the implemented personal-server repair workflow.
- [Pebble webhook with Concierge-owned Slack delivery](plans/2026-08-19-pebble-concierge-handoff.md) — bounded implementation plan for the external Pebble transcript flow.
- [Future plans](future-plans/README.md) — three independent, self-contained proposals for provider security, disaster recovery, and Monologue reliability.
- [Design archive](archive/README.md) — superseded source explorations retained for provenance only; never current implementation authority.
- `../DESIGN.md`, `../IMPLEMENTATION.md`, `../REQUIREMENTS.md`, `../REQUIREMENTS-EXTRACTED.md`, and `../STATUS.md` are preserved historical design, requirements, and implementation records. They are useful rationale, not authority for current behavior.

## Active design research

- [Slack agent attention and progress surfaces](brainstorms/2026-08-24-slack-agent-attention-and-progress.md) — raw problem context, primary-source research, current design direction, responsibility boundaries, and unresolved client experiments for low-noise concurrent agent work.

## Incidents

- [Drain hang blocks all channels (2026-08-12)](incidents/2026-08-12-drain-hang-nested-codex.md) — dated evidence and lessons. Validate any present-tense inference against current architecture and source.
- [Codex runtime sync corruption (2026-08-24)](incidents/2026-08-24-codex-runtime-sync-corruption.md) — cross-platform package-state overwrite, unnecessary restart, non-disruptive repair, and adopted ownership boundaries.
- [Pebble webhook review sprawl and rollout failures (2026-08-19)](incidents/2026-08-19-pebble-review-sprawl.md) — how an unbounded review contract expanded a bounded personal-system feature into unrelated platform work, and the proportional scope/review rules adopted afterward.

Add current behavior to architecture, repeatable operator procedures to runbooks, exploratory problem framing and requirements to `brainstorms/`, reviewed intent to plans, and dated failures to incidents. Keep checklist rows as concise pointers to those durable records. Do not add an integrations category; integration-specific behavior belongs with the architecture or runbook that owns it.
