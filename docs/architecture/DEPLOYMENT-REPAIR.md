# Deployment repair control plane

## Current rollout state

The deployment repair control plane is implemented as a staged, fail-closed
subsystem. Its protected kernel, dedicated SQLite state, typed Unix-socket
protocol, non-root coordinator, immutable release builder, stable application
launcher, deterministic notifier, exact-session handoff projection, trusted
provider credential adapter, and incident-scoped repair/review workers are
installed by the normal deploy path. Normal deployment now prepares an exact
immutable candidate, activates it through the protected release manager,
promotes it only after the final same-invocation health proof, and restores the
recorded last-known-good release before reopening admission when a post-activation
failure is safely reversible. Installation does not authorize autonomous repair:
both
`CONCIERGE_DEPLOYMENT_CONTROL_ENABLED` and
`CONCIERGE_ENABLE_CONTROL_REQUESTS` remain `0` in the checked-in units, and
`CONCIERGE_AUTONOMOUS_REPAIR_ENABLED` remains `0`.

The inert activation foundation is also implemented: the kernel owns a durable
rollout lifecycle, terminal proof records, separate implementation/live-evidence
review receipts, and complete canary/production activation generations. A
repository-owned `concierge-deployment-rollout@<uuid>.service` runs as the
non-root `concierge-rollout` principal, claims one PID/boot/start-ticks/systemd
invocation-fenced lease through `rollout.sock`, and is restarted by systemd.
The installed executable identity digest binds the kernel, coordinator, rollout
supervisor, pinned runtimes, immutable application release, sysusers/tmpfiles
authority, checked-in unit files, and effective unit security properties.
Installation creates no rollout and exposes no generation.

The environment switches are disabled bootstrap defaults, not authorization.
Bot deployment intents and coordinator mutations require the exact current
kernel-owned exposed production generation; neither a retained provider shell
nor a unit/environment edit can create that authority. The bot and coordinator
may only acknowledge one pending identity-bound generation. The reviewed
[activation plan](../plans/2026-08-24-feat-activate-deployment-repair-plan.md)
owns the remaining containment, A/B coordinator, proof, review, and live-cutover
work. Until those gates pass, the existing deployment batch is the runtime
authority and `bot/scripts/deploy.sh` remains the operator recovery path.

## Ownership

`deployment-control/kernel/` is the protected root trust base. It is the only
writer of `/root/.local/state/concierge-deployment/control.db`, and every caller
uses one role-specific Unix socket. Socket selection fixes the caller role;
caller-supplied JSON cannot upgrade it. The kernel validates command kind,
target, payload identity, expected entity identity and state, and idempotency
key before a state transition or external effect.

The `concierge-deploy` coordinator can reconcile typed state but cannot open the
control database, canonical Git metadata, systemd control surfaces, installed
kernel, or another role's socket. With no exposed production generation it may
read the bounded snapshot and acknowledge an exact pending generation, but it
cannot issue a deployment mutation. A canary generation authorizes only the
kernel-created rollout fixture and never ordinary intent reconciliation.

The `concierge-rollout` supervisor cannot open the control database, Git or
provider credentials, systemd control surfaces, release pointer, notifier, or
another role's socket. The kernel verifies its exact unit, invocation, PID,
boot ID, process start ticks, and installed identity before accepting lease or
transition commands. Takeover requires the prior process identity to be proven
dead; an unproven owner is never displaced.

An autonomous incident uses one resumable Codex session under the dedicated
`concierge-repair` principal. The kernel materializes the exact failed
generation as a standalone Git repository with no remote, alternates, credential
helper, or active hooks. The repair process receives a short-lived
incident-scoped adapter capability, never the existing provider credential. Its
tool sandbox has no network; only the trusted root adapter can exchange model
traffic over a loopback-only route. Adapter requests and streamed responses are
both incrementally capped at 4 MiB. Before either worker may spawn Codex, the
kernel durably records admission for that logical provider turn. A worker restart
after admission parks the turn as ambiguous whether or not its session UUID was
already bound; it never replays a prompt or issues a second fresh session. Only
an explicit review rejection or origin refresh authorizes the next repair turn.

Every proposed head is frozen into a separate root-owned read-only snapshot for
a fresh `concierge-review` session on a different configured model. The kernel
rechecks the clean committed tree, installed path policy, patch bound, focused
test evidence, evidence/policy/enforcement digests, and exact independent
`SHIP`. It then recreates that reviewed tree as one commit whose parent is the
unchanged observed `origin/main` and performs a non-force push. Neither worker
has GitHub, Slack, capture, systemd, canonical-Git, release, or control-database
authority. A `NO_SHIP` verdict resumes the exact repair session with bounded
review feedback rather than creating another incident. The kernel rotates only
the short-lived adapter capability before that resume, leaving the repository,
incident, and provider-session UUID unchanged even after the prior capability's
24-hour lifetime has elapsed. Rotation first persists a pending digest, then
performs an idempotent filesystem swap that retains the previous material until
SQLite records the new active digest; either rename crash window is recoverable.

The kernel never runs Git as root inside that worker-owned repository. Every
status, history, archive, and patch read executes as `concierge-repair` inside a
no-network Bubblewrap namespace exposing only the repository and system
binaries. The root review and integration boundaries consume inert archive and
patch bytes. If `origin/main` moves after `SHIP`, the kernel atomically refreshes
the standalone repository and incident packet from the newly observed origin,
preserves the exact repair provider session, and requires another independent
review before integration.

Each systemd worker instance hides the shared control trees and receives only
its own root-owned packet through an exact read-only bind mount inside its
private worker directory. Reusing the repair or review Unix account therefore
does not expose prior or concurrent incident capabilities to another instance.

Concierge writes only deployment intents and consumes handoffs through
`bot.sock`. An intent snapshots the exact provider session, Slack channel and
thread, model, reasoning effort, requesting turn, and requested origin-proven
commit. Managed Codex App Server threads can retain the shell environment from
their first turn even when a later turn resumes the same thread. Intent
admission therefore validates the environment's exact turn first, then falls
back only to the single owned running turn whose persisted session, channel,
and thread all match; zero, multiple, or drifted matches fail closed. A failed
attempt never terminates that intent. A later healthy
descendant creates one handoff per exact session/thread mapping; the bot first
persists an immutable application-state projection and then uses the existing
deployment-wake admission machinery. Mapping drift parks without substituting a
fresh provider session.

Only the bot's `intent.request` command loads application deployment state.
Operator, runner, and coordinator control commands remain usable from their
credential-minimal systemd units without `CONCIERGE_STATE_DIR`.

## Durable state

The control database owns commands, intents, desired-commit generations,
attempts, attempt results, incidents, handoffs, immutable release provenance,
repair runs, independent review runs, reviews, learning outcomes, and append-only
events. It also owns rollout leases and states, named proof receipts, phase-bound
review receipts, and activation generations. Canary and production are distinct
generations: revocation is permanent, production allocation requires the frozen
post-canary evidence digest and its independent `SHIP`, and exposure requires
both application and coordinator acknowledgements. An idempotency key can be
replayed only with the same caller, command, and full request digest. A command
whose external admission cannot be proven is recorded as ambiguous and is not
automatically replayed.

The root control-state directory is declared in the repository-owned tmpfiles
configuration and ordered before the kernel unit. This is a namespace
precondition: systemd resolves `ReadWritePaths` before `ExecStartPre`, so the
service must never depend on its own pre-start process to create that path.

The coordinator reconciles durable `prepared`, `sending`, and `ambiguous` Slack
notifications before advancing incident state. A `prepared` record is claimed
and sent once; later states search for the one deterministic projection and
never repost it. An outcome that remains unprovable past the bounded window
becomes terminally parked.

Only one generation, attempt, and non-parked incident can be active for the
target. Resuming a parked incident is rejected if a different incident is
active. Generation preparation fetches the canonical origin, freezes the exact
observed `origin/main` SHA, includes only pending ancestor intents, and parks
rewritten or otherwise unrepresentable requests.

## Protected bundles and immutable releases

`bot/scripts/deployment-repair/install-control-plane.ts` bundles the kernel,
release recipe, and coordinator into content-addressed, root-owned versions
under `/usr/local/lib/concierge-deployment`. The installed repair policy is
digest-bound to the kernel and builder. A protected bundle change refuses to
replace an incumbent version unless the one-shot operator promotion variable is
present. The frozen Bun dependency graph is installed separately under the
lockfile digest. Deploy restarts each already-running root/coordinator service
whose bundle or unit changed, then compares the kernel's startup-captured
version and the adapter/coordinator startup markers with the installer versions
before continuing. Repository-owned tmpfiles declarations create the worker and
coordinator roots on a clean host before systemd applies mandatory path
sandboxing.

The root release manager uses `git archive` for an exact commit, rejects
escaping or absolute links and special files, and normalizes the source to a
root-owned read-only tree. A dedicated credential-free builder runs non-root
with private networking and an empty capability set. It uses the incumbent
builder recipe and dependency snapshot, never candidate build hooks. The root
manager validates the exact artifact file set, source, runtime,
compatibility, and content digests before moving it into the immutable release
store. A stable pointer may move only after revalidation. A failed restart
restores the prior pointer; an unproved restore is an ambiguous protected
effect.

Release promotion is monotonic: `candidate -> healthy -> last_known_good`.
Direct promotion from an unverified candidate is rejected. A candidate is
classified rollback-safe only when its durable-state compatibility digest
matches the recorded last-known-good release; the first bootstrap release is
handled separately by the rollout procedure.

`concierge-bot.service` starts through the protected stable launcher. The
launcher selects only the installed immutable release pointer and retains the
canonical checkout as the first-release bootstrap fallback. The deployment
runner records its candidate and prior last-known-good identities before
activation. On a failed post-activation health gate it restores that exact
recorded release, re-runs capture and service probes, re-proves the runtime SHA
and service invocation, and only then reopens admission. Failure to prove a
healthy restore stops the application and leaves admission held.

The deterministic notifier owns fixed, typed `runtime_restored`,
`repair_parked`, and `forward_repair_succeeded` projections. Its target is
bootstrapped from the exact managed-project registry mapping, not caller input.
Normal deploy runs a live fixed-message/readback/delete preflight before release
activation. Notification intent is durable before Slack admission; an ambiguous
send performs exact author/channel/UUID/template/time-window reconciliation and
never reposts the logical message.

The pinned worker runtime includes the exact Codex binary digest, repair and
review charters, structured output schemas, and custom permission profiles.
Provider capability admission is refreshed through the protected kernel on each
worker start, so restarting the credential adapter cannot silently fall back to
a copied credential or a replacement provider session. Worker units are
enqueued only after durable launch state with non-blocking systemd admission, so
their first kernel callback cannot deadlock the kernel. Compact retrieval uses
only resolved, production-verified incident outcomes, ranks an exact failure
fingerprint first, and injects at most five summaries; raw logs and transcripts
remain outside the prompt.

## Activation gates still outstanding

Automatic request reconciliation and repair remain disabled until all of these
are evidenced against the real units and paths:

- production proof of stable-pointer activation, exact health, safe restoration,
  and notifier identity/readback against the real service;
- non-root application-candidate containment;
- real-systemd denial proofs for the installed repair/review principals and
  provider adapter, including adapter restart and exact-session resume;
- an end-to-end synthetic failure proving repair, independent review,
  fast-forward integration, forward deployment, feature wakes, and learning;
- the complete remaining security-negative matrix and a contained rollback drill.

The executable rollout state and supervisor are present but deliberately idle.
The production application is still root, the typed non-root provider broker and
A/B coordinator handoff are not installed, no real-host activation proof bundle
exists, and no activation generation has been created. Those are current
implementation prerequisites, not operator steps or deferred manual activation.

The disabled state is a safety property, not an implicit readiness claim.

## Executable authorities

- Control schema and transitions: `deployment-control/kernel/state.ts`
- Command protocol and role policy: `deployment-control/kernel/protocol.ts`
- Protected effects: `deployment-control/kernel/handler.ts` and
  `deployment-control/kernel/releases.ts`
- Isolated provider, repair, review, and Git integration boundaries:
  `deployment-control/kernel/provider-adapter.ts`, `repair-workspace.ts`,
  `repair-agent.ts`, `review-workspace.ts`, `review-agent.ts`, and
  `integration.ts`
- Socket ownership: `deployment-control/kernel/server.ts`
- Installed activation identity: `deployment-control/kernel/identity.ts`
- Supervisor decisions: `deployment-control/coordinator/index.ts`
- Rollout ownership: `deployment-control/rollout/index.ts` and
  `systemd/concierge-deployment-rollout@.service`
- Repair-owned path policy: `config/deployment-repair-policy.toml`
- Bot handoff adapter: `bot/src/deployment-repair/`
- Installation and units: `bot/scripts/deployment-repair/` and `systemd/`
- Focused proof: `bot/tests/deployment-repair/`
