
## Slack app scopes

**Every change to OAuth scopes MUST go through the manifest file (`slack-app-manifest.json`), never via the Slack UI directly.** Any scope added by hand in the App Config UI creates drift between what the running install has and what the repo declares — a subsequent Reinstall on the (stale) manifest silently strips the manual scope, and features that depended on it break with no obvious trace. Manifest-first keeps the repo as the source of truth and makes scope changes reviewable in git.

- To add or remove a scope: edit `slack-app-manifest.json`, commit, upload the file at https://api.slack.com/apps/A0BNG0WHUNQ/app-manifest, click Reinstall, grab the new tokens on the OAuth & Permissions page and update `/root/.config/concierge/slack.toml` on AX41.
- After every reinstall verify with the `X-OAuth-Scopes` header (via `auth.test`) — the granted set must exactly match `slack-app-manifest.json`. If it drifts, fix the manifest first, then reinstall.
- Never edit scopes in the UI as a shortcut, even for a "small" one-liner — the drift compounds.

## Deploy discipline — no scp, ever

**Deploy is `git push` → `git pull` on AX41 → `systemctl restart concierge-bot`. That is the ONLY path. Never `scp`, never `rsync`, never write files directly to `/root/workspace/slack-concierge/` on AX41 through any channel other than a `git pull`.**

Why: scp puts files on the remote box that aren't in any git history. The running bot loads whatever's on disk, so it looks like it works — but AX41's git shows "modified" files it never committed, Mac's git has commits AX41 never pulled, and the two histories drift silently. The 2026-08-07 session ended with 11 unpushed Mac commits, 4 orphan AX41 commits, and dozens of "modified" files that were content-identical to Mac's commits but recorded nowhere on AX41. That is the exact class of bullshit this rule exists to prevent.

The right shape:
1. Edit locally, `git commit`
2. `git push origin main`
3. On AX41: `git pull --rebase origin main`
4. `systemctl restart concierge-bot`

If step 3 fails (merge conflict, unclean tree), STOP. Do not resolve by scp'ing anything. Diagnose, fix in git, re-pull. A merge conflict is information about drift — silence it and the drift compounds. There is a `bot/scripts/deploy.sh` that runs steps 3 + 4 on AX41; use it or invoke the two commands directly.

Anti-patterns that violate this rule (all of them shipped-and-regretted today):
- "I'll just scp this one file for a quick fix"
- "The bot needs to restart with this change RIGHT NOW, git roundtrip is too slow"
- "I'll commit locally and figure out the push later"

None of these are acceptable. There is no urgency that justifies scp'ing to production. If the git roundtrip is too slow for the iteration you need, the answer is to make git faster, not to bypass it.
