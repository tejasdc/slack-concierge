# Deployment repair agent design

Status: accepted product design and implementation authority. The architecture
received an independent `SHIP` before the final trust-boundary corrections, and
the corrected design received a final independent security `SHIP`. A final
architecture attestation declined only because the file changed while that
review was running; the user accepted the already-reviewed design and authorized
implementation on 2026-08-24. Implementation is in progress.

Current rollout state is tracked in
[the deployment repair architecture](../architecture/DEPLOYMENT-REPAIR.md). The
control-state, role-separated kernel/coordinator, immutable builder, and
exact-session handoff foundation exists, but all autonomous switches remain
disabled until every rollout prerequisite below is proven.

## Outcome

Slack Concierge deployments become self-healing without turning every feature
thread into an operations console. A deployment attempt may fail, roll back, and
be repaired without terminating the durable promise made to the thread that
requested deployment. A supervisor outside `concierge-bot.service` restores the
last-known-good release when that is proven safe, launches one repair-agent
session for the incident, and keeps working until the desired revision is
healthy or progress becomes unsafe.

Normal repair is invisible. The current Slack Concierge project channel receives
one durable incident alert only when the supervisor restores a prior release or
parks for human intervention, followed by a terminal update after forward repair.
Feature threads receive only their exact post-deploy verification turn or a
proven commit-specific blocking handoff.

## Operating profile

- One trusted operator and one canonical Concierge production target on the AX41
  service peer.
- Low request volume, but a failed deployment can make the control application
  unavailable and can strand work across several Slack threads.
- The service holds sensitive Slack and provider credentials. Repair code can
  change production behavior and therefore has a high-risk trust boundary even
  though the system is personal and single-operator.
- GitHub remains the code meeting point. The canonical checkout stays on `main`;
  repair never uses destructive Git resets or edits installed project files by
  hand.
- systemd remains the only lifecycle supervisor. No cron, second authoritative
  project/origin, separate Slack project, or new Slack channel is introduced;
  incident repositories are isolated disposable working copies only.

## Current behavior being replaced

The current implementation binds each `deployment_request` to one
`deployment_run`. `failDeploymentRun` makes every pending request in that run
terminally `failed` and queues a static notice for every affected thread. A later
successful run evaluates only the requests enrolled in that run. This is why an
old failed attempt can produce delayed thread notices while a later success does
not carry those old requests forward.

The current transient deployment runner already survives a bot restart, records
phase history, proves runtime SHA and systemd invocation identity, and creates an
exact-session verification turn only after success. Those properties remain.
The new design changes request lifetime, adds a deployment control plane outside
the bot, adds last-known-good restoration, and assigns one agent to repair the
deployment system.

## Decisions

- The repair agent remains part of this repository and project but runs outside
  the `concierge-bot.service` cgroup and security principal.
- systemd launches one resumable provider session per repair incident. There is
  no permanent provider conversation.
- A stable logical agent identity is defined by a versioned charter, tools, and
  knowledge contract; provider conversation history is not institutional memory.
- Failed and ambiguous attempts do not terminate deployment intents.
- The deployment repair agent owns failures of the deployment control plane. A
  regression proven to originate in a requested commit returns to that exact
  provider session and Slack thread, even if the commit edited deployment files.
- Ambiguous attribution remains with the repair agent until proven. It never
  fans out speculative blame to several threads.
- The repair agent may change the machine-readable repair-owned deployment
  surface, add focused regression tests and required current-state documentation,
  commit inside its credential-free incident repository, obtain independent
  review, and request integration, push, deploy, and verification from the
  supervisor. It cannot push, deploy, or mutate canonical Git directly. It may
  not bypass a health/admission gate, rotate credentials, perform an irreversible
  data action, rewrite Git history, modify its own authority/learning policy, or
  change unrelated feature behavior.
- A safe last-known-good release is restored automatically after a candidate
  replacement fails health. Runtime restoration does not revert the blocking
  source commit on `main`.
- Rollback is stabilization, not incident completion. Repair continues until a
  forward fix makes the desired revision healthy and all pending intents have
  been evaluated.
- New deployment requests queue and coalesce while repair is active.
- The repair loop continues while it produces new evidence or changes the
  failure condition. It parks on an unchanged repeated failure, ambiguous prior
  side effect, unavailable authority, unsafe rollback, or required irreversible
  action.
- Structured incident knowledge is promoted automatically only after production
  verification and independent review. A different model is preferred; a fresh
  independent session on the same provider is acceptable when another model is
  unavailable.
- No new Slack channel is created. Routine internal phases are not posted.

## Architecture

```text
Slack thread agent
    | persists deployment intent and immutable continuation mapping
    v
Deployment control DB <------> protected root control kernel
    |                                  | peer-authenticated commands
    | applies typed effects            v
    |                         non-root supervisor coordinator
    |                                  |
    |                                  v
    |                         trusted provider adapter
    v                                  |
Transient deploy runner                | credential-mediating session transport
    |                                  v
    | candidate release         unprivileged incident repair worker
    | probes and provenance            |
    v                                  | standalone credential-free repository
Release manager <----------- independent isolated review worker
    |
    +-- healthy candidate -> promote last-known-good -> exact thread wakes
    |
    +-- unhealthy candidate -> safe restore -> Slack incident alert
                                      |
                                      +-- forward repair -> terminal update
```

The trust principals are deliberately separate:

| Principal | Holds | Must not hold |
| --- | --- | --- |
| Protected root control kernel/recovery shim | Sole host-root effect executor and generation owner; control DB, policy enforcement, canonical Git integration, release, gate, notifier, and A/B slot authority | Provider conversation context, repairable orchestration logic, or arbitrary candidate commands |
| Active supervisor coordinator | One generation-fenced non-root A/B coordinator; durable workflow decisions and typed requests to the root kernel | Root capability, direct control-DB/Git/release/systemd access, policy enforcement changes, or ability to signal/write the kernel and prior slot |
| Trusted provider/evidence adapter | Provider authentication, exact-session transport, redaction, incident capability issuance | Canonical Git write, deploy, release, gate, Slack, or control-DB write authority |
| Repair and review workers | One standalone incident repository or immutable review snapshot plus redacted evidence | Host secrets, network, canonical `.git`, raw journal, control sockets/DB, release or systemd mutation |
| Candidate builder | Exact reviewed tree and pinned build recipe | Host secrets, canonical Git write, release promotion, candidate hooks as root |
| Contained candidate services | Only their unit-private runtime credentials and application state | Root kernel/coordinator slots, canonical Git, release pointer, provider/Git credentials, or systemd lifecycle authority |
| Deterministic notifier | One bot-token capability, immutable target/channel record, typed incident projection | Arbitrary channel/text, provider prompt, raw logs, Git, release, or lifecycle mutation |

### Deployment control plane

Deployment lifecycle state moves out of Concierge's application-state schema
into a dedicated SQLite control database under
`/root/.local/state/concierge-deployment/`. The protected root control kernel is
its only writer and applies only transitions and effects accepted by its installed
policy/evaluator. The active non-root supervisor coordinator, bot, deploy runner,
operator CLI, provider adapter, repair worker, and review worker submit typed,
idempotent commands over peer-authenticated local IPC; none opens the SQLite
database or its WAL/SHM directly. Each command contains the target, incident or
attempt identity, expected current state, caller class, and idempotency key. The
bot or active coordinator may disappear or start with incompatible application
code without erasing the root kernel's view of attempts, intents, incidents,
alerts, or last-known-good provenance.

The control database stores immutable snapshots of provider/session/channel
continuation data. It does not use foreign keys into the bot database. After the
bot is healthy, it validates a queued handoff against current session state
before attempting provider admission. Mapping drift parks the handoff; it never
substitutes a fresh feature session.

The machine backup already covers `/root`, so the new state directory remains
inside the existing restore boundary. It does not add a backup service.

### Desired-commit generations

A deployment intent is admitted only for a full commit SHA fetched from the
canonical origin and proven reachable from the then-current `origin/main`.
Same-origin is insufficient. A missing, divergent, or rewritten commit is
rejected before intent creation or parks an already-durable intent with an exact
source-blocker handoff; it is never carried indefinitely as an unrepresentable
target.

Immediately before an attempt, the root kernel fetches origin and persists one
immutable target generation whose `desired_commit` is the exact observed
`origin/main` SHA. Every pending intent that is an ancestor of that SHA joins the
generation. The attempt never follows a moving branch name. A request arriving
mid-attempt joins the active generation only when its commit is already an
ancestor of that generation's immutable desired commit; otherwise it remains
pending for the next generation.

Attempt failure changes only attempt/generation history. Successful health proof
marks every still-pending intent whose commit is an ancestor of the deployed SHA
as satisfied. A newer reachable intent creates the next generation. A repair is
integrated only as a fast-forward of the exact reviewed base onto the unchanged
`origin/main`; the resulting origin SHA becomes a new desired generation. Origin
movement invalidates the review and returns the incident repository to the repair
worker for refresh and re-review.

A commit-specific repair links a correcting intent to the blocked intent without
terminating or rewriting the original. The original becomes satisfied when a
healthy descendant containing both commits is live. Verification wakes are
grouped by exact provider-session/Slack-thread mapping so one mapping receives one
wake for all newly satisfied intents.

### Protected control kernel, supervisor coordinator, and repair launcher

The repository owns a minimal protected root control kernel/recovery shim, a
non-root systemd supervisor coordinator, and incident-scoped repair/review units.
The root kernel is the sole host-root effect executor and generation owner. It
contains the policy parser/evaluator, command authorization, review/digest
binding, Git import/promotion gate, control-DB transition engine, A/B slot
selector, recovery watchdog, release/gate/systemd effect adapters, and typed
notifier boundary. Its code and installed digest are part of the protected
authority policy and never belong to the autonomous repair surface.

Exactly one generation-fenced non-root supervisor coordinator makes durable
workflow decisions for the Concierge deployment target. It serializes deploy,
restore, repair, review, and promotion requests, but can realize them only by
asking the root kernel for typed effects that the kernel independently
revalidates. It cannot signal or write the kernel, recovery watchdog, policy,
control database, notifier target, installed units, prior coordinator slot, or
host systemd surfaces. A repair deployment failure attaches to the existing
incident instead of recursively launching another repair agent.

The root kernel installs a coordinator candidate only into the inactive
read-only slot. It validates the coordinator digest and repair-policy generation,
exercises state-transition and recovery fixtures against a copied control
database, and runs a read-only reconciliation probe. Activation changes only the
root-kernel-owned generation fence: the non-root candidate may request ownership,
reconcile through typed read/effect requests, and return a post-activation
handshake, while the root kernel and watchdog retain exclusive authority to
revoke the generation and reactivate the prior slot. Promotion requires that
handshake plus a bounded watchdog interval. Fixtures and a contained live drill
must prove recovery when a probationary coordinator dies and when it attempts to
signal/write the kernel, prior slot, policy/evaluator, notifier state, control DB,
or systemd surfaces after requesting ownership.

Candidate application code runs as a non-root principal inside a systemd
filesystem, capability, cgroup, and process boundary. It cannot signal the
supervisor; open the control database; mutate canonical Git, release records or
pointers, notifier state, installed units, or either coordinator slot; or
access another service's credentials. It reaches deployment and provider
lifecycle operations only through peer-authenticated typed IPC. Functional
health is probed under this same production containment. Automatic repair cannot
be enabled while `concierge-bot.service` remains an unrestricted root process.

### Provider, repair, review, and build isolation

A trusted provider adapter owns provider authentication and exact start/resume
admission. Agent tool processes never receive its credential files, environment,
file descriptors, control socket, or host identity. Repair and review tool
workers run as separate dedicated unprivileged principals. The repair worker can
write only its incident repository and scratch directory; the review worker sees
an immutable read-only snapshot and cannot write the repair repository.

Their systemd boundaries use explicit allowlists, not the provider's
`workspace-write` label as a security claim. At minimum they use a non-root
`User=`, `ProtectHome=true`, `ProtectSystem=strict`, `NoNewPrivileges=true`,
`PrivateTmp=true`, `PrivateDevices=true`, hidden other-process `/proc`, an empty
capability set, and explicit `ReadOnlyPaths`/`ReadWritePaths`. They cannot read
`/root`, `/etc/concierge`, systemd credential directories, provider-auth homes,
the App Server control socket, the deployment control database, canonical `.git`,
release/kernel/coordinator paths, or other project workspaces. Agent tool networking
is disabled; model transport remains in the trusted adapter.

Machine state, journal slices, control events, Git provenance, and deep incident
evidence are selected and redacted by a trusted evidence broker into an
incident-owned packet. Workers never query journald, systemd, `/proc`, or the
control database directly. Every adapter/broker command authenticates the Unix
peer, binds a short-lived capability to one incident, command kind, expected
state, and evidence/repository digest, and rejects wrong-peer, wrong-incident,
stale-generation, or replayed requests.

This design borrows only the authenticated lifecycle-broker, session-continuity,
and OS-isolation concepts from
[provider isolation and sandboxing](../future-plans/PROVIDER-ISOLATION-AND-SANDBOXING.md).
For repair and review sessions, this design supersedes that proposal's fresh
credential, re-authentication, and provider-process credential-ownership model.
The trusted adapter must mediate the existing provider credential and session
authority without copying, rotating, or exposing it to model tool processes. If
the provider transport cannot launch isolated tools while keeping that existing
credential in the adapter, autonomous repair stays disabled. Today's root-owned
App Server and `danger-full-access` turn path do not satisfy this prerequisite.

### Credential-free incident Git repository and owned surface

The root kernel materializes the exact origin-proven base into a standalone
incident repository under the repair principal. It shares no linked worktree,
object directory, alternates, hooks, config includes, credential helpers, or
remote with the canonical repository. The repair worker may make local commits
but has no GitHub credential or network path.

The repository source for a versioned, machine-readable repair policy is
`config/deployment-repair-policy.toml`; the protected root kernel installs and pins
its reviewed digest together with the digest of the protected root control
kernel that parses and enforces it. It enumerates the deployment-owned source,
focused-test, and current-state documentation paths. The root kernel—not the
repairable coordinator—checks the installed policy before review and again before
import, integration, push, and deploy. The policy file and enforcement engine,
repair charter, learning index, provider/session code, credential/config
surfaces, dependency authorities, unrelated feature code, and shared production
files outside its allowlist are protected; an incident touching them parks for
human approval. Candidate code cannot edit or replace the policy or evaluator
that judges it.

The first policy version is intentionally narrow:

| Class | Initial policy |
| --- | --- |
| Autonomous existing source | `bot/scripts/deploy-state.ts`, `bot/src/deployment-state.ts`, `bot/src/deployment-worker.ts` |
| Autonomous new source | Dedicated non-root `deployment-control/coordinator/`, `bot/src/deployment-repair/`, and `bot/scripts/deployment-repair/` subtrees only |
| Autonomous tests | `bot/tests/deploy.test.ts`, `bot/tests/deployment-state.test.ts`, and `bot/tests/deployment-repair/` |
| Required current-state docs | `docs/architecture/DEPLOYMENT-REPAIR.md` and `docs/runbooks/DEPLOYMENT.md` |
| Always protected during an incident | Protected `deployment-control/kernel/` trust base, `config/deployment-repair-policy.toml`, current operator-fallback `bot/scripts/deploy.sh`, `AGENTS.md`, provider/session transports, Slack/capture/credential code and config, package manifests/lockfiles, unrelated bot features, and existing shared systemd units |

Adding an allowed path, changing an allowed prefix, or touching an always-protected
path is an authority change, not a normal repair. It parks for human approval and
receives a separate high-risk review. A separately promoted learning commit still
cannot change this authority policy or root enforcement engine without that human
gate. The installed policy generation binds both policy-data and kernel-executable
digests; replacing only the parser/evaluator, review binder, tree verifier, import
gate, or promotion logic is rejected before review and import.

After an independent reviewer returns `SHIP` for the exact base, head, tree, test
evidence, and policy digest, the root kernel rechecks that `origin/main` still
equals the reviewed base. It imports the standalone commits into a root-owned
integration repository, rejects symlinks escaping the tree and special files,
normalizes ownership, proves the resulting tree digest equals the reviewed tree,
and performs only a non-force fast-forward push. The provider never calls GitHub
or the deploy runner directly.

### Immutable releases and last-known-good restoration

A health-gated release is an immutable runtime artifact derived from an exact
Git commit. Its release record contains:

- full Git SHA and origin provenance;
- runtime/package and installed-unit/config digests;
- service and capture functional probe evidence;
- systemd invocation identities;
- state/schema compatibility evidence;
- rollback classification and rationale;
- creation and promotion event identities.

Release content is reviewed, non-secret, repository-derived material only.
Slack/provider/capture credentials and other host configuration remain external
authorities: the root kernel records root-only digests and metadata and revalidates
them in place, but never copies them into a release or rollback artifact. “Unit
and config digests” below therefore means repository-owned non-secret units and
configuration plus metadata about external authorities, not secret bytes.

A dedicated unprivileged, credential-free builder constructs a candidate from
the exact reviewed tree using a build recipe pinned in the incumbent control
bundle. The root kernel does not execute candidate-provided deploy/build hooks as
root. Import rejects absolute or escaping links, device nodes, sockets, and other
special files, normalizes ownership and modes, and proves the staged artifact
digest before activation. Any required build network is narrowly allowed to the
builder and carries no GitHub, Slack, capture, provider, or control credential.

The service runs through a stable release pointer rather than directly from a
mutable canonical checkout. Candidate preparation never mutates a promoted
release. After pre-activation artifact, policy, and compatibility checks pass,
the root kernel switches the runtime pointer with admission still held, starts the
candidate, runs both functional probes, and performs the existing final
same-invocation and runtime-SHA re-proof. Only then does it release admission and
promote the release as last known good.

Restoration selects the recorded immutable release and replays its recorded
non-secret runtime/unit/config set through the incumbent recovery wrapper and
revalidates the external credential authorities in place. It never executes
`git reset --hard`, detaches the canonical checkout, copies project files around
Git, or calls a candidate's unproven repair launcher.

Rollback is allowed only when compatibility with current durable state is
proven. Schema additions may be compatible, but the design never assumes that
from file names or migration direction. An irreversible migration, destructive
data mutation, unknown external contract change, or missing compatibility proof
makes rollback unsafe. The root kernel then keeps unhealthy admission closed,
starts diagnosis, and posts a parked/unsafe-rollback alert rather than guessing.

### Slack alert boundary

The root kernel must be able to alert while Concierge is down. A root-only,
deterministic notifier uses the existing Slack app's bot token from the existing
mode-0600 Concierge configuration. This is a deliberate expansion from the bot
process to one additional trusted control-plane process; it does not create a
new Slack credential. The notifier is the one explicit secret-consuming
exception to the credential-free repair/review boundary. A fixed incumbent
credential adapter reads the existing configuration and presents only the bot
token to the notifier through a private inherited descriptor or unit-private
credential, never argv/environment or another persistent file. The notifier does
not receive the config's app token, signing secret, or user token.

Bootstrap copies the exact Slack Concierge project channel ID from the verified
registry into a root-kernel-owned target record. That record is immutable during
an incident and can change only through a separate reviewed operator command.
The notifier derives the channel internally; callers cannot supply a channel ID
or arbitrary text. It accepts only incident identity, expected current state,
and bounded typed fields (known enum, full SHA, invocation identity, probe result,
and redacted short reason) for these fixed templates:

- `runtime_restored`: candidate failed and last known good is healthy;
- `repair_parked`: automated progress cannot continue safely;
- `forward_repair_succeeded`: desired revision is healthy and the incident is
  resolved.

Each incident has a random full UUID rendered as a bounded literal field in every
fixed incident template. The send also carries a deterministic `client_msg_id`
and, when supported by the installed Slack contract, typed message metadata, but
neither is assumed to be independently readable or sufficient proof. Before
activation, a live notifier preflight must prove that bounded history readback in
the fixed channel returns the full incident UUID, expected bot author, template
kind, and message timestamp. Lack of that provider contract disables automatic
out-of-bot alerting rather than weakening identity.

A rollback or park creates at most one root message, and final recovery updates
that incident thread. Transport ambiguity transitions
`sending -> ambiguous -> reconciling`. Reconciliation repeatedly performs
read-only bounded history lookup for the exact channel, bot author, full random
incident UUID, template kind, and send time window; it never infers absence from
`client_msg_id` alone and never posts a replacement logical message. One proven
match records its Slack timestamp; multiple matches or expiry without affirmative
proof parks delivery without reposting. Fixed templates neutralize Slack markup,
bound every field, and reject channel, text, link, mention, and block overrides.
Tokens, provider prompts, raw logs, and unredacted command output are forbidden
from the Slack projection.

Feature threads do not receive shared attempt-failure notices. They receive a
real provider turn only for successful live verification or for a blocker proven
to be caused by their requested commit.

## Durable lifecycle contract

```yaml
template: state-machine-contract
owner: protected root control kernel is the sole state/effect writer; one generation-fenced non-root supervisor coordinator owns workflow decisions; all other commands are producers
behavior_or_operation: converge the Concierge deployment target to all pending requested commits while preserving a healthy recoverable runtime
source_of_truth: dedicated deployment control SQLite database plus immutable Git/release provenance; append-only events record every transition
actors:
  - Slack-started feature agents
  - Concierge deployment-intent and post-health handoff adapters
  - protected root control kernel and recovery watchdog
  - one generation-fenced non-root systemd supervisor coordinator
  - transient deploy runner
  - trusted credential-mediating provider and evidence adapters
  - one unprivileged incident-scoped repair tool worker
  - fresh unprivileged independent code and learning review workers
  - unprivileged candidate builder
  - deterministic root-only Slack incident notifier
resources:
  - canonical clean main checkout
  - standalone credential-free incident repository
  - immutable candidate and last-known-good releases
  - protected kernel/evaluator generation and incumbent/candidate non-root coordinator slots
  - machine-readable installed repair policy
  - concierge-bot.service and agent-inbox.service
  - turn and capture admission gates
  - deployment control database and machine journal
states_or_modes:
  intent: pending -> satisfied -> verification_pending -> verified | parked | cancelled
  target_generation: prepared -> active -> succeeded | failed | ambiguous
  attempt: prepared -> draining -> updating -> activating -> verifying -> releasing -> succeeded | failed | ambiguous | restored
  incident: open -> stabilizing -> diagnosing -> awaiting_owner_fix | repairing -> reviewing -> deploying -> verifying -> learning -> resolved | parked
  repair_session: pending -> admitted -> running -> completed | parked
  review: pending -> running -> ship | no_ship | parked
  alert: pending -> sending -> delivered | ambiguous -> reconciling -> delivered | parked
  release: candidate -> healthy -> last_known_good | superseded | rollback_ineligible
  coordinator_bundle: inactive_candidate -> fixture_verified -> active_probation -> promoted | revoked | parked
allowed_transitions:
  - one active attempt and one active repair incident per deployment target
  - the root kernel is the sole control-database and host-effect writer; the active coordinator and all other actors submit typed peer-authenticated commands
  - each attempt uses one persisted origin-proven desired_commit generation and never follows a moving branch
  - an intent joins only a generation whose desired_commit contains it; mid-attempt non-included intents wait for the next generation
  - a failed or ambiguous attempt appends an intent-attempt result but does not terminate its intents
  - failure before target replacement keeps the existing healthy release and starts diagnosis without rollback
  - failure after replacement restores only a release with current compatibility proof
  - rollback proves the restored SHA, service invocation, capture probe, service probe, and admission state before reporting restored
  - a repair provider resumes only its exact incident session and only while provider admission is provable
  - repair code reaches main and production only after path-policy checks, focused checks, an independent SHIP verdict over the exact tree, and a non-force fast-forward import by the supervisor
  - successful forward deployment evaluates every outstanding intent whose commit is an ancestor of the deployed commit
  - each included exact feature session/thread receives one idempotent verification handoff
  - incident resolution requires latest persisted desired-generation health, released gates, settled intent classification, and a durable learning outcome
  - knowledge promotion requires verified production evidence and an independent PROMOTE verdict
  - coordinator-bundle promotion requires kernel-run fixtures, a generation-fenced live handoff, successful reconciliation, and a root-kernel probation watchdog while the prior bundle remains recoverable
invalid_states:
  - a terminally failed intent caused only by an attempt-level infrastructure failure
  - two coordinators, repair sessions, or incident repositories mutating one target concurrently
  - declaring rollback success without exact release and same-invocation health proof
  - using an unproven candidate launcher to repair that candidate
  - replacing canonical Git history or modifying the canonical checkout to simulate rollback
  - a provider repository sharing Git administration, objects, hooks, config, remotes, or credentials with canonical Git
  - retrying a provider turn or reposting a Slack alert after its external admission became ambiguous; bounded read-only reconciliation is allowed
  - a repair agent receiving Slack, GitHub, capture, or provider credentials in its prompt or environment
  - a candidate, repair worker, review worker, or builder able to write supervisor, control-state, release-pointer, credential, or systemd lifecycle surfaces
  - integrating a repair outside the installed repair-owned path policy or changing that policy inside the same incident
  - waking a fresh feature session when the exact stored mapping is unavailable
  - promoting agent-authored knowledge without independent evidence review
contracts:
  - every command includes target, incident or attempt identity, expected current state, and idempotency key
  - every external effect is preceded by durable intent and followed by durable evidence or ambiguity
  - desired_commit means the immutable fetched origin/main SHA persisted for one target generation
  - last_known_good means a release that passed both functional probes and a final same-invocation/runtime-SHA proof
  - rollback_safe means compatibility with current durable and external state was affirmatively proven
  - commit-specific attribution requires concrete causal evidence, not temporal adjacency or file ownership
  - provider and Slack mappings are immutable snapshots and are revalidated immediately before admission
producers:
  - deploy request CLI and Concierge adapter
  - transient deploy runner phase commands
  - supervisor recovery reconciliation
  - repair and review completion commands
  - release promotion and restore commands
consumers:
  - deploy runner launcher
  - repair-agent launcher
  - review launcher
  - bot-side exact-session handoff worker
  - root-only Slack incident notifier
side_effects:
  - root-kernel-owned Git fetch, exact reviewed-tree import, non-force fast-forward push, and forward deployment
  - immutable release creation, activation, promotion, and safe restoration
  - systemd service and capture replacement through reviewed wrappers
  - one repair provider turn stream per incident
  - one independent review stream per proposed repair or knowledge promotion
  - bounded Slack incident alerts and exact feature-thread wakes
deny_cases:
  - dirty or noncanonical source, unreadable origin, missing runtime provenance
  - requested commit not reachable from fetched canonical origin/main
  - unknown runner liveness or external effect outcome
  - rollback compatibility missing or false
  - repeated unchanged failure without new evidence
  - requested credential rotation, gate bypass, destructive data action, or unrelated feature edit
  - repair-policy, charter, retrieval, credential, provider, dependency-authority, or shared-path mutation before the appropriate human or promotion gate
  - unavailable or drifted originating feature session for a commit-specific handoff
protected_classes:
  - active provider work and capture delivery
  - Slack and provider credentials
  - Git history and user-authored commits
  - durable application and capture state
  - exact provider-session and Slack-thread continuity
  - protected root kernel/recovery authority, its enforcement digest, and machine-readable repair policy
runtime_surfaces:
  - deployment control state and supervisor commands
  - deploy, health, release, restore, and alert scripts
  - protected root kernel and repository-owned non-root coordinator/systemd units
  - bot-side deployment intent and handoff adapters
  - incident repair charter, retrieval index, and reviewed knowledge records
observability:
  - append-only attempt, incident, review, release, alert, retrieval, and handoff events
  - normalized failure fingerprint and failure phase
  - exact charter/skill/knowledge versions loaded into every repair session
  - caller peer identity, incident capability, desired generation, repair-policy and kernel-enforcement digests, reviewed tree digest, and coordinator generation on every protected effect
  - retrieval queries and selected knowledge identifiers
  - before/after Git SHA, unit/config digests, service invocation, and probe evidence
  - explicit verified, not_verified, and confidence_limits fields on incident closure
tests:
  - request survives several failed/ambiguous attempts and verifies after later inclusion
  - only one attempt and repair incident can own the target
  - pre-activation failure keeps the healthy release without a false rollback alert
  - post-activation failure safely restores exact last known good and alerts once
  - unsafe or unknown compatibility blocks restoration and closes admission
  - application candidate cannot replace or mutate the protected kernel before application health succeeds
  - non-root coordinator candidate that dies or attacks protected surfaces after requesting ownership is revoked and the incumbent resumes reconciliation
  - nested repair deployment failure resumes the same incident rather than spawning another
  - provider crash retries only before admission and parks ambiguous admission
  - Slack alert delivery is idempotent and secret-redacted while Concierge is down
  - a live Slack fixture proves full incident-identity readback; ambiguous send reconciles exact channel/author/UUID/template identity without reposting and parks when readback cannot prove one match
  - exact commit blocker routes only to its exact unchanged feature mapping
  - ambiguous multi-commit failure does not fan out speculative handoffs
  - repair diff cannot promote without independent SHIP and focused evidence
  - knowledge entry cannot promote without production verification and independent PROMOTE
  - repeated fingerprint and execution/retrieval miss classifications choose the correct improvement layer
  - real systemd canaries prove repair/review/builder and contained candidate principals cannot read credentials, Git helpers, control sockets, other-process procfs, or unauthorized paths
  - wrong-peer, wrong-incident, stale-generation, direct SQLite/WAL tampering, policy-evaluator bypass, channel/text override, markup injection, path escape, special-file import, release tampering, coordinator/application-candidate-to-healer mutation, and pre-verification self-promotion all fail closed
dry_run_or_fixture: isolated control DB, fake systemd/release roots, local Git origin, fake Slack endpoint, provider admission fixtures, and historical failure replays
rollback_or_restore: current production remains authoritative until the protected root kernel, first coordinator generation, and one release are bootstrapped; implementation rollout must preserve an operator recovery path to the existing deploy.sh flow
verified: design decisions accepted by the user; current deployment implementation and production run 0693538c-2a2a-49c2-844f-bc94b723a87f inspected
not_verified: production activation, safe live restoration, isolated repair/provider execution, deterministic external notification, reviewed repair import, learning promotion, real-unit negative matrix, and live rollback drill remain unproven; autonomous switches remain disabled
confidence_limits: exact release layout and control-command encodings remain implementation-plan details; isolated provider transport and non-root candidate migration are explicit prerequisites and may not be replaced by prompt instructions or provider sandbox labels
```

## Repair-agent context and progressive retrieval

One incident session receives bounded, versioned context in layers:

1. **Core charter, always loaded:** mission, ownership boundary, forbidden
   actions, completion contract, canonical commands, and knowledge-retrieval
   protocol.
2. **Fresh incident packet, always loaded:** target, incident and attempt IDs,
   phase history, requested commits, candidate and last-known-good provenance,
   liveness, gate state, normalized failure fingerprint, redacted relevant logs,
   and current capabilities.
3. **Knowledge index, searched before mutation:** compact metadata for verified
   prior incidents keyed by phase, subsystem, error fingerprint, affected
   command, outcome, and charter version.
4. **Prior summaries, selectively loaded:** only the highest-confidence matching
   incident summaries and promoted runbook entries.
5. **Deep evidence, on demand:** historical diffs, review artifacts, and bounded
   redacted journal or transcript excerpts remain outside the initial context.
   The worker requests a concrete diagnostic claim from the evidence broker; it
   never receives raw credential-bearing logs or direct journal/host access.

Every repair session can refresh live context. It explicitly records which
knowledge entries it retrieved and which claims influenced its action. Session
completion is an explicit durable command containing outcome, evidence, open
uncertainty, and next action; it is never inferred from provider silence.

## Learning and self-improvement

Every incident closes with a structured factual record even when it produces no
new reusable lesson. The record distinguishes:

- `knowledge_gap`: no relevant verified knowledge existed;
- `retrieval_miss`: relevant knowledge existed but was not selected;
- `execution_miss`: guidance was loaded but not followed;
- `stale_knowledge`: selected guidance was wrong for the current system;
- `evidence_gap`: the incident packet lacked the evidence needed to decide;
- `novel_failure`: the failure shape was genuinely new.

The failure class determines the improvement layer. Retrieval misses change
metadata or retrieval tests. Execution misses become deterministic preflights,
guards, or regression tests when possible. Knowledge gaps add a reviewed
incident summary or runbook rule. Stale guidance is superseded rather than
silently edited. Evidence gaps improve capture at the owning boundary.

Incident repair and reusable learning are two different commits and gates. The
repair commit may contain the in-scope code correction, the focused regression
test needed to prove it, and current-state documentation required by that code.
It cannot modify the installed repair policy, repair charter, launcher/tool
bundle, retrieval metadata/index, promoted knowledge, or `AGENTS.md`. A repair
that requires a new ownership boundary or authority-policy change parks for human
approval rather than editing its judge.

Only after the repair is live and verified may the agent propose a separate
learning commit. That commit may supersede a knowledge record, change retrieval
metadata, update the charter or `AGENTS.md`, or add broader follow-up hardening.
It receives its own independent diff review and, if executable behavior changes,
its own deployment and production verification. The launcher remains pinned to
the last promoted charter/tool/knowledge bundle until this sequence completes.

The repair agent may propose but cannot approve its own durable lesson. A fresh
isolated reviewer receives the immutable incident evidence, actual production
result, retrieval trace, proposed lesson, destination, and exact diff. It returns:

- `PROMOTE`: evidence supports the lesson and selected destination;
- `REVISE`: useful but overbroad, incomplete, duplicated, or stored at the wrong
  layer;
- `REJECT`: unsupported, unsafe, or not generalizable.

Promoted facts and summaries live in Git-tracked incident/runbook documentation.
Universal invariants may update `AGENTS.md` in that separate promotion commit.
Mechanically preventable follow-up recurrence must prefer code or a focused
regression test over more prompt prose. Each promotion records source incident,
reviewer, evidence, Git commit, charter version, and rollback path.

Raw logs, secrets, and complete provider transcripts are never committed or
bulk-injected. Existing journald and machine-backup retention remains the raw
evidence boundary.

## Failure ownership

The deployment repair agent owns failures whose cause is the deployment control
plane: origin access, drain/gate lifecycle, release preparation, systemd
installation or replacement, functional-probe plumbing, supervisor recovery,
alert delivery, and deployment-state integrity.

A requested commit owns a failure only after causal proof. Examples include a
build error introduced by its diff or a service regression reproducible at that
commit and absent at its proven parent. The repair agent then creates one
durable `commit_blocker` handoff to the exact original provider session and
Slack thread. The handoff includes evidence and requires that agent to fix,
review, commit, and request deployment again. The original deployment intent is
linked to the correcting intent and remains pending until a healthy descendant
contains both. Neither continuation nor causal history is silently discarded.

If the exact mapping is unavailable, the coordinator asks the root kernel to
keep last known good live, parks that intent, and alerts the project channel. It
does not modify the feature or automatically revert the source commit. If
attribution remains ambiguous, the repair agent keeps the incident rather than
waking every involved agent.

## Notification policy

| Event | Slack behavior |
| --- | --- |
| Ordinary deploy succeeds | No infrastructure alert; included feature threads receive exact verification turns |
| Attempt fails before candidate activation | No routine alert; repair incident starts while current healthy service remains live |
| Candidate activation fails and safe restore succeeds | One project-channel incident root stating failed candidate, restored SHA, health evidence, and continuing repair |
| Safe restore cannot be proven | One project-channel parked/unsafe alert with the missing proof and current admission state |
| Repair produces intermediate diagnostics | No Slack chatter; durable control events remain inspectable |
| Forward repair succeeds | One terminal update in the incident thread, then exact feature verification wakes |
| Proven feature commit blocks deployment | Exact originating feature session/thread receives one real blocking turn |
| Feature mapping is unavailable | One project-channel parked alert; no substitute session |

## Security contract

- Repair and review tool workers and the builder receive no Slack, GitHub,
  capture, provider-auth, control, or notifier secrets. Provider authentication
  remains inside the trusted adapter and is inaccessible to model tools. The
  contained candidate bot receives only the unit-private runtime credentials its
  application requires; it receives no GitHub, provider-auth, supervisor, release,
  or notifier authority.
- The protected root kernel owns release activation, service lifecycle, gate
  mutation, canonical Git integration, push, deploy admission, policy enforcement,
  generation fencing, and control-state writes. The non-root coordinator and all
  other typed peer-authenticated commands are requests, not delegated root shells.
- The existing Slack bot token remains in the mode-0600 Concierge config and is
  consumed only by the bot and trusted notifier. It is never copied into a
  release, incident packet, repository, prompt, argv, worker environment, or log.
- The notifier accepts incident identity and a typed projection, not arbitrary
  message text or arbitrary channel IDs. Its root-kernel-owned target/channel
  record and template grammar are verified independently of candidate state.
- Git changes occur in a standalone credential-free repository. Before
  integration, the root kernel verifies repository and tree identity, installed
  repair-path policy, focused tests, review verdict/digest, expected base/head,
  special-file/link denial, and unchanged origin state.
- Candidate-controlled scripts cannot weaken the root kernel, reviewer, rollback,
  alert, or admission guards before candidate health succeeds.
- An application or coordinator candidate is non-root and cannot write or signal
  the root kernel, control-state, release, canonical-Git, notifier, credential, or
  systemd surface.
- Secret-bearing host configuration is never an immutable-release payload.
- Every protected effect is idempotent and checks the expected current state.
- Provider and Slack ambiguity always parks instead of replaying.

### Mandatory security-negative proof matrix

Implementation cannot activate autonomous mutation until these cases run through
the real systemd principals and production-equivalent path permissions:

| Boundary | Required denial proof |
| --- | --- |
| Repair/review/builder filesystem | Cannot read root/provider/Slack/capture/Git-helper credentials, canonical `.git`, control DB/WAL/SHM, release/kernel/coordinator bundles, notifier state, other projects, or other-process `/proc` |
| Repair/review/builder process and network | Repair/review tools have no network; the builder can reach only explicitly pinned package registries. None can reach the App Server control socket, GitHub, Slack, systemd/journald sockets, arbitrary endpoints, or signal candidate/supervisor processes |
| Broker/kernel command | Wrong Unix peer, incident ID, capability, expected state, generation, tree/evidence digest, replay, and command kind are rejected before effects; the non-root coordinator cannot signal/write the root kernel or bypass its evaluator |
| Git import | Shared objects/alternates/hooks/config/remotes, force/non-fast-forward integration, origin movement, unreviewed tree drift, escaping links, and special files are rejected |
| Coordinator/application candidate containment | Probationary coordinator and application candidate cannot write or signal the root kernel/watchdog, control DB, prior slot, policy/evaluator, release record/pointer, canonical Git, notifier target, or installed units after requesting ownership |
| Release/build | Secret-bearing config never enters an artifact; candidate hooks never run as root; tampered digest/owner/mode/path fails promotion and restore |
| Slack notifier | Channel/text/block/markup/mention/link override, invalid SHA/enum/length, wrong incident state, and duplicate logical send are rejected; live history must round-trip the full random incident identity, and ambiguous send performs exact channel/author/UUID/template readback without reposting or trusting `client_msg_id` alone |
| Learning/policy | Pre-verification charter, `AGENTS.md`, retrieval, knowledge, repair-policy, enforcement-engine change, or unreviewed follow-up hardening cannot enter the active bundle; an evaluator-only bypass diff is rejected before review/import |

Each canary records the real UID, unit, mount and capability policy, attempted
path/socket/command, denial result, and any surface not exercised. Source-grep or
mock-only assertions do not satisfy this gate.

## Agent-native capability check

- **Parity:** the repair agent can obtain a redacted brokered view of every
  deployment surface needed for diagnosis and can request the same reviewed
  Git/deploy outcome through narrow root-kernel tools. Raw secret access and root
  shell parity are deliberately excluded capabilities, not hidden prerequisites.
- **Granularity:** evidence reads, Git changes, tests, review submission,
  deployment request, and incident completion are composable primitives;
  deterministic safety decisions remain in code.
- **Composability:** new deployment failure shapes can be diagnosed without
  adding a branch for every error string.
- **Emergent capability:** the agent may investigate novel in-scope deployment
  failures, but cannot expand its authority boundary.
- **Shared workspace:** the standalone incident repository is the canonical proposed-change
  surface used by agent, reviewer, and supervisor.
- **Explicit completion:** durable repair/review completion commands replace
  heuristic end-of-session detection.
- **Dynamic context:** current phase, liveness, release, gate, intent, and
  capability state is rebuilt at session start and refreshable.
- **Visibility:** routine work is quiet in Slack by product choice, but every
  action is durable and inspectable; rollback and blocked states are visible.
- **Reversibility:** Git history, immutable releases, last-known-good provenance,
  and reviewed promotions provide explicit rollback paths.
- **Mobile-specific checks:** not applicable; the agent runs under systemd on the
  Linux service peer.

## Acceptance criteria

1. Three infrastructure-failed attempts followed by one including successful
   attempt produce no stale per-thread failure flood and exactly one verification
   wake for each outstanding exact session/thread.
2. A bot revision that fails after activation is replaced by the exact compatible
   last-known-good release, which passes capture and service probes before
   admission opens.
3. The project channel receives one idempotent restoration alert even while the
   candidate bot is unavailable, and one terminal forward-repair update.
4. The coordinator launches or resumes exactly one repair session for the target;
   a failed repair deployment does not create a second incident.
5. A proven commit regression wakes only its original exact session/thread. An
   ambiguous or drifted mapping never creates a substitute session.
6. A repair cannot reach production without installed path-policy checks,
   focused checks, and an independent `SHIP` verdict over the exact base, head,
   tree, policy, and evidence digests; only the root kernel may fast-forward push
   and deploy it.
7. The repair commit may include its required focused regression test and
   current-state documentation. A reusable lesson, charter/policy/retrieval
   change, or follow-up hardening commit cannot promote until the repair has
   production verification and the separate learning diff has an independent
   `PROMOTE` verdict.
8. Historical replay distinguishes knowledge, retrieval, execution, stale-data,
   evidence, and novel-failure gaps and proves the corresponding improvement
   layer is selected.
9. Real-unit negative tests prove repair/review workers and builder receive no
   secrets or arbitrary privileged mutation surface, and contained coordinator
   and application candidates cannot obtain Git/provider/control credentials or
   mutate/kill the root healer. The
   trusted notifier receives only its required bot-token capability and proves it
   cannot accept arbitrary channel, text, markup, or protected-field input.
10. Current `deploy.sh` remains the documented operator fallback until the new
    control plane completes a verified bootstrap and rollback exercise.

## Non-goals

- A generic deployment platform for unrelated projects or hosts.
- A new Slack channel, dashboard, or high-volume progress feed.
- Automatically repairing feature behavior or reverting user-authored commits.
- Automatic credential rotation, destructive data rollback, health-gate bypass,
  or arbitrary root shell access for the provider.
- A permanent repair-agent conversation or vector database.
- Replacing GitHub, systemd, SQLite, journald, or the existing machine backup.
- Retrofitting the one-time scaffold cutover or bootstrap into normal repair
  incidents during the first implementation.

## Rollout and proof requirements

Implementation planning must split bootstrap from steady state. The first
rollout must:

1. Preserve the current healthy deployment and current `deploy.sh` recovery
   path.
2. Create and validate the control database without consuming current requests
   twice.
3. Install the protected root kernel and first non-root coordinator bundle before
   changing the service runtime pointer.
4. Complete the trusted provider-adapter and non-root candidate containment
   prerequisites; automatic repair remains disabled while either provider tool
   execution or candidate application code can access root control surfaces.
5. Materialize the current healthy revision as the first immutable
   last-known-good release and prove its provenance.
6. Run failure fixtures for pre-activation, post-activation safe restore,
   unsafe restore, dead kernel/coordinator, provider-admission ambiguity, Slack transport
   ambiguity/readback, failed supervisor handoff, and nested repair failure.
7. Run the complete security-negative matrix from the durable lifecycle contract
   under the real systemd principals and production path permissions.
8. Perform one contained live rollback drill with defined blast radius and
   restore path before enabling automatic repair.
9. Enable repair-agent mutation only after deterministic restore and alerting
   are proven independently.
10. Report verified, not verified, risks, and confidence limits from the live
   rollout.

## Open questions

No product decisions remain open. Implementation may choose exact table, command,
and release-directory names, but it may not change the ownership, safety,
notification, learning, or completion contracts above without a new reviewed
design decision.
