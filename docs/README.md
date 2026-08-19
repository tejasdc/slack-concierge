# Slack Concierge documentation

Use this index to distinguish current operational truth from reviewed history. Source, manifests, config, and focused tests remain authoritative for executable behavior and constants.

## Architecture

- [Turn lifecycle and durable projections](architecture/TURN-LIFECYCLE.md) — runtime ownership, Slack-visible terminal projections, recovery, and provider-process liveness.
- [Provider sessions, comparisons, and forks](architecture/PROVIDER-SESSIONS.md) — provider binding and the two explicit child-session surfaces.
- [Slack input, steering, and channel surfaces](architecture/SLACK-INPUT.md) — durable input classification, steering, inline capture, Canvas, links, and files.
- [Capture ingress](architecture/CAPTURE-INGRESS.md) — external routes, request authentication, durable delivery, deployment gating, and operational checks.

## Runbooks

- [Deployment and service operations](runbooks/DEPLOYMENT.md) — drain-aware rollout, service shutdown, runtime dependencies, and restore boundaries.
- [Slack app administration](runbooks/SLACK-APP-ADMINISTRATION.md) — manifest-first app features, OAuth scopes, reinstall, and verification.
- [Channel creation, adoption, and scaffold migration](runbooks/CHANNEL-ADOPTION.md) — canonical project shape and safe reconciliation workflows.
- [systemd unit inventory](../systemd/README.md) — repository-owned units and pointers to their runbooks.

## Plans

- [Agent instructions and canonical project scaffold](plans/2026-08-19-agent-instructions-and-project-scaffold.md) — approved implementation plan for the current instruction/scaffold work.
- `../DESIGN.md`, `../IMPLEMENTATION.md`, `../REQUIREMENTS.md`, `../REQUIREMENTS-EXTRACTED.md`, and `../STATUS.md` are preserved historical design, requirements, and implementation records. They are useful rationale, not authority for current behavior.

## Incidents

- [Drain hang blocks all channels (2026-08-12)](incidents/2026-08-12-drain-hang-nested-codex.md) — dated evidence and lessons. Validate any present-tense inference against current architecture and source.

Add current behavior to architecture, repeatable operator procedures to runbooks, reviewed intent to plans, and dated failures to incidents. Do not add an integrations category; integration-specific behavior belongs with the architecture or runbook that owns it.
