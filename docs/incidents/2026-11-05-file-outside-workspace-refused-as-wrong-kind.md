---
failure: A Markdown file outside the workspace folder was refused as an unreadable kind instead of for being outside the workspace.
date: 2026-11-05
fix_commits: []
cause_status: confirmed
---

# Opening a Markdown file outside the workspace blamed the file type

## What was seen

Reading `/etc/hosts.md` through the app's file door answered `415 FILE_TYPE_UNSUPPORTED`,
"That kind of file cannot be opened here." It is a Markdown file; the real reason it cannot
be opened is that it sits outside the workspace root, which has its own refusal
(`403 FILE_OUTSIDE_WORKSPACE`, "Only files under /root/workspace can be opened here"). The
file window renders the refusal it is given, so Tejas would have been told the wrong reason
and would have no way to learn the real one.

Observed 2026-11-05 through the installed app's agent door on the canonical capability socket,
build `ec1087aea`, while checking the installed Markdown reader.

## Cause

`readWorkspaceFile` classified the file before checking where it is. The classification asks
`isSensitiveWorkspacePath(relative(workspaceRoot, path))`, a rule written for paths inside the
root: it refuses any segment beginning with a dot so that `.env` and `.git/` stay unreadable.
For a path outside the root, `relative()` returns `../../etc/hosts.md`, and its `..` segments
begin with a dot, so every outside path was classified sensitive and fell out as an
unsupported kind before the containment check could name the real reason.

## Fix

Resolve the workspace root and check containment first, then classify. The sensitive-name rule
now only ever receives a genuine in-root relative path, which is what it was written for.
No path became readable: the outside path is still refused, one step earlier and by the rule
that actually applies.

## Acceptance scenario

- **Seed:** A Markdown file outside the workspace root, for example `/etc/hosts.md`, and a
  workspace root of `/root/workspace`.
- **Action:** Read it through `GET /sessions/v1/files?path=/etc/hosts.md&machine=cloud`.
- **Expected:** `403 FILE_OUTSIDE_WORKSPACE` naming the root, not `415 FILE_TYPE_UNSUPPORTED`.
  `.env` and `.git/config.md` inside the root still answer `415`, and ordinary Markdown and
  source files inside it still open.
- **Replayable offline:** yes
