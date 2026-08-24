---
title: "Activate the deployment repair control plane"
type: feat
status: in_progress
date: 2026-08-24
owner: supervisor-launched rollout agent
---

# Activate the deployment repair control plane

## Outcome

Complete the deployment-repair feature end to end. A supervisor-launched agent
outside Concierge owns bootstrap, real-host proof, independent review,
activation, rollback, and final verification. After activation, the protected
kernel and systemd-supervised coordinator own continuous deployment monitoring;
one isolated repair session is created per incident.

This rollout is complete only when a bounded synthetic production incident has
been repaired, independently reviewed, fast-forward integrated, deployed,
verified, and recorded without human mutation of protected runtime state.

## Current facts

- The protected kernel, provider adapter, non-root coordinator, repair/review
  worker templates, immutable release manager, and notifier are implemented and
  installed by normal deploy.
- Runtime activation is currently impossible because all three switches are
  hard-coded to `0` and no executable gate runner or durable gate receipt exists.
- `concierge-bot.service` still runs as unrestricted root and reaches root-owned
  provider/session transport directly. The accepted design forbids autonomous
  repair until production runs as `concierge-bot` with provider access brokered
  through trusted typed IPC.
- Coordinator installation currently moves one `current` symlink. The accepted
  A/B slot, generation handoff, probation watchdog, and incumbent recovery are
  not implemented and are part of this rollout—not deferred hardening.
- Replacement deployment `e756bcec-ba01-4b50-b08f-a39bd6280c12` is waiting for
  live provider turn `422`. That turn is proven active through provider
  `thread/read` and must not be interrupted.
- No product decisions remain open. The rollout agent owns execution and reports
  only genuine safety or external-authority blockers.

## Operating profile

One trusted operator, one Linux service peer, one canonical GitHub repository,
and one production Concierge target. The repair boundary handles credentials,
root systemd effects, production activation, Git integration, and Slack output,
so the cutover is high risk even though the operator and target counts are one.

## Invariants

1. The root kernel remains the only writer of deployment-control state and the
   only authority that changes the runtime activation mode.
2. A root-kernel-owned activation generation, not process environment, is the
   authorization boundary for intent routing, attempt reconciliation, and
   autonomous incident repair. Partial enablement is invalid.
3. Gate evidence is bound through one closed versioned identity manifest to
   every executable, policy, charter, schema, unit-security profile, and runtime
   artifact that produces, reviews, authorizes, or acts on evidence. Any drift
   invalidates authorization.
4. Every external effect is preceded by durable intent and followed by durable
   evidence or an explicit ambiguous/failed outcome.
5. Activation occurs only while provider and capture admission are held and no
   provider turn is active. Failure restores disabled mode before admission can
   reopen.
6. Autonomous proof uses actual installed systemd principals, mounts, sockets,
   paths, credentials, releases, provider adapter, notifier, and health probes.
   Mock-only or source-only evidence cannot pass a live gate.
7. The rollout owner cannot submit a review verdict. Kernel-launched fresh
   review workers submit separate implementation and live-evidence verdicts
   through the review-role socket, each bound to its exact digest and provider
   session.
8. A failed synthetic or rollback proof never gets relabeled as success. It
   leaves the system disabled and records the smallest next safe action.
9. Existing `deploy.sh` stays available until final autonomous verification
   succeeds.

## Durable lifecycle

```text
staged
  -> containing_application
  -> staging_coordinator
  -> proving
  -> review_pending
  -> authorized
  -> canary_activating
  -> canary_probation
  -> recovery_proving
  -> evidence_review_pending
  -> production_authorized
  -> production_activating
  -> production_probation
  -> verified

Any unexpected failure in a nonterminal state
  -> revoking
  -> staged | parked
```

The rollout record stores its next step and append-only history; a status label
alone is not treated as workflow history. The kernel fences commands by rollout
ID, exclusive owner lease, expected state, installed-identity digest, activation
generation, evidence digest, and idempotency key.

## Executable rollout owner

`concierge-deployment-rollout@.service` is the one repository-owned systemd
entrypoint. It runs as a dedicated non-root `concierge-rollout` principal outside
the bot, coordinator, repair, and review cgroups. Its only control capability is
a role-fixed `rollout.sock`; it cannot open the control database, systemd, Git
credentials, provider credentials, Slack credentials, release pointer, or other
role sockets.

Before doing work, the service claims one kernel-persisted singleton lease with
its rollout UUID, systemd invocation ID, PID, boot ID, and process start ticks.
Every rollout command carries that fence. systemd restarts the exact instance;
the kernel allows takeover only after proving the recorded owner dead. A dead
owner may resume a durable step whose effects are proved absent or complete; an
ambiguous admitted effect parks instead of replaying. The unit is the durable
executor; this Slack/provider session is the accountable rollout operator and
status surface, not an irreplaceable process owner.

## Durable authority and evidence

Add kernel-owned rollout and check records to the existing deployment control
database:

- rollout ID, target, state, start/completion timestamps;
- rollout service unit, invocation identity, exclusive lease, heartbeat, and
  dead-owner recovery disposition;
- exact installed/runtime identity manifest and its digest;
- one row per named proof with `prepared`, `running`, `passed`, `failed`, or
  `ambiguous` state;
- bounded structured evidence, command/probe version, real UID, systemd unit,
  attempted resource, expected result, actual result, and evidence digest;
- distinct implementation-review and live-evidence-review identities, provider
  sessions, verdicts, reviewed digests, and times;
- coordinator incumbent/candidate slots, activation generations, acknowledgments,
  handshake, probation deadline, watchdog observations, and revocation result;
- activation/revocation intent and resulting bot/coordinator invocation IDs;
- final application SHA, last-known-good release ID, probe results, admission
  state, and synthetic incident ID.

The closed identity manifest is schema-versioned and includes the kernel,
coordinator incumbent and candidate, provider adapter, bot provider broker,
application artifact, builder, repair/review/rollout workers, charters, result
schemas, Bun/Codex runtimes, notifier, supervisor and evidence-exporter code,
repair policy, enforcement engine, effective systemd unit properties, current
last-known-good release, and health-probe versions. The kernel recomputes it
before each review, authorization, activation, and admission release.

Raw logs remain in journald. The control database stores redacted, bounded proof
records and hashes; it never stores secrets or full provider transcripts.

## Non-root application prerequisite

Production moves to the existing `concierge-bot` principal before autonomous
proof. Application state moves through a drain-held, backup-first, journaled
migration from the root-only location to `/var/lib/concierge-bot`; the migration
records source/destination inode, owner, mode, database/WAL/SHM state, digest,
and rollback path before mutation. The immutable release is root-owned and
read-only; the bot receives write access only to its state, artifact, cache, and
explicit scratch paths.

The bot receives Slack and capture capabilities only through systemd credentials.
It receives no GitHub, root provider-auth home, deployment control DB, release,
notifier, or systemd authority. A root-owned broker launcher may supervise the
boundary, but it never executes prompt-bearing provider code. The persistent
Codex App Server, Claude process, bridge, and every tool subprocess run as the
dedicated unprivileged `concierge-provider` principal inside a systemd profile
with `ProtectSystem=strict`, private temporary/storage namespaces, hidden home
and process material, no ambient capabilities, and read-write mounts only for
the exact project roots in the root-owned managed-project registry. Project
checkouts needed by providers are migrated to stable non-root service paths;
arbitrary caller paths are not bind-mounted.

The bot-role socket exposes typed equivalents for every current provider
contract: start, resume, steer, interrupt, fork, thread read/list, model list,
observer subscribe/unsubscribe, and bounded event streaming. The broker derives
the project root, additional roots, provider identity, sandbox, approval policy,
environment allowlist, model allowlist, and session binding from root-owned
policy plus the durable Slack mapping. It rejects caller-selected sandbox,
environment, executable, credential path, unmanaged cwd/additional directory,
raw JSON-RPC method, or provider-session identity. `danger-full-access`, where a
provider requires it for repository work, means unrestricted only inside the
unprivileged service's kernel-enforced mount and process boundary; it cannot
become host-root execution. The bot cannot access the App Server control socket
or provider credential files directly. Existing provider-session UUID and Slack
thread mappings survive the drain-held path/auth migration and are verified by
typed history reads before admission reopens.

Rollback restores the recorded root service/state authority only while autonomous
mode is still disabled and only from the migration journal. After activation,
the root application layout is not a valid fallback.

## Coordinator A/B prerequisite

The installer writes coordinator bundles into immutable A/B slots without
moving the active generation. The incumbent remains live while the kernel runs
fixtures and a read-only reconciliation probe against the candidate. A
candidate systemd instance may acknowledge a pending activation generation but
cannot mutate target state until the kernel exposes that generation.

The kernel grants exactly one generation. Every coordinator command carries it;
the kernel rejects the incumbent after handoff and rejects the candidate before
handoff. A root-kernel watchdog owns the probation deadline and revokes to the
recoverable incumbent when the candidate dies, stops heartbeating, fails its
handshake, or attempts a forbidden effect. Promotion occurs only after the
bounded probation and reconciliation proof. Real death and protected-surface
denial drills are mandatory activation checks.

## Activation mechanism

Environment flags become disabled bootstrap defaults only; they never authorize
behavior. The kernel owns an activation generation with the capability set
`intent_routing + attempt_reconciliation + autonomous_repair`. Bot intent
requests and every coordinator mutation include the generation received from a
fresh kernel status read. The kernel rejects a missing, pending, partial,
revoked, stale, or unacknowledged generation.

During cutover, bot and candidate coordinator start in pending mode and
acknowledge the same generation. Only a typed rollout `activation.expose`
command may atomically expose a complete generation. A first, rollout-only
canary generation requires an `authorized` rollout, all preactivation proofs,
and the kernel's implementation-review receipt for the exact installed identity.
It accepts only the kernel-created synthetic incident and cannot route ordinary
application intent. A production generation requires `production_authorized`,
all canary/revocation/recovery evidence frozen, and the kernel's live-evidence
review receipt for that exact phase-scoped bundle. No restart ordering creates a
partially authorized state. `activation.revoke` first permanently makes the
generation unusable in the kernel, then settles service and application
restoration effects; a revoked generation is never re-exposed.

The supervisor entrypoint runs only in the rollout systemd unit, reuses the
existing provider-drain and capture-hold contracts, and resumes the exact durable
rollout after a crash. It does not edit installed units, the control database,
or the stable release pointer directly.

## Real-host proof suite

### Bootstrap and release proof

- [ ] Finish and verify the corrected normal deployment.
- [ ] Prove exact origin/runtime SHA and unchanged service invocation.
- [ ] Prove capture and service functional health.
- [ ] Prove the current immutable release is recorded as last known good.
- [ ] Prove notifier target identity and fixed-message readback/delete.
- [ ] Complete and verify the non-root application state/credential/provider
      broker migration with exact existing-session continuity.
- [ ] Complete A/B coordinator fixture, generation handoff, handshake, watchdog,
      death, forbidden-effect, revocation, and incumbent-recovery proofs.

### Security-negative matrix

Every denial runs as the actual installed principal and unit security profile.
Each expected denial is a pass only when the target resource exists and a root
control probe proves it was otherwise reachable.

- [ ] Repair, review, builder, coordinator, and application candidates cannot
      read root, provider, Slack, capture, Git-helper, control DB, release,
      notifier, other-project, or hidden `/proc` material outside their contract.
- [ ] Repair and review tool sandboxes cannot reach arbitrary network, GitHub,
      Slack, App Server control, systemd, journald, or other process signals.
- [ ] Wrong Unix peer, role, incident, capability, state, generation, digest,
      replay, and command kind are rejected before effects.
- [ ] Git alternates, hooks, remotes, force/non-fast-forward import, origin
      movement, unreviewed tree drift, escaping links, and special files fail.
- [ ] Candidate application/coordinator cannot mutate or signal the kernel,
      watchdog, control DB, prior release, policy, pointer, canonical Git,
      notifier target, or installed units.
- [ ] Candidate hooks never run as root; artifact secrets and tampered
      digest/owner/mode/path fail prepare, promotion, and restore.
- [ ] Notifier rejects channel, text, blocks, markup, mention, link, enum, SHA,
      length, incident-state, and duplicate-send overrides; ambiguous recovery
      uses exact author/channel/UUID/template readback without reposting.
- [ ] Pre-verification learning, charter, instructions, retrieval, policy, or
      evaluator-only bypass changes cannot enter the active bundle.

### Synthetic incident

- [ ] While both admission gates remain held, create one kernel-recognized
      rollout-only canary generation with a bounded, repair-owned deterministic
      fault and no user feature intent. Canary authority is valid only for the
      exact active rollout and cannot accept ordinary requests.
- [ ] Prove one attempt and one incident are created.
- [ ] Prove the current last-known-good application remains healthy or is
      restored before repair begins.
- [ ] Prove exactly one repair worker and one resumable provider session.
- [ ] Prove the repair can modify only installed repair-owned paths.
- [ ] Prove a fresh review worker sees an immutable snapshot and returns `SHIP`.
- [ ] Prove the kernel rechecks policy/evidence/tree/origin and performs one
      non-force fast-forward integration.
- [ ] Prove forward deployment, functional health, feature wake classification,
      terminal incident notification, and durable learning.
- [ ] Revoke the canary generation after proof; its provider session and durable
      evidence remain bound to the rollout.
- [ ] Always prove the recorded compatible last-known-good pointer, runtime SHA,
      service invocation, capture health, and application health after canary
      revocation, whether or not restoration was required.

### Contained rollback drill

- [ ] Define the exact compatible last-known-good release and a deliberately
      unhealthy candidate whose failure occurs after pointer activation.
- [ ] Hold provider/capture admission and record candidate/prior identities.
- [ ] Activate the candidate and prove the health gate fails for the expected
      reason.
- [ ] Restore only the recorded compatible last-known-good release.
- [ ] Prove runtime SHA, new service invocation, capture health, service health,
      stable pointer, and released admission before marking restoration passed.
- [ ] Prove exactly one fixed restoration alert and no duplicate on
      reconciliation.

## Independent review

An external high-risk review approves only installation of the inert,
disabled-capable implementation. It is a normal deploy gate and has no runtime
activation authority; this breaks the bootstrap cycle because the incumbent
kernel need not attest to commands it does not yet implement. After that inert
bundle is installed and proved disabled, the new kernel prepares a root-owned
immutable implementation snapshot and launches a fresh review worker. Its
implementation receipt authorizes only the rollout canary generation.

After canary execution, permanent revocation, coordinator recovery, and
last-known-good proof, the kernel freezes a separate redacted live-evidence
bundle containing the rollout record, check results, installed identity
manifest, relevant unit definitions, exact commands, and journal hashes. A
second fresh kernel-launched worker reviews that phase-scoped digest. Its
live-evidence receipt alone can move the rollout through
`evidence_review_pending -> production_authorized` and authorize allocation of
a fresh production generation. Both workers receive no mutation authority and
return `SHIP` or `NO_SHIP` through the review-role socket. The rollout owner may
request and observe reviews but cannot construct or submit verdicts. Identity or
in-scope evidence drift invalidates only the corresponding receipt and returns
the rollout to its explicit pre-review state.

## Atomic activation and verification

- [ ] The externally reviewed inert implementation is deployed with every
      activation capability still kernel-disabled.
- [ ] The new kernel launches the authoritative implementation review over the
      exact installed identity; `SHIP` authorizes only a canary generation.
- [ ] Supervisor holds both admission gates and proves zero active turns.
- [ ] Kernel persists activation intent; contained bot and coordinator candidate
      acknowledge one pending rollout-only canary generation.
- [ ] Kernel exposes the canary generation atomically and begins watchdog
      probation while both admission gates remain held and ordinary requests
      remain unauthorized.
- [ ] Supervisor proves both units use the same rollout and generation, then a
      bounded autonomous incident completes without operator mutation.
- [ ] A probation fault proves generation revocation, coordinator incumbent
      recovery, and exact last-known-good application restoration when required.
- [ ] The old canary generation remains permanently revoked. Kernel freshly
      proves the last-known-good pointer, runtime SHA, service invocation,
      capture health, and application health, then freezes that phase's evidence.
- [ ] A fresh kernel-launched live-evidence review returns `SHIP`; only then does
      the kernel allocate and expose a new production generation through
      `evidence_review_pending -> production_authorized -> production_activating`.
- [ ] Functional health, exact runtime SHA, service invocation, kernel/provider
      broker/coordinator versions, and production probation pass.
- [ ] Admission releases only after a final same-generation, same-invocation
      identity recomputation and health proof.
- [ ] Kernel marks the rollout `verified`; docs identify the coordinator as the
      steady-state monitor and the supervisor entrypoint as recovery authority.

## Failure and rollback

Before final verification, any unexpected failed, ambiguous, stale, or
interrupted step invokes durable revocation: persist intent, make the activation
generation unusable first, revoke the candidate coordinator to the incumbent,
and restore the exact last-known-good application when needed. Before either
admission gate may release, always freshly prove the recorded compatible
last-known-good pointer, runtime SHA, service invocation, capture health, and
application health. If revoked authorization, incumbent ownership, or any of
those fresh proofs cannot be established, stop the affected services, keep
admission held, mark the rollout `parked`, and notify the project channel once.

## Implementation phases

### Phase 1: executable activation state

- [x] Add the `concierge-rollout` principal, role socket, singleton kernel lease,
      repository-owned rollout unit, systemd restart recovery, and dead-owner
      takeover/ambiguity rules.
- [x] Add rollout/check/review/activation state and guarded transitions to the
      protected kernel.
- [x] Add a closed executable identity manifest and recomputation boundary.
- [x] Add typed rollout/review protocol commands and snapshot projection.
- [x] Add kernel-owned complete activation generations and require them on bot
      intent and coordinator mutation commands.
- [x] Add lifecycle, idempotency, drift, partial-enable, and revocation tests.

### Phase 2: containment and recoverable coordinators

- [ ] Migrate the production application and its state to `concierge-bot` under
      a drain-held, backup-first, journaled, reversible cutover.
- [ ] Add the brokered, non-root, path-constrained provider runtime with typed
      parity for start/resume/steer/interrupt/fork/read/list/model/observer
      operations; reject caller-selected execution authority and remove direct
      bot access to root provider state.
- [ ] Add A/B coordinator slots, generation acknowledgments, handoff, handshake,
      kernel watchdog probation, promotion, revocation, and incumbent recovery.
- [ ] Prove provider-session continuity and candidate/app/coordinator denials in
      focused integration tests.

### Phase 3: supervisor and proof probes

- [ ] Add the resumable supervisor entrypoint and bounded evidence exporter.
- [ ] Add real-principal security-negative probes and exact expected-denial
      assertions.
- [ ] Add synthetic-incident and rollback-drill fixtures whose scope is
      impossible outside an active rollout.
- [ ] Update architecture, deployment runbook, systemd documentation, and
      `AGENTS.md` in the same commits.

### Phase 4: live rollout

- [ ] Run focused tests during implementation and one full Bun gate at the
      implementation milestone.
- [ ] Obtain external high-risk `SHIP` review of the inert installation diff and
      correct blockers; this receipt cannot activate runtime behavior.
- [ ] Deploy the disabled-capable rollout implementation with explicit protected
      bundle approval and verify it live.
- [ ] Use the installed kernel to obtain the authoritative implementation review
      receipt for the exact installed identity.
- [ ] Run the real-host proof suite and export its immutable evidence bundle.
- [ ] Permanently revoke the canary, always re-prove last known good, and obtain
      the kernel-launched live-evidence `SHIP` receipt.
- [ ] Activate, verify the autonomous incident, and mark rollout complete.

## Acceptance criteria

1. `snapshot` names one rollout owner, exact state, next step, completed checks,
   failed checks, evidence digest, review verdict, runtime mode, and monitoring
   owner.
2. No environment value, retained provider shell, command, or unit edit enables
   any capability without one complete current kernel activation generation.
3. Missing, mocked, stale, ambiguous, or reviewer-mismatched evidence cannot
   authorize activation.
4. Restarting the supervisor resumes from durable history without repeating an
   ambiguous external effect.
5. Real-systemd negatives, synthetic repair, and live rollback all pass against
   the installed production identities and paths.
6. One fresh review approves the exact implementation diff and another approves
   the exact live evidence digest.
7. After activation, a deployment infrastructure failure starts exactly one
   incident and one repair session; ordinary success remains quiet except for
   exact feature verification wakes.
8. Final live evidence proves the requested and deployed commit, application and
   closed control-plane identity manifest, non-root principal, provider broker,
   activation generation, service invocation, health, last known good, released
   gates, and active generation-fenced coordinator monitor.

## Non-goals

- A second deployment platform, dashboard, channel, scheduler, database, or
  general-purpose workflow engine.
- Autonomous feature redesign, protected-kernel self-modification, credential
  rotation, destructive data rollback, health bypass, or arbitrary root access.
- Interrupting or discarding currently active provider work to accelerate the
  rollout.

## Status reporting

The rollout agent reports milestones in the existing Slack thread: current
state, concrete evidence, blocker ownership, and next automatic action. It does
not ask the user to operate the host, remember a future activation, or choose
between already-decided implementation details.
