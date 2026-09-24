# Deployment and autonomous repair

`origin/main` is the desired deployment state. Code moves through GitHub; never
copy or edit project files on the service peer. A signed GitHub `push` webhook
for `tejasdc/slack-concierge` `main` advances one durable desired-state record,
and the event-driven worker creates at most one active deployment run when that
commit differs from the immutable last-known-good release. The detached runner
waits for active provider and capture work, pulls with rebase, installs the
frozen dependency graph, activates an immutable candidate, restarts Concierge,
and proves the exact runtime before success. A terminally failed candidate
stays blocked until a later signed push advances the desired state. A failed
Git update gets one new attempt after the shared checkout becomes clean; the
owner checks once a minute even without a new push.
Startup resumes already accepted durable work but deliberately does not scan Git
history for pushes received while Concierge was offline.

`bot/scripts/deploy.sh` remains the operator-only forced rollout and recovery
entrypoint. Ordinary agents do not invoke it or register deployment requests.

Before the canonical checkout pulls, the runner moves all modified and untracked
files into a timestamped `preserved/deploy-*` branch and a linked worktree under
`.worktrees/`. It stages and commits the exact captured state there, verifies
the worktree is clean, then records the branch, worktree, commit and file list in
the durable deployment run. It immediately posts a service message in the
native Inbox and raises it to Needs attention through the same path as the key
change notice. The message gives the file list, branch and worktree and says
when the editing session cannot be established. No provider turn or Thinkering
UI change is required for the notice. The Git stash remains until that proof
succeeds; if preservation fails, the runner stops and attempts to restore the shared
checkout, retaining the stash for manual recovery. The structured unit journal
prints the same location and file list immediately. Ignored files are outside
Git's untracked set. A writable delegated Codex CLI command in a canonical
checkout is refused by the managed pre-command hook with `wt <task-name>`;
read-only review commands remain allowed.

The repair architecture is documented in
[trusted-root deployment repair](../architecture/DEPLOYMENT-REPAIR.md).

## Normal operation

For a broken repair controller, use the explicit recovery procedure below;
restarting the same unit or pushing source alone still executes old control.

## Recovering the repair controller

Use only with explicit operator authorization and an exact contained incident.
Stop its `concierge-deployment-repair@<incident>.service` first and preserve its
worktree/logs. From a clean task worktree at the independently reviewed commit,
integrated into `origin/main`, run the existing migration command before loading
the corrected state module; it backs up the database and checks integrity.
Set `CONCIERGE_STATE_DIR` to the service state directory for both commands.

The September 15 registry-loss incident is exceptional: the prohibited repair
test deleted all deployment runs/releases/incidents but retained newer sessions
and a signed desired SHA. Do not restore the whole database, import the stale
`e030ac1e` updating row, invent incident fields, or fabricate `SHIP` for the
retained `NO_SHIP` result. Preserve the WAL-inclusive post-loss backup and its
forensic copies. Use the exact earlier integrity-clean backup containing the
successful LKG (`f6f14fa6` / `a2e4b9f6`) after matching its manifest, installed
`current`/`control` pointers and health evidence. Prepare an operator-exception
JSON file recording actual human authority, not a review attestation:

```json
{
  "kind": "human_authorized_registry_loss_control_recovery",
  "human_scope": "fix_the_pipeline_and_native_inbox",
  "no_tests_input": "1789490492.818709",
  "review_policy_superseded_input": "1789490293.092859",
  "previous_review_verdict": "NO_SHIP",
  "control_commit": "<exact-origin-main-SHA-after-control-fix>",
  "registry_backup_digest": "<sha256-of-clean-pre-loss-backup>",
  "lkg_artifact_digest": "a2e4b9f6c468c92ed635baa95a5ab2c73dec44c1299c83779a56441b6f5bb1f5",
  "prior_incident_id": "84934ba3-a60c-4b08-93d6-7ea4e71eaebe",
  "failure": {
    "run_id": "e030ac1e-c4ff-44f3-89cd-39111ffbecda",
    "failed_commit": "b49c8e16d3902aaeccc9b378860070daa98370fd",
    "candidate_runtime_sha": "b49c8e16d3902aaeccc9b378860070daa98370fd",
    "candidate_service_invocation_id": "d39ae89711b34fe7af1040c1fb71f66c",
    "failed_control_stage": "deploy-state.js initializeRouterSearchIndex: view router_search_sources already exists"
  },
  "rollback": {
    "runtime_sha": "3ca992d287640bdc0307c3967c99ce18fb56a999",
    "service_invocation_id": "83b075f900ce450998b3aae1a7c5f4c7"
  }
}
```

After integrating the exact corrected source into `origin/main`, invoke from
that clean worktree with the earlier backup and exception file:

```bash
CONCIERGE_STATE_DIR=/root/.local/state/concierge bun bot/scripts/release-manager.ts recovery-start \
  --incident-id 84934ba3-a60c-4b08-93d6-7ea4e71eaebe \
  --source-root "$PWD" --control-commit <exact-origin-main-SHA> \
  --registry-backup /root/.local/state/concierge/backups/state.pre-deployment-repair.1789514253054.db \
  --operator-exception <absolute-operator-exception.json>
```

The entrypoint verifies source and prior repair-unit quiescence, builds an
immutable hybrid with the healthy application commit and corrected control,
then atomically imports only the LKG run/release and reserves its active
control run. Thus the existing worker cannot start old control against the
newer desired SHA in the interval after import. The receipt `handoff_accepted`
only proves detached enrollment. End the provider turn; the existing detached
unit proves health and promotes control before ordinary desired-state rollout.
Retain the exception bytes and digest alongside the backups and historic logs.
If it fails, reenter only its recorded `--run-id`; never trigger a second runner.

### Self-verification controller recovery

Symptom: every deploy fails with `Deployment state migration failed: No verified immutable
last-known-good release was available for rollback.`, the unit log says `no verified immutable
last-known-good release exists`, and running the LKG's own
`control/release-manager.js lkg` reports `Release artifact file set is invalid`. The control
rejects its own release, so no push can fix it; no repair incident exists because deploy stops
before activation. See "Artifact contents" in
[deployment repair](../architecture/DEPLOYMENT-REPAIR.md).

Use only with explicit human authorization. Integrate the corrected source into
`origin/main`, then from a clean task worktree at exactly that commit write an exception file:

```json
{
  "kind": "human_authorized_lkg_self_verification_recovery",
  "control_commit": "<exact origin/main SHA>",
  "prior_incident_id": "<fresh UUID; no incident may exist with it>",
  "lkg_artifact_digest": "<artifact_digest of the recorded LKG>",
  "failure": {
    "run_id": "<id of the latest deployment run, which failed>",
    "error": "Deployment state migration failed: No verified immutable last-known-good release was available for rollback."
  },
  "rollback": {
    "runtime_sha": "<git_commit of the LKG>",
    "service_invocation_id": "<InvocationID of the running concierge-bot.service>"
  },
  "human_authorization": { "input_id": "<the human's message ID>", "words": "<what they said>" }
}
```

```bash
CONCIERGE_STATE_DIR=/root/.local/state/concierge bun bot/scripts/release-manager.ts recovery-start \
  --incident-id <same fresh UUID> --source-root "$PWD" --control-commit <exact origin/main SHA> \
  --operator-exception <absolute path to the exception file>
```

It refuses unless the LKG's own control rejects the LKG, the corrected verifier in the source
accepts it, the latest run is that exact failure with no active run, and `current`, `control`
and the running service are the healthy LKG. It then builds a hybrid of the LKG application
and the corrected control, reserves the recovery run against the failed run, and hands off to
a detached unit. End the provider turn: the unit waits for the deployment gate, restarts onto
the same application, proves health, promotes the corrected control, and ordinary rollout of
the desired commit follows — with one exception: a desired commit whose own deploy attempt
already failed at the rollback check stays blocked (the worker never retries a commit that
failed, so a broken commit cannot loop), even though the fault was the control's. Push the
next commit to roll out. First used September 21, 2026 (human input
`ed677204-b732-4e3a-bcd7-e800401dd97e`, session `concierge:3425`): recovery run
`9dda9596` succeeded and promoted control `de6f3b8` over application `773c453`; the
desired `de6f3b8` stayed blocked by its failed attempt `61781f8e` until this note was pushed.

For an intact registry with an existing exact incident, the regular independent
review / `SHIP` path below is unchanged.

```bash
CONCIERGE_STATE_DIR=/root/.local/state/concierge bun bot/scripts/migrate-deployment-repair.ts
CONCIERGE_STATE_DIR=/root/.local/state/concierge bun bot/scripts/release-manager.ts recovery-start \
  --incident-id <exact-incident-id> --source-root "$PWD" \
  --control-commit <reviewed-origin-main-sha> --review-evidence <absolute-review-attestation.json>
```

The regular release attestation contains `verdict: "SHIP"` and
`reviewed_commit: "<exact final SHA>"`; keep the independent report alongside it.
Under the repository's one-review policy, the implementation owner verifies
the single correction pass and self-reviews the final diff. If that pass changes
the SHA, the attestation must separately record the independent review's actual
SHA/verdict and the correction checks; never relabel the independent verdict
as a review of different bytes. Integrate the final SHA by fast-forward so it
equals `origin/main`, and preserve the verified unit bytes until containment.
The API records the attestation digest and source-tree digest, builds a verified
hybrid release, and returns `handoff_accepted` with its durable run ID and unit.
This is acceptance of the handoff, not proof that rollout finished. End the
provider turn so the existing deployment gate can reach idle; do not add a
deployment waiter. The detached unit preserves the healthy application commit
while proving and promoting the corrected control.

For the **intact** parked promotion-lock incident `82f13bc4-42c6-4ecb-920d-a20efbbcff9f`,
the source fix `f81cfb61` was reviewed and pushed but the old immutable control
`8ae4b930` still executed the failed promotion. Its next repair revision
`d3cea39c` changed only documentation; the existing incident retains the real
`NO_SHIP` report and same-failure count of two. Do not relabel that report, retry
old control, restore the registry, or import a stale run. The operator's explicit
human no-test/no-review authorization permits a **separate** digest-pinned
`human_authorized_deployment_control_lock_recovery` exception for corrected
`origin/main` control; it is never a forged `SHIP` report. Record the exact
parked run/incident, failed candidate artifact and both observed releasing
invocations, original rollback invocation, current live LKG invocation,
previous review commit/verdict/JSON digest, failure stage and signed desired
commit. Keep the JSON as a regular file under the state backups directory.
Both immutable pointers must still match the proven healthy application release.

The intact-incident branch checks the exact human inputs and ledger facts,
unit/cgroup quiescence, current service invocation and functional application
plus capture health. Its immediate transaction atomically reserves one
control-recovery run only when **no normal deployment run owns the target**;
the parked incident and its historical review remain unchanged. From the
clean integrated task worktree run `recovery-start` with `--incident-id`,
`--source-root`, `--control-commit` and `--operator-exception`, **without**
`--registry-backup` or a replacement `--review-evidence`. An active normal
runner is an ownership conflict, not permission to stop it or launch a second
runner. End the current provider turn so that run can reach the user-priority
idle gate; re-evaluate its actual terminal result before the operator handoff.

If the recovery process dies or reports a failure, its run remains reserved and
cannot be picked up by ordinary workers. After diagnosing the recorded failure,
re-enter that exact operation from the reviewed tooling:

```bash
CONCIERGE_STATE_DIR=/root/.local/state/concierge bun bot/scripts/release-manager.ts recovery-start --run-id <recovery-run-id>
```

It rejects a live owner, reuses the pinned artifact, and restores/re-proves from
recorded activation intent. Never clear its reservation by editing SQLite or
unmask old control to force progress. Its own persistent template mask is
replaced with the promoted normal unit only after health proof. Independently
imposed masks, including a terminal historical incident's instance mask, stay
intact. This operation does not restart the shared Codex App Server and does
not mark pending feature commits shipped.
If LKG restoration cannot be proven after activation, the held gates block
user work until explicit operator recovery establishes health and releases them.

## Ordinary delivery

Ordinary agent work ends at `git push origin main`. No deployment-specific
prompt, command, task enrollment, polling, or success continuation is required.

`main` only moves forward. GitHub ruleset `23901100` ("main cannot be rewritten or deleted",
no bypass actors) refuses a forced push or deletion of the default branch, for every agent and
machine alike: all of them push as the same account, so nothing short of the server can tell
them apart. To correct a pushed commit, push another commit. On September 23, 2026 a session
amended a commit 36 seconds after pushing it and force-pushed the copy (19:58 UTC); the
webhook had already recorded the original as the desired commit, which no branch then had, and
nine deployments restarted the service in eleven minutes chasing it. The refusal was proven on a
probe branch before it was applied to `main`. Thinkering and remote-box are private
repositories, where GitHub offers rulesets only on a paid plan, which Tejas declined; there, and
here as well, the machines refuse it instead: agents' forced pushes and rewrites of pushed commits
are refused before they run, and git's pre-push refuses the push itself in every checkout. See
"Pushed history is never rewritten" in AGENTS.md.
GitHub delivers a signed event to capture ingress, which validates the exact
repository and branch before forwarding a normalized loopback receipt to the
trusted bot. The bot fetches `origin/main` once for that receipt, proves both
the event commit and last-known-good release are ancestors of the fetched tip,
records the monotonic desired commit, and wakes a coalescing worker. An event
arriving during a worker pass guarantees one further pass. The worker creates a
fixed transient systemd unit. The
runner tests provider admission atomically. If any provider work owns the
system, the runner immediately releases its trial gate and sleeps; Concierge
remains fully open to new turns and queued user work continues normally. A turn
completion wakes the runner only after Concierge has synchronously promoted any
queued successor. A long fallback wake protects liveness if a nonstandard owner
completion emits no signal; it is not an active two-second provider poll.
Further accepted pushes advance the same durable desired record and are included
by the active pull or the next run after the current run reaches a terminal state.

For an immediate operator-forced rollout:

```bash
cd /root/workspace/slack-concierge
bot/scripts/deploy.sh
```

Git authentication comes from the root account's existing `gh` credential
helper. Callers do not inject or copy tokens. Origin is tested before either
admission gate is claimed.

Every managed provider turn receives one opaque commit-provenance token. The
tracked `.githooks/prepare-commit-msg` hook appends it as a
`Concierge-Provenance` trailer, and SQLite maps it to the originating turn,
provider session, and Slack thread. Direct provider shells receive the token in
their environment. Codex code-mode commands execute through a persistent host,
so the hook instead uses that command's `CODEX_THREAD_ID` to resolve exactly one
currently running turn and its existing token. A thread identity always takes
precedence over an explicit token, and the persistent Codex thread environment
never receives the turn-scoped token; otherwise a later turn on the same thread
could inherit stale attribution. Zero matches remain a valid unattributed manual
commit; multiple live matches are rejected as ambiguous.
Deployment configures the shared Git repository with the canonical checkout's
absolute tracked hook directory, so every linked worktree runs the same current
hook even when its branch contains an older `.githooks` snapshot. The trailer
proves only which task authored a commit; it does not prove which commit caused
a failed deployment.

Concierge projects deployment state directly onto the first delivered final
response message of each attributable completed agent turn. It never targets
the user's request, a progress update, or an unfinished turn. These reactions
are durable status, not provider turns:

- 📦 means the turn has at least one commit picked up by the current run;
- 🛠️ replaces 📦 while autonomous repair owns a failed candidate;
- 🚀 replaces the transitional reaction only after exact runtime and health
  proof succeeds; and
- 🛑 replaces 🛠️ only when autonomous repair parks for operator attention.

Each turn owns its own marker. A later follow-up or another agent turn receives
its own reaction lifecycle and never removes an earlier turn's 🚀. Reaction
transitions add the new marker before removing the previous marker, so an
interrupted Slack call cannot erase the only visible deployment state. Commits
without a valid provenance mapping remain deployable but have no Slack target.
The accepted desired-state snapshot supplies the initial picked-up set;
candidate activation reconciles any additional commits from the exact immutable
candidate. Deployment, repair, and turn-settled state transitions signal the
worker directly; there is no recurring in-process deployment poll.

Slack does not surface an app reacting to its own response as a personal
Activity item. Concierge therefore mirrors each lifecycle reaction—📦, 🛠️,
🚀, or 🛑—onto that turn's exact originating user input. The mirror is an
attention notification only; the agent response remains the authoritative
deployment-status target. Both targets come from the same turn provenance and
are advanced together by the same retry-safe reaction projection.
Machine-triggered operational turns have no originating user input and project
only on their delivered response; see [operational alerts](GRAFANA-ALERTS.md).

🚀 proves that an attributable commit reached an exact healthy runtime. It does
not prove the changed feature path. A later user-initiated turn may establish
that separate claim through [live Slack integration acceptance](LIVE-ACCEPTANCE.md);
no deployment reaction starts or resumes a provider.

## GitHub webhook

The repository has one active `push` webhook with this exact URL:

```text
https://95-217-119-40.sslip.io/github/slack-concierge-deploy
```

It uses `application/json` and the existing root-owned `capture_queue`
credential as its HMAC secret. Capture ingress validates `X-Hub-Signature-256`
over the raw request bytes, accepts only `push` events for `refs/heads/main`,
and forwards only the delivery ID, repository, ref, and commit SHA to
`127.0.0.1:8082/github-push`. The loopback receiver independently validates its
Bearer credential and envelope. GitHub `ping` requests are authenticated and
acknowledged without creating deployment work.

The direct `sslip.io` origin avoids coupling deployment liveness to the capture
Worker's intentionally narrow Pebble route allowlist. Do not add this endpoint
to `config/capture-routes.toml`: it is a fixed control-plane route, not a user
capture adapter.

User work outranks rollout. A waiting deployment owns neither provider nor
capture admission and may be postponed indefinitely by active or newly queued
requests. It claims both gates only after an atomic provider check wins a true
idle boundary, immediately before the short update/restart window. A Slack
request that races that gate is still classified and persisted as an ordinary
queued turn; after the new process releases the gate, the startup queue begins
it automatically without asking the user to resend. Capture ingress likewise
remains durable, and its delivery gate is not claimed while the deployment is
merely waiting for providers. Deployment then records the phase sequence
`prepared → draining → updating → restarting → verifying → releasing`.
While a run waits, the owner status (`GET /sessions/v1/status` `deployment`) names the
sessions it is waiting on, since when, and any background job holding a Claude run open,
and Thinkering shows it. A Claude run stays live while its background work runs (up to
six hours; see provider sessions), so a release can wait that long. Stopping that session
is how Tejas lets the release go ahead sooner; nothing forces it automatically.
Success additionally requires:

- active capture ingress with its authenticated local health check;
- active Concierge with a nonzero systemd `MainPID`;
- an online marker from the current systemd invocation;
- the exact candidate Git SHA in that marker;
- successful Slack authentication and Codex App Server `model/list`;
- released provider and capture gates; and
- a second proof of the same service invocation and runtime SHA immediately
  before terminal success.

The candidate release comes from `git archive <commit>`, not mutable worktree
bytes. It contains both the application and the autonomous deployment/repair
commands. `/var/lib/slack-concierge-deployment/current` selects the application
under test; `/var/lib/slack-concierge-deployment/control` stays on LKG until the
candidate passes and is promoted. Ordinary deploy refuses to proceed unless a
verified immutable last-known-good release already exists.

Candidate preparation compiles the archived TypeScript before it creates or
activates a release record. SQL embedded in a TypeScript template literal must
therefore avoid unescaped template-literal delimiters even inside SQL comments;
SQL treats them as comment text, but the TypeScript parser sees them first. A
compile failure leaves no candidate artifact and the deploy restores the prior
LKG without changing the immutable control authority.

Dependency directories are mutable installation output and must never be
committed, including as absolute symlinks from a task worktree. A symlink that
targets the service checkout's own dependency directory becomes self-referential
when Git checks it out there, so Bun stops with `ELOOP` before candidate
construction. The repository ignore rule covers dependency directories; keep
them outside every commit and let the deployment install from the committed
manifest and lockfile.

## Automatic failure behavior

If the detached runner cannot launch, or if a durable rollout step, candidate
restart, or functional health proof fails, Concierge records one incident on
the same active deployment run and starts the same repair service. A launched
candidate is first switched back to the recorded last-known-good artifact, and
Concierge re-proves capture and application health before reopening admission:

```text
concierge-deployment-repair@<incident-id>.service
```

That service runs Codex as root with the normal `/root` home and full host
access. It receives the failure logs, the complete LKG-to-candidate commit
range, and all available task-provenance mappings. Deployment code does not
select a culprit. The repair agent diagnoses causality, commits the smallest
repair in an incident worktree and returns a structured committed-or-blocked
result. The supervisor non-force pushes only after proving the recorded
`origin/main` base, and retries the same deployment run through the existing
detached controller. No manual polling is required. A successful retry records
its runtime proof and wakes no feature agent. The third identical candidate-health
failure parks the incident.

Current human policy forbids both tests and reviews. The supervisor and child
adapter reject review launches; the review-recording entrypoint is disabled.
Retries record the human policy exception explicitly and leave review verdicts
unset. Old incident verdicts and logs remain historical evidence, never rewritten
as approval. The immutable controller recovery procedures above remain separate
operator-only authorities; do not invoke a prohibited review to satisfy them.
If their existing specific exceptions cannot authorize the observed incident,
retain the blocker and exact next operator action instead of inventing approval.

A blocked or malformed model result, mismatched commit, or exhausted budget
parks with a concrete operator escalation. Each incident permits at most three
CLI launches within thirty minutes of its first launch; resumes, commits and
rebases do not reset this limit. Timeout stops only the repair CLI's process group.
It never interrupts managed feature providers or the detached runner's idle gate.
Terminal `outcome.json` in the incident directory and structured unit-journal
output retain the incident/run/session, commit, reason and log/final paths even
when the application is unavailable. `operator_required` means the operator must
inspect that evidence and resolve the blocker via a standalone CLI and normal
Git delivery. It does not claim a human notification was delivered. `deployed`
requires the deployment ledger's existing successful runtime proof.

The transient deployment unit restarts on runner failure. The durable run is
also requeued when its exact process identity dies. If death happened after the
activation-intent checkpoint, immutable startup recovery restores LKG before
Concierge starts and creates the repair incident on that same run. The repair
path does not install Codex and does not restart the shared managed Codex App
Server.

Systemd restart is only crash recovery for a still-active run. If a transient
unit starts again after its durable run has already reached `succeeded`,
`failed`, or `ambiguous`, the claim command reports that terminal state and the
runner exits successfully without repeating deployment work. This prevents a
terminal run from becoming a permanent ten-second systemd restart loop.

Terminal diagnostics lead with the deployment outcome and a plain-language
reason for the failed operation. No deployment outcome starts a feature-agent
turn. Shell exit status, failed command, source line, and internal stage remain
structured `deployment_run_events.detail_json` diagnostics. The durable run ID
and systemd unit suffix identify the complete evidence in SQLite and journald.

## Inspect a run or repair

Incident `82f13bc4-42c6-4ecb-920d-a20efbbcff9f` failed after candidate health had
passed, despite its broad `candidate-restart-and-health` stage label. In
`concierge-deploy-df7076f0-80e.service`, candidate `df00010` passed at
`2026-09-16T00:56:52Z` and again at `00:56:54Z` with invocation
`b3a79a96776e485b9684dff0decf089f`. The promotion command then reported
`database is locked`; no `release_promoted` event was recorded. Rollback restored
`135a6754`. Repair supervisor attempts at `00:57:04Z` and `00:57:14Z` also failed
at the first update in `claimDeploymentRepair`.

Promotion and repair claiming now use immediate SQLite transactions to reserve
the writer before reading their ownership guards. This removes their deferred
read-to-write upgrade race with the running service while preserving the existing
busy timeout, guards and atomic writes. The promotion error did not retain a stack
or SQLite extended error code; its exact failing statement is therefore unknown.
The repair-claim stack does identify the first update. This correction is grounded
in retained logs and source inspection; no agent-run tests or rollout were performed.

Incident `8035bd30-16b1-42b7-8522-34f2088222bd` exposed a second lock hand-off.
The deployment migrator loaded and committed the application schema, then tried
to reserve a new writer transaction for deployment schema. The live service could
take the writer between those steps; on September 23 the migration then exhausted
the five-second busy timeout and rolled back before candidate activation. The
ledger connection is now opened without application-schema side effects, and the
migrator reserves one outer writer transaction before loading either schema owner.
Nested schema transactions remain savepoints inside that reservation, so there is
no unlocked interval between the two migrations. Standalone deployment commands
also no longer initialize unrelated application schema merely to read or update
deployment ownership. Journald remains the source for the exact SQLite error and
stage; a repair commit alone is not activation evidence.

Application startup records `concierge_startup_phase` for recovery, required Canvas
refresh, the Slack connection, the request API, the capture worker, and provider
readiness. Each phase emits `started` followed by `completed` or `failed`; an unmatched
`started` in the same systemd invocation identifies the outstanding wait. These records
contain only phase and status, not credentials or user content. They do not replace the
exact-SHA online marker or change admission, retries, or health-check deadlines.

Incident `2ef0a592-2f82-4f88-ab36-af8815159bf7` exposed the missing boundary evidence.
Candidate `efa9fc09805e4619d338fa1030071afb397a9064` completed recovery at
`2026-09-15T22:54:58.887Z` (PID 3173606), emitted no capture-worker or bot-online marker,
and was stopped at `22:55:25.749Z` after the health window expired. Restored runtime
`3ca992d287640bdc0307c3967c99ce18fb56a999` emitted its online marker at
`22:55:32.744Z`; the deployment runner recorded successful health proof at `22:55:36`.
The retained evidence establishes an unfinished runtime startup, but does not distinguish
the Slack connection wait from the subsequent capture startup wait. No crash, failing
authentication result, or causal feature commit was established. The added phase records
correct this diagnostic gap; they are not evidence that the original startup failure is
fixed. The next managed attempt must inspect these records if startup stalls again.

Incident `7c979a53-28a6-4fde-86e6-85d9c3322438` subsequently established the same
boundary precisely. Candidate `0e1beba9dfdcfeac07ee5c956af7a5f423703eb4` completed
recovery and remained alive in `slack_connection`, with no failed phase or application
error, until the deployment controller stopped it after its ten-attempt, 27-second probe
window. The restored runtime connected in about 11 seconds and passed the same functional
probe. The candidate changed only peer-return projection, so the retained evidence does
not implicate that behavior; the controller had classified its own short startup deadline
as a candidate failure. Application readiness now has a 90-second deadline while retaining
the exact invocation, runtime SHA, Slack authentication and Codex functional proofs.

```bash
CONCIERGE_STATE_DIR=/root/.local/state/concierge \
  /root/.bun/bin/bun run bot/scripts/deploy-state.ts show --run-id <run-id>

CONCIERGE_STATE_DIR=/root/.local/state/concierge \
  /root/.bun/bin/bun run bot/scripts/deploy-state.ts repair-show --incident-id <incident-id>

journalctl -u concierge-deploy-<run-prefix>.service
journalctl -u concierge-deployment-repair@<incident-id>.service
```

Repair artifacts and Codex JSONL/final messages are under
`/var/lib/slack-concierge-deployment/incidents/<incident-id>/`. A parked incident
is terminal by design; diagnose its recorded reason before creating a new
operator deployment.

## State migration and backups

`bot/scripts/migrate-deployment-repair.ts` checkpoints SQLite, runs integrity
checks, creates a `VACUUM INTO` backup under
`/root/.local/state/concierge/backups/`, applies only additive columns/tables,
and checks integrity and foreign keys again. On migration failure it rolls the
schema transaction back in place, checks the same database inode again, and
retains the untouched backup for operator recovery.

Machine backups remain owned by `/root/workspace/remote-box` and include
`/root`, `/etc`, and `/var/lib`. To restore Concierge state:

```bash
/root/workspace/remote-box/scripts/restic.sh restore latest --target / \
  --include /root/.local/state/concierge/state.db
systemctl restart concierge-bot
```

Restore capture state separately from
`/var/lib/concierge-capture/state.db`, then restart `agent-inbox.service`.

## Runtime dependencies and service shutdown

`concierge-bot.service` runs the stable launcher at
`/usr/local/lib/slack-concierge-deployment/launch`. The launcher executes the
verified artifact selected by `/var/lib/slack-concierge-deployment/current`.
Its pre-start recovery command and the repair unit execute through
`/usr/local/lib/slack-concierge-deployment/control`, which resolves only the
verified immutable control artifact.
The service keeps `KillMode=mixed` and `TimeoutStopSec=5min`: graceful stop signals
only the main process while valid provider children drain; forced kill applies to the
cgroup. The deadline is safe because deployment is the only thing that stops this
service and it restarts only at an idle turn boundary, so a stop that outlives five
minutes is a wedged shutdown, never a running turn. On 2026-09-17 the previous
`infinity` let one wedged stop hold provider admission for 79 minutes.
A graceful stop logs `service_drain_started` before it waits on anything, closes the
owner event streams that Thinkering subscribers hold open, stops the request surfaces,
then waits for active turns. Bun's graceful server stop resolves only after every
in-flight response ends, so a stop that sits in `deactivating` without that log line is
blocked before draining, not waiting on turns. systemd force-kills it at the five-minute
stop deadline and the pending restart proceeds; `systemctl kill --kill-whom=main
--signal=SIGKILL concierge-bot.service` does the same sooner. Until then the held
deployment gate queues every session input as `DEPLOYMENT_HOLD`.

The unit starts the already-installed managed Codex App Server if it is absent,
but ordinary deployment and autonomous repair never update, stop, or restart
that daemon. See [Codex App Server lifecycle](CODEX-APP-SERVER.md).

Capture ingress retains the historical `agent-inbox.service` name and its
separate unprivileged identity. Its security and queue ownership are documented
in [capture ingress](../architecture/CAPTURE-INGRESS.md).
