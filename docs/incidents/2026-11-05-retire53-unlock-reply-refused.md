---
failure: A Mac unlock follow-up for exact53 retirement was refused by the app guard because it carried the new human reply ID.
date: 2026-11-05
fix_commits: []
cause_status: confirmed
---

# Retirement continuation carried Tejas's unlock reply

## What was seen

After the exact53 consumer and account fact were live, Tejas sent human input
`1ba89166-c732-481b-b53a-e77e85ba93ba` saying his Mac was unlocked. The
retirement agent sent Mac work request `da900172-8908-4651-86c4-c477072bef3d`
with the exact thnkr.ing bundle, File menu, New Window, and exact53 retirement
need. The console was unlocked, but PreToolUse refused direct `cua.getApp`
before Computer Use ran.

Tejas later reported unlocking again through
human input `a806ad0a-a0d8-4f72-b603-b245c95de638`. Mac request
`26c29754-1461-4761-8e75-016a7c486144` carried the same exact-app
retirement need; PreToolUse again refused direct `cua.getApp` before Computer
Use. The Mac reported the console unlocked, and no File menu or New Window
action ran.

## Cause

The retirement guard initially admitted only the earlier human capture
`capture:2a296c24ca627e68981feab3c3e56a32b3e43cf317d0eb545ee4cab23801270b`.
The first repair admitted the first unlock reply, while the next work request
correctly carried the second unlock reply as its originating human input.

## Fix

The guard now recognizes both exact reply IDs as
continuation of the same scoped retirement work. Its work effect, exact app,
retirement purpose, and fixed guarded menu programs remain required. The reply
does not gain the old-page recovery grant.

## Acceptance scenario

- **Seed:** Record a `mac-app` work need from either unlock human input naming the
  exact web-app bundle, File menu, New Window, and exact53 retirement.
- **Action:** Call direct exact-bundle `cua.getApp`, the same-program passive
  read, and the two fixed guarded menu programs.
- **Expected:** Those calls are admitted. Another human input, informational
  effect, wrong app, whole-screen read, and arbitrary click remain refused.
- **Replayable offline:** yes, `bot/scripts/mac-surface-policy-check.ts`.
  Installed-hook and physical-window verification are separate checks.
