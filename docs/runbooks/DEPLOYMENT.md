# Deployment and autonomous repair

`bot/scripts/deploy.sh` is the only normal deployment entrypoint. Code moves
through GitHub; never copy or edit project files on the service peer. The script
verifies origin before closing admission, coalesces agent requests into one
durable run, waits for active provider and capture work, pulls with rebase,
installs the frozen dependency graph, activates an immutable candidate, restarts
Concierge, and proves the exact runtime before success.

The repair architecture is documented in
[trusted-root deployment repair](../architecture/DEPLOYMENT-REPAIR.md).

## Normal operation

From an agent turn, invoking the deploy script persists the requested commit and
exact provider-session/Slack-thread continuation, then hands the work to one
fixed transient systemd unit. Concurrent requests join the active run. From an
operator shell, the same script creates a durable operator run and executes it
synchronously.

```bash
cd /root/workspace/slack-concierge
bot/scripts/deploy.sh
```

Git authentication comes from the root account's existing `gh` credential
helper. Callers do not inject or copy tokens. Origin is tested before either
admission gate is claimed.

Deploy waits while provider turns or capture deliveries have live owners. It
does not time out valid long-running work. After admission closes, it records
the phase sequence `prepared → draining → updating → restarting → verifying →
releasing`. Success additionally requires:

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

If a durable rollout step, candidate restart, or functional health proof fails,
deploy automatically switches
to the recorded last-known-good artifact, restarts Concierge, and re-proves both
capture and application health before reopening admission. It then records one
incident on the same active deployment run and starts:

```text
concierge-deployment-repair@<incident-id>.service
```

That service runs Codex as root with the normal `/root` home and full host
access. It diagnoses the host, commits the smallest repair in an incident
worktree, obtains a fresh structured review, non-force pushes only after proving
the reviewed `origin/main` base, and retries the same deployment run. No manual
polling is required. A successful retry produces the original exact-session
verification wakes. The third identical candidate-health failure or fourth
review rejection parks and sends one durable failure notice.

The transient deployment unit restarts on runner failure. The durable run is
also requeued when its exact process identity dies. If death happened after the
activation-intent checkpoint, immutable startup recovery restores LKG before
Concierge starts and creates the repair incident on that same run. The repair
path does not install Codex and does not restart the shared managed Codex App
Server.

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
cutover_source=$(mktemp -d)
git archive origin/main | tar -x -C "$cutover_source"
CONCIERGE_DEPLOYMENT_SOURCE_ROOT="$cutover_source" \
CONCIERGE_EXPECTED_LKG_COMMIT=f2b055013829f28fb77a90a477749a4761b5c89b \
  "$cutover_source/bot/scripts/deployment-repair-cutover.sh"
```

The cutover:

1. proves the live runtime SHA, capture health, Concierge health, and exact
   managed App Server process identity;
2. makes a consistent SQLite backup and applies the additive repair schema in
   one transaction without replacing the live database inode;
3. builds, hashes, activates, restarts, and re-proves the current healthy commit
   through the new immutable launcher;
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
