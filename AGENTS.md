
## Slack app scopes

**Every change to OAuth scopes MUST go through the manifest file (`slack-app-manifest.json`), never via the Slack UI directly.** Any scope added by hand in the App Config UI creates drift between what the running install has and what the repo declares — a subsequent Reinstall on the (stale) manifest silently strips the manual scope, and features that depended on it break with no obvious trace. Manifest-first keeps the repo as the source of truth and makes scope changes reviewable in git.

- To add or remove a scope: edit `slack-app-manifest.json`, commit, upload the file at https://api.slack.com/apps/A0BNG0WHUNQ/app-manifest, click Reinstall, grab the new tokens on the OAuth & Permissions page and update `/root/.config/concierge/slack.toml` on AX41.
- After every reinstall verify with the `X-OAuth-Scopes` header (via `auth.test`) — the granted set must exactly match `slack-app-manifest.json`. If it drifts, fix the manifest first, then reinstall.
- Never edit scopes in the UI as a shortcut, even for a "small" one-liner — the drift compounds.

## Deploy

Multi-peer checkout. See global `~/.codex/AGENTS.md` "Distribution discipline" for invariants. Service peer deploys via `bot/scripts/deploy.sh` (pull + restart, refuses on conflict). Deploy installs/refreshes the primary bot unit from `systemd/`; backup infrastructure remains owned by the machine-level `remote-box` project.

Deploys are drain-aware. `bot/scripts/deploy.sh` asks the runtime-owned
`drain-status.ts` interface whether provider turns have live owners before it
pulls or restarts anything. It waits 20 minutes between checks for genuinely
live work, with no maximum age: a long-running healthy agent is never killed
just to ship a deploy. A deployment proceeds past blocking rows only when
process-instance ownership proves that every owner is stale; startup recovery
then reconciles those rows. An indeterminate liveness result fails closed.

When a deploy is requested by an agent running under `concierge-bot.service`,
the script hands the job to a transient systemd unit. Backgrounding inside the
bot service is not sufficient because systemd kills the whole service cgroup
on restart. The transient unit owns the wait, pull, and restart independently.

The primary `concierge-bot.service` unit is versioned at
`systemd/concierge-bot.service`; never edit `/etc/systemd/system` directly.
After restart, deploy requires an active service with a nonzero MainPID and a
successful Slack `auth.test` via `bot/scripts/healthcheck.ts`. A merely
"active" systemd process is not considered a successful deployment; the new
systemd invocation must also log `concierge_bot_online`.

The database-backed admission gate is introduced by the same release as the
first drain-aware deploy, so that release uses the guarded bootstrap script.
Fetch the script without changing the checkout, then execute it:

```bash
git fetch origin
git show origin/main:bot/scripts/bootstrap-deploy.sh > /tmp/concierge-bootstrap-deploy.sh
chmod +x /tmp/concierge-bootstrap-deploy.sh
/tmp/concierge-bootstrap-deploy.sh
```

It inspects the legacy service cgroup every 20 minutes. Once empty, it freezes
the complete cgroup and inspects it again, closing the race where the old bot
could accept work between inspection and stop. It then stops the frozen service
and creates a one-time, mode-600 bootstrap token. The new deploy independently
requires both an inactive service and that exact token before bypassing its
normal database gate. It then pulls and starts the drain-aware release. A pull
failure leaves the legacy service stopped. If invoked by Concierge itself, it first moves into a
transient systemd unit so stopping the bot cannot kill the bootstrap. This path
is only for the first rollout; every later deploy uses the atomic database gate.

The primary unit uses `KillMode=mixed`: graceful stop sends SIGTERM only to the
bot's main process, allowing it to wait for provider children, while a later
forced SIGKILL applies to the complete cgroup. `TimeoutStopSec=infinity` means
systemd never escalates merely because legitimate agent work is long-running;
an operator can still explicitly force-kill the unit when investigation proves
the work is irrecoverably stuck.

## Backups

Backups are a machine-level concern — see the `remote-box` repo (`/root/workspace/remote-box`), which runs a nightly restic snapshot of the whole box to a Hetzner Storage Box. It covers `/root/workspace`, `/etc/concierge`, `/root/.local/state/concierge` (state.db + WAL), and all the config we'd need to rebuild. slack-concierge itself owns no backup scripts.

Restore state.db from restic: `/root/workspace/remote-box/scripts/restic.sh restore latest --target / --include /root/.local/state/concierge/state.db` then `systemctl restart concierge-bot`.
