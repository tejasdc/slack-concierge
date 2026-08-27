# Deployment and autonomous repair

`origin/main` is the desired deployment state. Code moves through GitHub; never
copy or edit project files on the service peer. A signed GitHub `push` webhook
for `tejasdc/slack-concierge` `main` advances one durable desired-state record,
and the event-driven worker creates at most one active deployment run when that
commit differs from the immutable last-known-good release. The detached runner
waits for active provider and capture work, pulls with rebase, installs the
frozen dependency graph, activates an immutable candidate, restarts Concierge,
and proves the exact runtime before success. A terminally failed or parked
desired SHA stays blocked until a later signed push advances the desired state.
Startup resumes already accepted durable work but deliberately does not scan Git
history for pushes received while Concierge was offline.

`bot/scripts/deploy.sh` remains the operator-only forced rollout and recovery
entrypoint. Ordinary agents do not invoke it or register deployment requests.

The repair architecture is documented in
[trusted-root deployment repair](../architecture/DEPLOYMENT-REPAIR.md).

## Normal operation

Ordinary agent work ends at `git push origin main`. No deployment-specific
prompt, command, task enrollment, polling, or success continuation is required.
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
The service keeps `KillMode=mixed` and `TimeoutStopSec=infinity`: graceful stop
signals only the main process while valid provider children drain; forced kill
applies to the cgroup.

The unit starts the already-installed managed Codex App Server if it is absent,
but ordinary deployment and autonomous repair never update, stop, or restart
that daemon. See [Codex App Server lifecycle](CODEX-APP-SERVER.md).

Capture ingress retains the historical `agent-inbox.service` name and its
separate unprivileged identity. Its security and queue ownership are documented
in [capture ingress](../architecture/CAPTURE-INGRESS.md).
