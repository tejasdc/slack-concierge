---
failure: The Mac agent could not read the updated Thinkering WebApp after the guarded update completed.
date: 2026-11-07
fix_commits: []
cause_status: confirmed
---

# Post-update Mac observation was refused

## What was seen

The original-source Mac session completed one Workspace press and one Update now
press. Server diagnostics recorded the new page becoming ready. A later Mac work
request reported that its Computer Use program was refused by PreToolUse, and an
AppleScript query was also refused. The installed Swift helper had only press
actions, so it could not make the read-only observation. No further press was made.

## Cause

The fixed native helper had no passive mode. The Computer Use guard already
allowed one exact-bundle read program, but the attempted program did not pass;
the retained Mac transcript does not include its exact code argument, so that
specific mismatch is unknown. The absence of a native read mode is confirmed.

## Fix

The pinned helper now has an `observe` mode. It checks the exact installed app,
one window, one HTTPS thnkr.ing WebArea and a stable URL, then returns only the
current URL and counts of named accessibility controls. It does not press,
reload, write a marker or return private text. The Mac guard admits only the
fixed command under the original source-attested work grant and a Mac need
explicitly naming passive observation and the exact bundle.

## Acceptance scenario

- **Seed:** The updated Thinkering WebApp is open on any thnkr.ing route; the
  two update press markers may already exist.
- **Action:** Invoke the pinned helper once with `observe` from a fresh
  original-source Mac work request.
- **Expected:** The helper reports the current URL and Canvas, Journal and Deep
  work control counts without an app action. A wrong app, extra window, changed
  document, or untrusted origin refuses. The press modes remain one-shot.
- **Replayable offline:** Policy admission is replayable offline; Mac AX output
  requires the real app.
