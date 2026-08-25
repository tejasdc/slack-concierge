# Deployment repair control plane

## Current rollout state

The deployment repair control plane is implemented as a staged, fail-closed
subsystem. Its protected kernel, dedicated SQLite state, typed Unix-socket
protocol, non-root coordinator, immutable release builder, stable application
launcher, deterministic notifier, and exact-session handoff projection are
installed by the normal deploy path. Normal deployment now prepares an exact
immutable candidate, activates it through the protected release manager,
promotes it only after the final same-invocation health proof, and restores the
recorded last-known-good release before reopening admission when a post-activation
failure is safely reversible. Installation does not authorize autonomous repair:
both
`CONCIERGE_DEPLOYMENT_CONTROL_ENABLED` and
`CONCIERGE_ENABLE_CONTROL_REQUESTS` remain `0` in the checked-in units, and
`CONCIERGE_AUTONOMOUS_REPAIR_ENABLED` remains `0`.

These switches may change only after the rollout gates in the accepted
[deployment repair design](../plans/2026-08-24-deployment-repair-agent.md) pass.
Until then, the existing deployment batch is the runtime authority and
`bot/scripts/deploy.sh` remains the operator recovery path.

## Ownership

`deployment-control/kernel/` is the protected root trust base. It is the only
writer of `/root/.local/state/concierge-deployment/control.db`, and every caller
uses one role-specific Unix socket. Socket selection fixes the caller role;
caller-supplied JSON cannot upgrade it. The kernel validates command kind,
target, payload identity, expected entity identity and state, and idempotency
key before a state transition or external effect.

The `concierge-deploy` coordinator can reconcile typed state but cannot open the
control database, canonical Git metadata, systemd control surfaces, installed
kernel, or another role's socket. Bootstrap-disabled reconciliation performs no
state reads or mutations.

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

## Durable state

The control database owns commands, intents, desired-commit generations,
attempts, attempt results, incidents, handoffs, immutable release provenance,
reviews, learning outcomes, and append-only events. An idempotency key can be
replayed only with the same caller, command, and full request digest. A command
whose external admission cannot be proven is recorded as ambiguous and is not
automatically replayed.

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
lockfile digest.

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

## Activation gates still outstanding

Automatic request reconciliation and repair remain disabled until all of these
are evidenced against the real units and paths:

- production proof of stable-pointer activation, exact health, safe restoration,
  and notifier identity/readback against the real service;
- a trusted provider adapter that does not expose provider credentials or run
  repair tools through the current root App Server execution boundary;
- non-root application-candidate containment;
- repair/review repository isolation, policy/review import, and learning gates;
- the complete security-negative matrix and a contained rollback drill.

The disabled state is a safety property, not an implicit readiness claim.

## Executable authorities

- Control schema and transitions: `deployment-control/kernel/state.ts`
- Command protocol and role policy: `deployment-control/kernel/protocol.ts`
- Protected effects: `deployment-control/kernel/handler.ts` and
  `deployment-control/kernel/releases.ts`
- Socket ownership: `deployment-control/kernel/server.ts`
- Supervisor decisions: `deployment-control/coordinator/index.ts`
- Repair-owned path policy: `config/deployment-repair-policy.toml`
- Bot handoff adapter: `bot/src/deployment-repair/`
- Installation and units: `bot/scripts/deployment-repair/` and `systemd/`
- Focused proof: `bot/tests/deployment-repair/`
