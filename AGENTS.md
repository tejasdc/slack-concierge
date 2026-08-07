
## Slack app scopes

**Every change to OAuth scopes MUST go through the manifest file (`slack-app-manifest.json`), never via the Slack UI directly.** Any scope added by hand in the App Config UI creates drift between what the running install has and what the repo declares — a subsequent Reinstall on the (stale) manifest silently strips the manual scope, and features that depended on it break with no obvious trace. Manifest-first keeps the repo as the source of truth and makes scope changes reviewable in git.

- To add or remove a scope: edit `slack-app-manifest.json`, commit, upload the file at https://api.slack.com/apps/A0BNG0WHUNQ/app-manifest, click Reinstall, grab the new tokens on the OAuth & Permissions page and update `/root/.config/concierge/slack.toml` on AX41.
- After every reinstall verify with the `X-OAuth-Scopes` header (via `auth.test`) — the granted set must exactly match `slack-app-manifest.json`. If it drifts, fix the manifest first, then reinstall.
- Never edit scopes in the UI as a shortcut, even for a "small" one-liner — the drift compounds.

## Deploy

Multi-peer checkout. See global `~/.codex/AGENTS.md` "Distribution discipline" for invariants. Service peer deploys via `bot/scripts/deploy.sh` (pull + restart, refuses on conflict). Deploy also installs/refreshes the systemd units under `systemd/` (bot service, backup timers, poller) so infra ships with code.

## Backups

Service peer runs two systemd timers (auto-installed by `deploy.sh`):
- `concierge-backup-state.timer` — hourly `sqlite .backup` of `state.db` → `/var/backups/concierge/state/{hourly,daily,weekly}/`. Retention 24h + 14d + 8w.
- `concierge-backup-config.timer` — daily tarball of `/root/.config/concierge`, `/root/.local/state/concierge`, `/root/.local/bin`, `/etc/concierge`, and all concierge systemd units → `/var/backups/concierge/config/{daily,weekly}/`. Retention 14d + 8w.

Off-box push: if `/etc/concierge/backup-target.conf` sets `RSYNC_TARGET=user@host:/path`, both scripts rsync to it after each run. Target: Hetzner Storage Box (Helsinki, BX11), SSH-key auth via `/root/.ssh/storagebox_ed25519`. Storage Box has 10 daily Hetzner-managed snapshots on top.

Restore state.db: `systemctl stop concierge-bot && gunzip -c /var/backups/concierge/state/hourly/<snapshot>.db.gz > /root/.local/state/concierge/state.db && rm -f /root/.local/state/concierge/state.db-{wal,shm} && systemctl start concierge-bot`.

Docs discipline: any change to backup cadence, retention, target, or restore path updates this section in the same commit as the code change. Same rule for every subsystem — infra without an AGENTS.md pointer is invisible to the next agent.
