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

The activation runtime is also implemented: the kernel owns a durable
rollout lifecycle, terminal proof records, separate implementation/live-evidence
review receipts, and complete canary/production activation generations. A
repository-owned `concierge-deployment-rollout@<uuid>.service` runs as the
non-root `concierge-rollout` principal, claims one PID/boot/start-ticks/systemd
invocation-fenced lease through `rollout.sock`, and is restarted by systemd. Its
reconciliation loop—not Concierge and not a retained provider turn—holds the
two admission gates, asks the protected kernel to run each root-only proof,
launches both independent reviews, drives the canary synthetic incident through
one repair session, revokes and recovers the canary, performs the contained
rollback, promotes a fresh production generation, and releases admission only
after terminal verification. Each loop iteration derives its next action from
the kernel snapshot, so a dead supervisor can resume without reconstructing
workflow history from logs.
The installed executable identity digest binds the kernel, coordinator, rollout
supervisor, pinned runtimes, immutable application release, sysusers/tmpfiles
authority, checked-in unit files, and effective unit security properties. The
kernel hashes the installed executable and policy bytes themselves and rejects
any control-plane or application manifest whose declared file hashes no longer
match those bytes; hashing a self-reported manifest alone is not identity proof.
The application portion uses stable runtime paths and executable content rather
than the release directory name or source-provenance manifest. A promotion with
identical executable bytes therefore preserves activation identity, while any
runtime-byte change invalidates it; the exact Git commit, artifact, and
last-known-good pointer remain separate kernel-owned release evidence.
Installation creates no rollout and exposes no generation. Implementation and
live-evidence review are executable boundaries rather than operator assertions:
the kernel freezes one exact read-only rollout packet and capability, persists
that authority on the review request, and launches
`concierge-deployment-rollout-review@<review-id>.service`. That fresh non-root
worker can submit only the verdict for its exact request and provider session.

The environment switches are disabled bootstrap defaults, not authorization.
Bot deployment intents and coordinator mutations require the exact current
kernel-owned exposed production generation; neither a retained provider shell
nor a unit/environment edit can create that authority. The bot and coordinator
may only acknowledge one pending identity-bound generation. The reviewed
[activation plan](../plans/2026-08-24-feat-activate-deployment-repair-plan.md)
owns the remaining inert deployment, real-host proof, independent review, and
live-cutover execution.
Until those gates pass, the existing deployment batch is the runtime
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

The kernel also owns the activation admission hold. It first persists two
random rollout-bound tokens in the protected control database, then writes
those exact tokens as `held` rows in the application deployment gate and the
capture delivery gate. A `held` application row is never abandoned merely
because the process that first wrote it exited. Normal release is accepted only
during production probation after both exact external rows and unchanged
root-exported production health are freshly proven. Recovery release is
accepted only in `revoking` after exact surviving-token ownership and
last-known-good health are freshly re-proven. If a crash leaves one row absent,
partial absence is accepted only while retrying an already persisted release or
recovery intent and only after the rollout identity, activation generation,
coordinator invocation, service invocation, and runtime evidence remain
unchanged. Either path deletes no mismatched or ordinary live-deploy gate and
settles only after both exact rows are absent. `verified` and `parked` both require the control record to be
durably `released`; unresolved older gates also block a later rollout. The
non-root rollout process therefore cannot forge, replace, or prematurely
release either gate.
If the kernel stops between deleting the two non-atomic gate rows or before
settling the control record, persisted release intent distinguishes that
operation from an ambiguous hold. The next exact supervisor lease retries
recovery before parking; a verified rollout with released gates is terminal and
needs no new lease.

Every lease-bearing command is authenticated again, including idempotent
replays: the kernel reads Linux `SO_PEERCRED` from the accepted Unix connection,
requires that peer PID to equal the command owner, rechecks the unit's live
`MainPID` and `InvocationID` through systemd, and verifies the PID's boot ID and
start ticks through `/proc`. Non-operator snapshots omit the lease tuple, so a
role peer cannot learn and replay another process's fence.

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
review receipts, exact rollout-review requests, and activation generations.
Each rollout-review request is kernel-created for one digest and worker unit;
workspace binding, launch request, systemd admission, provider admission, and
session binding are persisted separately. Every rollout pass asks the kernel to
reconcile that same request. Before provider admission, the kernel can rebuild
an interrupted exact workspace, refresh an expiring short-lived capability,
and restart the same deterministic unit; three consecutive reconciliation
failures park the request. A proven-dead pre-provider worker may reclaim the
same request. Any post-provider dead or mismatched owner immediately parks that
exact request as ambiguous, so no prompt or session is replayed. The exact systemd peer must bind one provider session
before that session can submit a verdict, and the general review role cannot
manufacture a receipt from a caller-supplied session identifier. Synthetic
proof additionally requires exactly one terminal admitted repair turn and one
terminal admitted review turn with different provider-session UUIDs.
Canary and production are distinct
generations: revocation is permanent, production allocation requires the frozen
post-canary evidence digest and its independent `SHIP`, and exposure requires
both application and coordinator acknowledgements. An idempotency key can be
replayed only with the same caller, command, and full request digest. A command
whose external admission cannot be proven is recorded as ambiguous and is not
automatically replayed.

Rollout checks are admitted only in the matching lifecycle epoch
(`preactivation`, `canary`, `recovery`, or `production`), move monotonically from
prepared/running to an immutable terminal result, and receive their evidence
digest from the kernel's canonical evidence body. The frozen post-recovery
digest includes the rollout and identity, the post-canary-revocation epoch, and
each stored evidence body; pre-canary or caller-hashed evidence cannot authorize
production.

The rollout role cannot write check outcomes. `rollout.probe.run` first records
`running`, then invokes the kernel-owned allowlisted exporter. The exporter
inspects the effective application, kernel, adapter, coordinator, broker/worker
socket, credential, database, release, and gate surfaces; executes provider
continuity as `concierge-bot`; executes denial cases as the installed service
principals, the transient release-builder profile, and every project broker and
worker, including sibling socket/workspace visibility denial;
and owns the only stable-pointer mutation used by the rollback drill. A kernel
restart while a probe is running marks that proof ambiguous instead of replaying
it. The deliberately unhealthy rollback artifact is root-created from the exact
last-known-good release, fully rehashed, activated only while both gates remain
held, and always followed by an exact last-known-good restoration attempt.
The transient builder denial probe is rendered by the same profile constructor
as a real release build, and installed identity binds effective socket ownership,
modes, listeners, network policy, and runtime-directory authority in addition to
service filesystem confinement.

The root control-state directory is declared in the repository-owned tmpfiles
configuration and ordered before the kernel unit. This is a namespace
precondition: systemd resolves `ReadWritePaths` before `ExecStartPre`, so the
service must never depend on its own pre-start process to create that path.

The coordinator reconciles durable `prepared`, `sending`, and `ambiguous` Slack
notifications before advancing incident state. A `prepared` record is claimed
and sent once; later states search for the one deterministic projection and
never repost it. An outcome that remains unprovable past the bounded window
becomes terminally parked.

The rollout can create a synthetic incident only while its exposed canary
generation and exclusive lease are current. That incident is bound to the
rollout ID and uses a deliberately isolated repair-owned source fixture. A
reviewed integration atomically creates the next prepared target generation for
the integrated commit; the deployment runner then consumes the existing
attempt/release lifecycle. When invoked by the rollout, `deploy.sh` verifies the
exact kernel-owned application and capture `held` tokens, retains both holds
through success, and advances the attempt through candidate, healthy, and
last-known-good release states. It cannot substitute ordinary bootstrap release
commands or claim a different gate.

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
present. The worker Codex executable is a separately pinned protected snapshot
at `/usr/local/lib/concierge-deployment/codex`. Repair, review, rollout-review,
and post-cutover contained project workers consume that same snapshot. An ordinary deploy
hashes that installed snapshot and never reads the mutable host standalone
`current`; only an approved promotion selects the configured standalone Codex
candidate, verifies its explicitly requested SHA-256 digest, and replaces the
snapshot. General approval for another protected-source change does not imply a
Codex promotion. This keeps routine application deployment independent of host
Codex staging without allowing worker-runtime drift. A promotion may therefore
replace active contained provider runtimes under the deployment drain, but it
never bootstraps, updates, or restarts the separate shared managed App Server.
The frozen Bun dependency graph is installed separately under the lockfile
digest. Deploy restarts each already-running protected root service
whose active bundle or unit changed and re-proves its startup-captured version;
it stages a changed coordinator bundle in the inactive A/B slot without
restarting or repointing the incumbent. Repository-owned tmpfiles declarations
create the worker and coordinator roots on a clean host before systemd applies
mandatory path sandboxing.

Coordinator installation is A/B and does not move execution authority. The
installer writes a reviewed bundle to the inactive `coordinator/slots/a` or
`coordinator/slots/b` symlink and records the content-addressed catalog; the
legacy singleton remains the recoverable incumbent until a production
generation is promoted. `concierge-deployment-coordinator@.service` fixes the
candidate slot in systemd. A pending generation durably records candidate and
incumbent identities before the kernel starts that instance. The candidate's
acknowledgment and every later command are authenticated against its exact Unix
peer, systemd invocation, PID, boot ID, process-start ticks, slot, and bundle.
Exposure atomically fences the incumbent in SQLite before the root kernel stops
it. Candidate handshakes and heartbeats drive kernel-owned probation; death,
staleness, a missing handshake, or a rejected protected mutation revokes the
generation before the recorded incumbent is restarted. Recovery is durable and
required before live evidence can freeze. Only a healthy production candidate
that outlives probation may update the root-owned active-slot record and become
the boot-persistent coordinator.

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

The pinned worker runtime includes the exact protected Codex snapshot digest,
repair and review charters, structured output schemas, and custom permission
profiles. That digest changes only during bootstrap or a one-shot approved
promotion naming the exact candidate digest; updating the host CLI, staging a
new App Server release, or approving an unrelated protected-source change does
not change it.
Provider capability admission is refreshed through the protected kernel on each
worker start, so restarting the credential adapter cannot silently fall back to
a copied credential or a replacement provider session. Worker units are
enqueued only after durable launch state with non-blocking systemd admission, so
their first kernel callback cannot deadlock the kernel. Compact retrieval uses
only resolved, production-verified incident outcomes, ranks an exact failure
fingerprint first, and injects at most five summaries; raw logs and transcripts
remain outside the prompt.

## Application containment cutover

`bot/scripts/deployment-repair/application-cutover.ts` is the only application
containment mutator. Normal deployment calls it only when an explicit cutover
UUID is present and only after the turn and capture gates are both held and the
drained root application is stopped. Before changing authority, it persists a
root-only journal containing the exact gate tokens, source database/WAL/SHM
inode-owner-mode-size-digest evidence, managed-project plan, target paths, ACL
backup path, per-unit-file original owner/mode/digest and backup path, intended
digest and prepared/installed phase, next external effect, and append-only
effect history. Each unit-file record is durable before backup or replacement;
replay recognizes exact already-written output without replacing original
rollback provenance, rejects foreign drift, and still repeats daemon reload if
the process stopped before that effect completed.

The cutover takes a consistent SQLite snapshot, verifies integrity and foreign
keys, rewrites every durable workspace-bearing channel, fork, and artifact path
to `/var/lib/concierge-workspace`, and atomically installs the target under
`/var/lib/concierge-bot/state`. It derives one non-overlapping project authority
from the canonical channel registry, copies only each mapped Codex or Claude
session into its project provider home, gives every existing session a
project/provider/UUID HMAC binding, and verifies that the database and broker
authority agree. Shared skills and plugins are a read-only snapshot; provider
credentials and session material stay in systemd-managed per-project state.

The bot runs as `concierge-bot`, receives Slack configuration only through a
systemd credential, and can reach provider brokers but not worker sockets or
provider homes. Every project broker and worker has a distinct systemd dynamic
UID, a private user/mount namespace, an exact project and scratch view, and no
ambient capability. A broker's shared runtime directory is replaced by a
private read-only filesystem with only its own exact worker socket bound into
view, so the fixed socket group cannot reach a sibling worker. Fixed non-root
groups carry only ACL or shared-read access; the distinct UIDs prevent
cross-project process signaling even if a PID is guessed. Existing absolute `notes` symlinks remain valid through an authorized
legacy workspace alias inside the namespace; the durable registry uses the
stable service path.

The root credential adapter owns only `/run/concierge-provider-adapter`; its
mount namespace makes `/run/concierge-deployment` inaccessible, so possession of
the real provider credential cannot be combined with any kernel role socket.
Provider workers inherit their own listener from systemd while the shared
`/run/concierge-provider` tree is hidden, making sibling worker sockets
invisible without changing the socket-activation contract.

The application cutover also installs a kernel drop-in that rebinds only the
application-state path to `/var/lib/concierge-bot/state/state.db` after the
contained database is in place, then restarts and re-proves the same installed
kernel. The base unit continues to use the legacy root database before cutover,
which keeps notifier bootstrap and rollback representable. The capture-state
path is fixed at `/var/lib/concierge-capture/state.db` in both layouts.

Before the candidate release starts, the cutover verifies all sockets and reads
every mapped Codex thread through the actual bot-owned broker sockets; Claude
continuity is proven from the exact assigned transcript plus authority binding
because Claude exposes no read-only resume operation. Candidate functional
health is then checked while both gates remain held. A pre-commit failure stops
the project sockets, restores the prior unit drop-ins and recursive ACLs,
copies the latest contained database back with legacy paths, and restarts the
root layout before admission can reopen. Once candidate health commits the
containment journal, the root application layout is no longer an authorized
fallback.

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

The executable rollout state, systemd owner, resumable supervisor, and protected
proof exporter are present but deliberately idle until the inert implementation
passes the normal deployment gate and independent high-risk diff review.
The production application is still root. The typed provider-broker protocol,
project/session binding authority, bounded clients, non-root worker source,
socket-activated systemd templates, pinned provider runtimes, and shared
attachment scratch contract are staged and covered by focused tests. They are
installed inertly by normal deployment, and the backup-first application
cutover and deploy rollback integration are implemented and focused-tested, but
no project instance is enabled until the reviewed live cutover authorizes it.
The A/B coordinator handoff, process fencing, and root-kernel watchdog are
implemented and focused-tested but remain inert. No candidate instance is
enabled, no real-host activation proof bundle exists, and no activation
generation has been created. Starting the one reviewed UUID systemd instance is
the accountable one-time rollout action; every later action is owned by that
supervised process and the protected kernel, not an operator checklist.

The disabled state is a safety property, not an implicit readiness claim.

## Executable authorities

- Control schema and transitions: `deployment-control/kernel/state.ts`
- Command protocol and role policy: `deployment-control/kernel/protocol.ts`
- Protected effects: `deployment-control/kernel/handler.ts` and
  `deployment-control/kernel/releases.ts`
- Isolated provider, repair, review, and Git integration boundaries:
  `deployment-control/kernel/provider-adapter.ts`, `repair-workspace.ts`,
  `repair-agent.ts`, `review-workspace.ts`, `review-agent.ts`,
  `rollout-review-agent.ts`, and `integration.ts`
- Socket ownership: `deployment-control/kernel/server.ts`
- Installed activation identity: `deployment-control/kernel/identity.ts`
- Supervisor decisions: `deployment-control/coordinator/index.ts`
- Rollout ownership: `deployment-control/rollout/index.ts` and
  `systemd/concierge-deployment-rollout@.service`
- Protected live proof: `deployment-control/kernel/rollout-probes.ts`
- Repair-owned path policy: `config/deployment-repair-policy.toml`
- Bot handoff adapter: `bot/src/deployment-repair/`
- Installation and units: `bot/scripts/deployment-repair/` and `systemd/`
- Focused proof: `bot/tests/deployment-repair/`
