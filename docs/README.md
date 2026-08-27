# Slack Concierge documentation

Use this index to distinguish current operational truth from reviewed history. Source, manifests, config, and focused tests remain authoritative for executable behavior and constants.

## Architecture

- [Turn lifecycle and durable projections](architecture/TURN-LIFECYCLE.md) — runtime ownership, Slack-visible terminal projections, recovery, and provider-process liveness.
- [Provider sessions, comparisons, and forks](architecture/PROVIDER-SESSIONS.md) — provider binding and the two explicit child-session surfaces.
- [Slack input, steering, and channel surfaces](architecture/SLACK-INPUT.md) — durable input classification, steering, inline capture, Canvas, links, and files.
- [Capture ingress](architecture/CAPTURE-INGRESS.md) — external routes, request authentication, durable delivery, deployment gating, and operational checks.
- [Trusted-root deployment repair](architecture/DEPLOYMENT-REPAIR.md) — immutable releases, last-known-good restoration, root repair/review sessions, integration, retry, and crash recovery.

## Runbooks

- [Deployment and autonomous repair](runbooks/DEPLOYMENT.md) — drain-aware rollout, root repair, service shutdown, and restore boundaries.
- [Reusable Slack sandbox testing](runbooks/SANDBOX-TESTING.md) — four shared lane claims, fresh worktree-selected runs, persistent provisioning and browser profiles, screenshot evidence, and exact manual boundaries before push.
- [Live Slack integration acceptance](runbooks/LIVE-ACCEPTANCE.md) — bounded post-deployment feature proof, exact completion claims, production-noise discipline, and automated-versus-manual boundaries.
- [Codex App Server lifecycle](runbooks/CODEX-APP-SERVER.md) — shared-daemon ownership, updater restart semantics, version inspection, non-disruptive staging, and repair.
- [Slack app administration](runbooks/SLACK-APP-ADMINISTRATION.md) — manifest-first app features, OAuth scopes, reinstall, and verification.
- [Router action helper](runbooks/ROUTER-ACTIONS.md) — user posts/resumes/uploads, bot audit replies, exact message receipts, and read-only recovery.
- [Channel creation, adoption, and scaffold migration](runbooks/CHANNEL-ADOPTION.md) — canonical project shape and safe reconciliation workflows.
- [systemd unit inventory](../systemd/README.md) — repository-owned units and pointers to their runbooks.

## Plans

- [Durable per-session turn queue](plans/2026-08-20-durable-session-turn-queue.md) — reviewed FIFO admission, restart, drain, and Slack-status contract for contending provider turns.
- [Codex Remote and canonical TODO synchronization](plans/2026-08-19-codex-remote-and-todo-sync.md) — historical implementation plan; current one-way TODO projection behavior is documented in [Slack input ownership](architecture/SLACK-INPUT.md).
- [Event-driven Codex Remote observer](plans/2026-08-24-codex-remote-event-driven-observer.md) — reviewed replacement of periodic transcript scans with pushed App Server events and wake-driven durable delivery.
- [Preserve the Slack root request above its cumulative TL;DR](plans/2026-08-25-preserve-slack-root-request-with-tldr.md) — implemented minimal projection that keeps the request above the summary, truncates only the request at Slack's text limit, and does not repair historical roots.
- [Native Agent progress messages](plans/2026-08-26-agent-progress-messages.md) — replaces expiring streams with in-place updates, payload-driven continuation replies, persistent planning cards, and stream-independent native Stop.
- [Compact Agent progress](plans/2026-08-26-compact-agent-progress.md) — latest commentary, commentary-only history, elapsed time inside active Thinking, and Steps in one message.
- [Agent instructions and canonical project scaffold](plans/2026-08-19-agent-instructions-and-project-scaffold.md) — approved implementation plan for the current instruction/scaffold work.
- [Post-deploy agent wake](plans/2026-08-20-post-deploy-agent-wake.md) — historical plan for the retired agent-enrollment and success-wake workflow; current deployment behavior is documented in the runbook above.
- [Trusted-root autonomous deployment repair](plans/2026-08-25-trusted-root-autonomous-deployment-repair.md) — approved replacement of the abandoned multi-principal design with the implemented personal-server repair workflow.
- [Agent-owned Slack sandbox testing](plans/2026-08-26-isolated-slack-acceptance.md) — historical design and validation record for the four-lane sandbox; current operation is in the [sandbox runbook](runbooks/SANDBOX-TESTING.md).
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

## Retrospectives

- [How a hobby bot grew a 45k-LOC enterprise process (2026-08-25)](retrospectives/2026-08-25-overengineering-retrospective.md) — measured review and design sprawl, its instruction and skill causes, and the first proportionality corrections.
- [Sandbox review authority recurrence (2026-08-27)](retrospectives/2026-08-27-sandbox-review-authority.md) — why a correctly scoped real-Slack sandbox still received speculative lifecycle blockers, which review authority caused the recurrence, and the narrower acceptance contract adopted afterward.

Add current behavior to architecture, repeatable operator procedures to runbooks, exploratory problem framing and requirements to `brainstorms/`, reviewed intent and one-time implementation records to plans, and dated failures to incidents. A completed one-time change does not become a runbook merely because its execution needed a checklist or rollback path. Keep checklist rows as concise pointers to those durable records. Do not add an integrations category; integration-specific behavior belongs with the architecture or runbook that owns it.
