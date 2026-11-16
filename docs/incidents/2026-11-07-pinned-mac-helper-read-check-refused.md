---
failure: Read-only checks of the installed Mac update helper were refused before execution.
date: 2026-11-07
fix_commits: []
cause_status: confirmed
---

# Installed Mac helper could not be verified

## What was seen

After the navigation-safe update controller was installed, two turns in the
existing Mac agent session and one fresh Mac session tried to hash or typecheck
the coordinator-pinned Swift helper. PreToolUse refused each command before it
ran. The old session retained an obsolete helper-directory environment variable;
the fresh session had none. No WebApp or helper action occurred.

## Cause

The Mac guard recognized read-only hash, mode and typecheck commands only when
they used the helper-directory environment variable. It treated the quoted
absolute path in the running coordinator's revision-named pinned helper
directory as an unauthorized helper command, even for those same read-only
operations.

## Fix

The guard admits only the three named read-only commands with a quoted absolute
path in the standard revision-named pinned helper directory. Fixed app-action
commands still require the current source-attested owner grant. Chained commands,
other paths and direct execution still refuse.

## Acceptance scenario

- **Seed:** A Mac coordinator pins a new helper revision while a persistent
  provider session retains an older helper environment, or a new session has none.
- **Action:** Run one hash, mode or Swift typecheck command against the quoted
  absolute pinned helper path.
- **Expected:** The read-only command passes PreToolUse; an attempted helper
  execution or chained app action still refuses without the exact owner grant.
- **Replayable offline:** yes
