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

## Cause

The retirement guard admitted only the earlier human capture
`capture:2a296c24ca627e68981feab3c3e56a32b3e43cf317d0eb545ee4cab23801270b`.
The new work request correctly carried Tejas's later unlock reply as its
originating human input.

## Fix

The guard now recognizes that one reply as a
continuation of the same scoped retirement work. Its work effect, exact app,
retirement purpose, and fixed guarded menu programs remain required. The reply
does not gain the old-page recovery grant.

## Acceptance scenario

- **Seed:** Record a `mac-app` work need from the unlock human input naming the
  exact web-app bundle, File menu, New Window, and exact53 retirement.
- **Action:** Call direct exact-bundle `cua.getApp`, the same-program passive
  read, and the two fixed guarded menu programs.
- **Expected:** Those calls are admitted. Another human input, informational
  effect, wrong app, whole-screen read, and arbitrary click remain refused.
- **Replayable offline:** yes, `bot/scripts/mac-surface-policy-check.ts`.
  Installed-hook and physical-window verification are separate checks.
