---
failure: A Mac agent could not inspect the already-open thnkr.ing web app for the Canvas report because the guard recognized only an earlier human request.
date: 2026-11-04
fix_commits: []
cause_status: confirmed
---

# Canvas Mac inspection refused before Computer Use

## What was seen

Two Mac requests carried a recorded `mac-app` need naming the installed thnkr.ing Safari web app and page. The Computer Use hook refused direct exact-bundle `getApp` before it could inspect the window. The requests originated in Tejas's November 4 Canvas bug report. No app action occurred from those attempts.

## Cause

The guard recognized the exact app and page only when the request's retained human input matched the earlier November 3 page-recovery instruction. The owner correctly carried the Canvas capture's different originating-human input; the guard had no rule for it.

## Fix

The guard recognizes that one Canvas capture for the exact app and page. It permits direct exact-bundle selection and passive app state or screenshot reads. Each Canvas read selects the exact bundle in the same Computer Use program, avoiding an old REPL handle pointing to another app. The Inspector shortcut remains limited to the earlier authorization.

## Acceptance scenario

- **Seed:** A Mac Codex turn with a recorded `mac-app` need naming the exact bundle and page, and retained human provenance from the November 4 Canvas capture.
- **Action:** Direct Computer Use selects the exact bundle and reads its accessibility state or screenshot.
- **Expected:** The hook permits those calls. It refuses generic Safari, another app, standalone reads through old handles, clicks, reload and Web Inspector for this capture. The Mac agent verifies the actual page after selection without changing it.
- **Replayable offline:** yes (focused Mac surface-policy check); installed Mac and page behavior requires a fresh live call.
