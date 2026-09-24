# Trusted-root deployment repair

Slack Concierge is a personal, single-operator service. Its deployment repair
path therefore trusts the same root account and Codex installation already used
for ordinary agent work. There is no project-specific execution tier, alternate
home, credential proxy, filesystem allowlist, or second deployment database.

## Ownership

The existing Concierge SQLite database owns the complete workflow:

- `deployment_runs` remains the single active batch per target. Its ordinary
  status stays `releasing` while repair owns it; nullable `repair_state` records
  `restored`, `repairing`, `reviewing`, `retrying`, or `parked`.
- `deployment_releases` records the Git commit, source archive digest, bundled
  runtime digest, compatibility digest, artifact path, and current
  last-known-good designation.
- `deployment_repair_incidents` records the failed and restored commits, stable
  failure fingerprint, review result, committed repair, and bounded attempts.
- `deployment_repair_agent_runs` records launch intent, supervisor and child
  process identities, explicit Codex session UUID, output paths, and completion.
- `deployment_turn_reactions` records one monotonic per-turn desired/projected
  reaction state, the exact agent-response status target and originating-user
  notification target, and retries Slack delivery without invoking the provider.

The detached deploy runner owns drain, candidate activation, restart, health
proof, rollback, and post-launch incident creation. The bot records the same
incident shape if systemd cannot launch the detached runner. Its transient unit
restarts on process failure, and the bot requeues a dead durable runner. An activation-intent
checkpoint is committed before `current` moves, so either path recognizes an
interrupted candidate and restores LKG on the same run. The root systemd repair
unit owns standalone CLI execution, diagnosis, Git integration, and retry. It is
outside Concierge's managed provider queue and does not borrow a managed session.
Deployment machinery records evidence and available commit-to-task authorship
mappings but never infers causality or selects a feature task as the culprit.
Candidate preparation is an evidence boundary too. The release builder returns a
bounded structured error before activation; the deploy runner prints that result
and retains it in the failed run and repair incident. Shell fail-fast handling
must not exit from the command substitution before that evidence is recorded.
Without the builder's error, repair can prove only the failed stage and must not
guess at an application correction or repeat the candidate for diagnostics.
The same mappings drive the durable Slack status projection on each turn's first
delivered final response and mirror each lifecycle reaction onto the exact
originating user input so Slack can place every transition in that user's
Activity feed. The agent response remains the authoritative status target.
Neither reaction starts or resumes a provider session.

## Immutable releases

`bot/src/deployment-release.ts` builds releases from committed Git archives, not
from the mutable checkout. Normal releases use one commit for both application
and control provenance. The one-time cutover explicitly combines application
bytes from the proven live commit with control bytes from the reviewed cutover
commit; its manifest records and verifies both commits and both archive digests.
It bundles the bot entrypoint and every deployment,
state, recovery, repair, gate, and health command needed to recover the
next candidate. The two Node bridge entrypoints are bundled with their WebSocket
dependency so neither runtime resolves modules from a mutable checkout. It also
copies the stable shell launchers, unit definitions,
route configuration, and runtime helpers. Every file is hashed before the
content-addressed directory is made read-only.

The stable launcher and Bun executable live under
`/usr/local/lib/slack-concierge-deployment`. Content-addressed releases, the
`current` application link, `control` deployment link, incidents, agent logs,
and final messages live under `/var/lib/slack-concierge-deployment`. Candidate
testing advances only `current`; all rollout and repair commands continue from
the verified `control`/LKG artifact. Promotion records the proven LKG in SQLite
before advancing `control`; every restoration reconciles both pointers from
that database authority, including after a crash between those operations.
After promotion, the runner refreshes the installed systemd units and router
action wrapper from that promoted artifact before recording deployment success;
the initial install from prior LKG is not sufficient for either surface.
Ordinary deploy refuses to activate a
candidate until a verified last-known-good release exists.

## Artifact contents

A release's control directory is declared once, in `bot/src/deployment-artifact-files.json`
(bundled commands and copied files, destination to source). Two rules keep that declaration
from ever stranding deployments:

- **A release is built from its own declaration.** The running control builds the next
  candidate, so the building code is always one version behind the code being packaged.
  `prepare` therefore reads the declaration from the candidate's control source, and uses its
  own built-in copy only for a source that predates the file. A file added in a commit is in
  that commit's release even when an older control builds it.
- **A release is valid by the file list sealed in its own manifest.** `verify` compares the
  directory with `manifest.files`, checks every digest and the runtime digest over that list,
  and requires only the three entrypoints the stable launcher runs by name
  (`control/deploy.sh`, `control/deployment-repair.js`, `control/release-manager.js`). It never
  compares a release with the current code's list, so later code that adds or removes a file
  cannot invalidate a release that was correct when built. The manifest cannot change without
  changing its digest, which is the directory's name.

Incident, September 21, 2026: a commit added `control/parakeet-server.cpp` to the list. The
running control built that commit's release from its older list, so the release lacked the
file, yet the release's own code — now the control — required it. The last-known-good release
could not verify itself, so every deploy stopped at the rollback check before activation, and
no code push could help because the check runs inside the control. Recovery used
"Self-verification controller recovery" in the [deployment runbook](../runbooks/DEPLOYMENT.md).

## Failure and repair sequence

1. The detached runner cannot launch, any durable rollout step fails, a
   candidate restart/functional proof fails, or a runner disappears after
   activation intent was persisted.
2. If candidate activation began, deploy switches `current` back to the
   recorded last-known-good artifact, restarts Concierge, and re-proves capture
   and application health. A pre-launch failure leaves the already-healthy LKG
   runtime unchanged.
3. Admission gates reopen only after that proof. The deployment run remains
   active and receives or updates one repair incident.
4. `concierge-deployment-repair@<incident>.service` runs as root with `HOME=/root`.
   Repair Codex receives full host access, the failure evidence, the
   LKG-to-candidate commit range, and any opaque task-provenance mappings. Those
   mappings establish authorship context only. The same mapped turns change
   from 📦 to 🛠️ without being labeled causal. The agent may inspect journald,
   systemd and retained source and owns diagnosis of the actual cause. Its prompt
   forbids tests, reviews, other agents, managed enrollment, production ledger
   writes, deployment, pushing and service/provider restarts. Writable production
   state configuration and managed identity are removed from its environment.
   The supervisor owns integration; the existing detached controller owns restart.
5. A repair launch persists its requested resume UUID separately from child
   identity and provider-observed UUID. PID and session callbacks may arrive in
   either order; repeated identical callbacks are idempotent. A dead bound child
   resumes the same UUID. With no child identity, the exact unit cgroup must be
   empty except for the current supervisor. An ambiguous fresh launch parks.
   The adapter opens logs and installs listeners before callbacks, and kills
   and reaps its process group if bookkeeping fails.
6. The CLI returns structured `repair_committed` with an exact commit and next
   action, or `blocked` with a concrete blocker and next action. A blocked,
   missing or malformed result parks immediately. A claimed repair must match
   clean worktree HEAD and descend from the recorded base. Commits alone are
   not recovered as success without the completed agent's structured result.
   No review is launched or recorded; historical review evidence stays retained.
   The result schema retains the historical `deployment-repair-review.schema.json`
   artifact filename so the installed LKG builder and both release verifiers keep
   the same immutable file set during normal promotion. Its content now describes
   repair outcomes, not review verdicts.
7. The supervisor fetches `origin/main`, proves the recorded base is unchanged,
   and performs a non-force push. If origin moved, the same repair session may
   rebase within the existing incident budget. Retry records the explicit human
   no-test/no-review policy and `review_performed: false`, never a fabricated
   `SHIP`. An active historical reviewed incident requires operator resolution.
8. The same durable deployment run retries and its mapped turns return to 📦.
   Success records the exact runtime and health proof, replaces their marker
   with 🚀, and invokes no feature agent. The third recurrence of the same
   candidate-health failure parks the incident and replaces 🛠️ with 🛑.

## Recovery invariants

- A live prior child is never duplicated.
- A bound dead child resumes by explicit UUID; `--last` is never used.
- An unbound ambiguous launch never starts another agent.
- A completed structured repair result plus its exact clean commit, and an already
  pushed commit, are restart boundaries. Historical reviews are evidence only.
- Candidate and restored commits remain separate evidence. Recurrence hashes
  stable failure class, stage, and exit evidence across repair commits; a
  materially different failure resets the counter.
- Startup recovery runs from the immutable control artifact before the bot. It
  restores LKG for a dead post-activation runner, then the healthy LKG bot
  relaunches the persisted repair incident.
- A dead retry owner before activation is requeued on the same run. A dead retry
  owner after activation restores both application and control pointers before
  the same incident continues.
- Git integration is non-force and conditional on the recorded base.
- The shared managed Codex App Server is a dependency, not a deployment target.
  Repair uses the installed CLI but never installs Codex or restarts that daemon.
- Parking is terminal and visible; systemd does not endlessly restart a parked
  incident.

The incident separately owns the supervisor PID/boot/start identity, since a
deployment retry temporarily owns the run's runner fields. Each new supervisor
claim consumes one of three process attempts. Only a new validated repair commit
resets this count; launch, acknowledgement, status rewriting,
and re-recording the same checkpoint do not. The third caught failure parks;
after a hard death the next claim parks before further work. The native unit
also allows only three starts in five minutes for failures before SQLite can
record a claim. A later worker lifecycle signal translates `start-limit-hit`
into the same durable parked outcome.

Separately, the existing agent-run rows enforce at most three CLI launches and a
thirty-minute window from the first launch across the entire incident. Resumes,
rebases, changed failure fingerprints and new commits cannot reset this budget.
The adapter stops only its own repair process group when that deadline expires.
The deadline does not kill the detached deploy runner or bypass user-priority
draining; a deployment already handed off may continue waiting for an idle boundary.
After it restores or completes, the supervisor records its outcome and may not
launch another CLI outside the budget.

Terminal outcomes are written as `outcome.json` under the existing incident
directory and to the repair unit journal, independently of the bot being alive.
`operator_required` retains the blocker, exact incident/run/session IDs, commit
and log/final paths, and instructs a standalone operator to resolve the blocker
through normal Git delivery. `deployed` requires the existing deployment run to
have succeeded. These records are durable escalation evidence, not proof that a
notification reached Tejas. Existing notice delivery remains separate; there is
no new Slack publication or notification service.

Automatic runs have no feature request rows. Failure notices fall back to their
existing reaction targets and exact originating turn roots, deduplicated per
thread. They use the existing notice writer and never infer recipients from
channel recency.

## Explicit controller recovery

Broken control code cannot be fixed by a source commit that retries the old
immutable executable. The operator-only `release-manager recovery-start` path
builds a hybrid artifact from the healthy application commit and the reviewed,
integrated control commit. It checks a clean source tree and exact review
attestation, persists provenance in existing run events, and returns after
handing the operation to one transient systemd unit. That unit executes only
the prepared immutable control, including the built drain command with its
five-second SQLite busy timeout.

When a repair-agent test erased the entire deployment domain, the incident and
its final run are no longer database facts. A specifically human-authorized
`--operator-exception` may replace the ordinary `SHIP` attestation only for this
registry-loss boundary: it records the superseded no-test/review policy, the
previous `NO_SHIP`, exact failure/rollback observations and backup digest. Before
any import, the operator verifies a read-only integrity-clean backup, its sole
successful LKG run/functional-health evidence, the immutable artifact manifest,
both installed release pointers, a clean exact `origin/main` control source, and
the prior repair unit's quiescence. The source then imports only the backed-up
successful LKG run/release and reserves one active operator recovery run in a
single immediate transaction. The backup's stale updating run and missing
incident are *not* reconstructed; original failure evidence is retained as a
run event. The newer signed desired state and all current conversations remain
unchanged. The normal detached controller claimant and its admission, activation,
health, App Server identity, rollback and re-entry gates remain unchanged. Once
new control becomes LKG, the existing worker may enroll the pending desired
application revision. This exceptional branch never treats `NO_SHIP` as `SHIP`.

When the deployment domain is intact but an LKG controller's deferred SQLite
writer upgrade prevents promotion, source-only candidate retries continue to
execute that same control. The separately human-authorized promotion-lock
exception pins the existing **parked** failed run and `NO_SHIP` review as
historical facts, the original rollback plus a newly proven live LKG invocation,
the signed desired commit and the exact corrected integrated control revision.
It never overwrites the incident's review. All deployment-domain transactions
claim the WAL writer before ownership reads; for this exception, controller
intent and one replacement run are reserved atomically only after proving there
is no active normal runner. The resulting detached recovery uses the unchanged
provider/capture idle, activation, health, rollback and App Server gates. A
currently draining ordinary run must yield or finish under its existing owner;
the operator may not launch another recovery runner while it remains active.

The ordinary explicit claimant proves the prior repair unit quiescent, then atomically
parks its incident and reserves a replacement run with `repair_state=repairing`
and no agent incident. Only after winning ownership may it replace the verified
installed repair template with a persistent mask. Its bytes must match either
the verified LKG or the exact reviewed recovery artifact, and that provenance
is recorded before replacement. This reservation, rather than
the supplementary mask, excludes both old deploy and repair workers. Re-entry
requires the prior recovery owner dead and reuses the exact durable artifact.
An explicit failure also retains the reservation; it cannot reopen old-worker
admission. This exceptional operation has no feature requests/reaction targets
and does not consume pending desired application state.

The detached operation uses existing user-priority provider and capture gates,
persists activation intent, activates the healthy application with new control
bytes, and proves application/capture health plus unchanged shared App Server
identity. Only then does it promote LKG/control, install the normal units and
router helper from that artifact, and clear its own containment. Independently
imposed masks remain. A failure restores and re-proves the database-authoritative
LKG, reopening gates only when safe, and leaves an explicit recovery notice.

The ordinary startup dead-candidate selector intentionally excludes this
reserved run. A process or host death requires `recovery-start --run-id` to
restore/prove from recorded activation intent; it must not silently start old
control. After recovery succeeds, the ordinary worker may deploy the still
pending desired application commit. No feature agent waits for that rollout.

The focused executable specifications are
`bot/tests/deployment-repair-trusted-root.test.ts`,
`bot/tests/deployment-state.test.ts`, and `bot/tests/deploy.test.ts`.
