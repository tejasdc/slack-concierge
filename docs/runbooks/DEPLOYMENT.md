# Deployment and service operations

## Normal deploy

This repository is one peer in a Git-distributed codebase. Propagate code through origin and deploy with `bot/scripts/deploy.sh`; never edit installed units or project files directly on the service peer. The deploy script pulls, refuses conflicts, installs repository-owned units, and restarts only after drain safety is established.

Deploy asks `bot/scripts/drain-status.ts` whether provider turns have live owners. It waits 20 minutes between checks while work is live, with no maximum age. It proceeds past blocking rows only after process identity proves every owner stale. Indeterminate liveness fails closed. If invoked inside `concierge-bot.service`, deploy hands itself to a transient systemd unit so restarting the service cannot kill the deployment.

After restart, deploy requires an active service, nonzero `MainPID`, successful Slack `auth.test`, and a `concierge_bot_online` marker from the current systemd invocation. Capture ingress must also pass its local HTTP probe before the Slack bot restarts. `bot/tests/deploy.test.ts` is the focused authority.

## One-time managed-project scaffold cutover

The canonical instruction-source migration is not a normal deploy and must not run from an isolated feature worktree. After its implementation branch is reviewed, committed, pushed, and integrated into `main`, follow [channel adoption and scaffold migration](CHANNEL-ADOPTION.md): run the dry inventory, review its exact exception set, then invoke `bot/scripts/project-scaffold-cutover.sh` once.

The cutover wrapper deliberately reuses this runbook's provider deployment gate, capture hold, service stop, deployment, and health probe. Its durable cutover state blocks startup through early/mid failure, resumes incomplete Git propagation, and forces an all-Slack-visible-channel Canvas refresh before startup publishes `concierge_bot_online`. Do not reproduce those steps manually or add a second admission mechanism. Recovery commands and phase distinctions are in the channel-adoption runbook.

## First drain-aware rollout

The first upgrade from a service without the database admission gate uses the guarded bootstrap once:

```bash
git fetch origin
git show origin/main:bot/scripts/bootstrap-deploy.sh > /tmp/concierge-bootstrap-deploy.sh
chmod +x /tmp/concierge-bootstrap-deploy.sh
/tmp/concierge-bootstrap-deploy.sh
```

The bootstrap waits until the legacy service cgroup is empty, freezes and reinspects the complete cgroup, stops the service, and creates a one-time mode-600 token. The new deploy requires that exact token and an inactive service before bypassing the normal database gate. If pulling fails, the legacy service remains stopped rather than reopening unsafe admission.

Capture acquires its own deployment gate before the bot gate and changes it to a durable hold before Concierge becomes unavailable. The hold is released only after capture ingress and the new bot pass functional health. See [capture ingress architecture](../architecture/CAPTURE-INGRESS.md).

## Shutdown and runtime dependencies

`concierge-bot.service` uses `KillMode=mixed`: graceful stop sends `SIGTERM` only to the main process so it can wait for provider children, while forced `SIGKILL` applies to the cgroup. `TimeoutStopSec=infinity` prevents escalation merely because valid provider work is long-running.

`agent-inbox.service` retains its historical name for `/audio` compatibility. Its security and shutdown contract is documented in [capture ingress architecture](../architecture/CAPTURE-INGRESS.md). Repository Monologue and journalmaxx units are stubs; Concierge deploy does not replace the separately installed AX41 Monologue poller.

Slack audio fallback uses the pinned local `whisper.cpp` runtime. `bot/scripts/install-transcriber.sh` installs dependencies, builds for the host CPU, and downloads the `base.en` model. Deploy runs it idempotently. Do not use the upstream container on AX41 because its binary requires AMX.

## Backups and restore boundary

Concierge owns no backup scripts. The machine-level `/root/workspace/remote-box` project snapshots `/root`, `/etc`, and `/var/lib`, including bot state, the capture queue, and `/etc/concierge`.

Restore bot state, then restart:

```bash
/root/workspace/remote-box/scripts/restic.sh restore latest --target / --include /root/.local/state/concierge/state.db
systemctl restart concierge-bot
```

Restore capture state, then restart ingress:

```bash
/root/workspace/remote-box/scripts/restic.sh restore latest --target / --include /var/lib/concierge-capture/state.db
systemctl restart agent-inbox.service
```
