
## Slack app scopes

**Every change to OAuth scopes MUST go through the manifest file (`slack-app-manifest.json`), never via the Slack UI directly.** Any scope added by hand in the App Config UI creates drift between what the running install has and what the repo declares — a subsequent Reinstall on the (stale) manifest silently strips the manual scope, and features that depended on it break with no obvious trace. Manifest-first keeps the repo as the source of truth and makes scope changes reviewable in git.

- To add or remove a scope: edit `slack-app-manifest.json`, commit, upload the file at https://api.slack.com/apps/A0BNG0WHUNQ/app-manifest, click Reinstall, grab the new tokens on the OAuth & Permissions page and update `/root/.config/concierge/slack.toml` on AX41.
- After every reinstall verify with the `X-OAuth-Scopes` header (via `auth.test`) — the granted set must exactly match `slack-app-manifest.json`. If it drifts, fix the manifest first, then reinstall.
- Never edit scopes in the UI as a shortcut, even for a "small" one-liner — the drift compounds.

## Deploy

Multi-peer checkout. See global `~/.codex/AGENTS.md` "Distribution discipline" for invariants. Service peer deploys via `bot/scripts/deploy.sh` (pull + restart, refuses on conflict).
