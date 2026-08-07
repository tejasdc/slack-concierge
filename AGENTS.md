
## Slack app scopes

**Every change to OAuth scopes MUST go through the manifest file (`slack-app-manifest.json`), never via the Slack UI directly.** Any scope added by hand in the App Config UI creates drift between what the running install has and what the repo declares — a subsequent Reinstall on the (stale) manifest silently strips the manual scope, and features that depended on it break with no obvious trace. Manifest-first keeps the repo as the source of truth and makes scope changes reviewable in git.

- To add or remove a scope: edit `slack-app-manifest.json`, commit, upload the file at https://api.slack.com/apps/A0BNG0WHUNQ/app-manifest, click Reinstall, grab the new tokens on the OAuth & Permissions page and update `/root/.config/concierge/slack.toml` on AX41.
- After every reinstall verify with the `X-OAuth-Scopes` header (via `auth.test`) — the granted set must exactly match `slack-app-manifest.json`. If it drifts, fix the manifest first, then reinstall.
- Never edit scopes in the UI as a shortcut, even for a "small" one-liner — the drift compounds.

## Deploy discipline

**This repo is checked out on multiple peers. Every peer that edits code is a peer, not a "primary" or "canonical" — the GitHub origin is the meeting point.** The peer that runs the concierge-bot service loads whatever's on its own disk, so getting new code onto it means one and only one path: `git pull → systemctl restart concierge-bot`. Never scp, never rsync, never edit files directly on the service peer via SSH.

Every peer, every commit:
1. `git fetch origin && git rebase origin/main` before making local commits — you may not be the only editor
2. Edit, commit
3. `git push origin main`

On the peer that runs the service (whichever machine that is — could be any peer):
```
bot/scripts/deploy.sh
```
That runs `git pull --rebase origin main && systemctl restart concierge-bot` and refuses to proceed on a merge conflict. Fix the conflict in git before deploying — do not resolve by writing files directly on the peer.

Failure modes this rule exists to prevent (all seen 2026-08-07 in one session):
- 11 orphan commits on one peer that never got pushed to origin
- 4 orphan commits on another peer that never got pulled by the first
- Dozens of "modified" files on the service peer that were content-identical to origin's HEAD but recorded nowhere in the service peer's git history — because someone scp'd them there in the name of speed
- A committing-agent that never once ran `git fetch` before commit, blind to whatever else had landed on origin

See the global `~/.codex/AGENTS.md` section on **Distribution discipline / Codebases** for the underlying invariants — same story project-wide.
