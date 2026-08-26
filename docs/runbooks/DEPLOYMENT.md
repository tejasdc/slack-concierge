# Deployment and autonomous repair

`origin/main` is the desired deployment state. Code moves through GitHub; never
copy or edit project files on the service peer. Concierge refreshes
`origin/main` at most once per minute and creates one durable deployment run
when it differs from the immutable last-known-good release. The detached runner
waits for active provider and capture work, pulls with rebase, installs the
frozen dependency graph, activates an immutable candidate, restarts Concierge,
and proves the exact runtime before success. A terminally failed or parked
desired SHA stays blocked until `origin/main` advances; the periodic reconciler
does not reopen the same bad release.

`bot/scripts/deploy.sh` remains the operator-only forced rollout and recovery
entrypoint. Ordinary agents do not invoke it or register deployment requests.

The repair architecture is documented in
[trusted-root deployment repair](../architecture/DEPLOYMENT-REPAIR.md).

## Normal operation

Ordinary agent work ends at `git push origin main`. No deployment-specific
prompt, command, task enrollment, polling, or success continuation is required.
The next origin reconciliation creates a fixed transient systemd unit. That
runner immediately writes the durable provider-admission gate even when turns
are already running. Existing owners finish normally, later turns remain queued,
and the runner rechecks the local SQLite drain every two seconds until those
owners finish. The recheck exists only while a deployment is waiting, so healthy
idle operation does no additional recurring work. Further commits remain
represented by `origin/main` and are included by the active pull or detected
after the current run reaches a terminal state.

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
currently running turn and its existing token. Zero matches remain a valid
unattributed manual commit; multiple live matches are rejected as ambiguous.
Deployment configures the shared Git repository with the canonical checkout's
absolute tracked hook directory, so every linked worktree runs the same current
hook even when its branch contains an older `.githooks` snapshot. The trailer
proves only which task authored a commit; it does not prove which commit caused
a failed deployment.

Concierge projects deployment state directly onto each attributable turn's
original Slack message. These reactions are durable status, not provider turns:

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
The origin snapshot supplies the initial picked-up set; candidate activation
reconciles any additional commits from the exact immutable candidate.

Deploy closes provider admission before waiting while already-admitted provider
turns or capture deliveries have live owners. It does not time out valid
long-running work, and continuously arriving Slack turns cannot postpone the
deployment because they queue behind the durable gate. The two-second local
recheck is a crash-simple fallback, not an always-on origin poll or a new
scheduler. After the admitted owners drain, deployment records the phase
sequence `prepared → draining → updating → restarting → verifying → releasing`.
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
repair in an incident worktree, obtains a fresh structured review, non-force
pushes only after proving the reviewed `origin/main` base, and retries the same
deployment run. No manual polling is required. A successful retry records its
runtime proof and wakes no feature agent. The third identical candidate-health
failure or fourth review rejection parks the incident.

The transient deployment unit restarts on runner failure. The durable run is
also requeued when its exact process identity dies. If death happened after the
activation-intent checkpoint, immutable startup recovery restores LKG before
Concierge starts and creates the repair incident on that same run. The repair
path does not install Codex and does not restart the shared managed Codex App
Server.

Terminal diagnostics lead with the deployment outcome and a plain-language
reason for the failed operation. No deployment outcome starts a feature-agent
turn. Shell exit status, failed command, source line, and internal stage remain
structured `deployment_run_events.detail_json` diagnostics. The durable run ID
and systemd unit suffix identify the complete evidence in SQLite and journald.

## Inspect a run or repair

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

## One-time cutover to immutable repair

This is an explicit maintenance operation because it restarts Concierge once.
It does not restart the shared Codex App Server. Do not run it while agents are
active, and do not substitute a normal deploy for this first transition.

The currently proven runtime is `f2b055013829f28fb77a90a477749a4761b5c89b`.
After this change is reviewed and integrated into `origin/main`, leave the
canonical checkout on that healthy commit, fetch the new source without pulling,
and execute the cutover from a temporary archive:

```bash
cd /root/workspace/slack-concierge
git fetch origin main
control_commit=$(git rev-parse origin/main)
cutover_source=$(mktemp -d)
git archive origin/main | tar -x -C "$cutover_source"
CONCIERGE_DEPLOYMENT_SOURCE_ROOT="$cutover_source" \
CONCIERGE_EXPECTED_LKG_COMMIT=f2b055013829f28fb77a90a477749a4761b5c89b \
CONCIERGE_CONTROL_COMMIT="$control_commit" \
  "$cutover_source/bot/scripts/deployment-repair-cutover.sh"
```

The cutover:

1. proves the live runtime SHA, capture health, Concierge health, and exact
   managed App Server process identity;
2. makes a consistent SQLite backup and applies the additive repair schema in
   one transaction without replacing the live database inode;
3. builds one immutable bootstrap artifact from the current healthy application
   commit plus the reviewed control commit, records both provenances, activates
   it, restarts, and re-proves the unchanged healthy application through the new
   launcher;
4. selects its immutable control commands for the new unit, then promotes it as
   the initial last-known-good release only after proof;
5. completes the durable cutover run and releases both admission gates; and
6. stops and moves the retired deployment services and generated runtime trees
   into a dated recoverable backup under
   `/var/backups/slack-concierge-deployment-cutover/`.

If activation or proof fails, the script restores the previous bot unit,
restarts and re-proves the healthy runtime, releases the gates, and leaves the
canonical checkout unchanged. After a successful cutover, immediately advance
the canonical checkout and perform the first normal deployment:

```bash
git pull --rebase origin main
bot/scripts/deploy.sh
```

Remove the temporary archive only after normal deployment succeeds.

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
The service keeps `KillMode=mixed` and `TimeoutStopSec=infinity`: graceful stop
signals only the main process while valid provider children drain; forced kill
applies to the cgroup.

The unit starts the already-installed managed Codex App Server if it is absent,
but ordinary deployment and autonomous repair never update, stop, or restart
that daemon. See [Codex App Server lifecycle](CODEX-APP-SERVER.md).

Capture ingress retains the historical `agent-inbox.service` name and its
separate unprivileged identity. Its security and queue ownership are documented
in [capture ingress](../architecture/CAPTURE-INGRESS.md).
