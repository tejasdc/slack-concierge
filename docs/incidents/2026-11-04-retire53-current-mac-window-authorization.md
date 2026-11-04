---
failure: Tejas's current-window retirement inspection was refused because the exact-app guard still required the vanished old recovery page ID.
date: 2026-11-04
fix_commits: []
cause_status: confirmed
---

# Current-window exact53 inspection inherited the old-page requirement

## What was seen

Tejas's new human capture `capture:2a296c24ca627e68981feab3c3e56a32b3e43cf317d0eb545ee4cab23801270b`
says he replaced the missing notes, cancels recovery, and asks to retire the 53-edit notice
while making saving work. Mac session `mac:274` received work request
`79cb927f-eae4-4131-80e8-aee4da985d32`. Its recorded `mac-app` need names the exact
thnkr.ing Safari web-app bundle, current window, normal File menu, and `exact53 retirement`.
The direct exact-bundle `cua.getApp` call was refused by PreToolUse before Computer Use ran.
The recorded need lacks the old page ID because that page was not found in the current window.

## Cause

The guard's earlier recovery grant required the old page ID for every thnkr.ing web-app
Computer Use call. That was appropriate for old-page recovery but contradicted this new
current-window request.

## Fix

The repair retains the earlier old-page grant and adds a distinct
grant bound to this human capture, work effect, exact bundle, and recorded retirement purpose.
It admits direct app selection and a passive read that selects the exact bundle again in the
same Computer Use program. It refuses another app, whole-screen read, a stale REPL handle,
menu input, Inspector, reload, and page mutation. The Mac agent first needs the admitted
selection to read the returned Computer Use API and current accessibility tree. Neither a
named File-menu action nor a same-app second-window path has been verified; those require
separate target-bound evidence before admission. The Thinkering exact53 consumer is being
prepared by the saving owner and is not part of this policy repair.

## Acceptance scenario

- **Seed:** Record a `mac-app` work need from Tejas's retirement capture naming the exact
  thnkr.ing web-app bundle and `exact53 retirement`, without the old page ID.
- **Action:** Call direct exact-bundle `cua.getApp`, then select that bundle afresh for a
  same-program passive accessibility read.
- **Expected:** Both calls are admitted. Informational scope, another human input, wrong
  bundle, whole-screen, menu, reload, Inspector, and other app calls remain refused.
- **Replayable offline:** yes, using `bot/scripts/mac-surface-policy-check.ts`. Physical Mac
  acceptance also requires an installed-hook retry after the ordinary release.
