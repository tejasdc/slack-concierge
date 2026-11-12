---
failure: The Mac agent could not verify the installed Focus helper because a read-only hash was classified as an app action.
date: 2026-11-12
fix_commits: []
cause_status: confirmed
---

# Mac Focus helper verification was refused

## What was seen

After the normal Mac updater installed the release and Concierge ran from its
matching pinned directory, the Mac agent attempted `shasum -a 256` on the pinned
Focus helper. The PreToolUse guard refused it with the Start/End authorization
message. No helper action or app interaction ran, and the installed hash and mode
remained unverified.

## Cause

The Focus helper policy recognized the helper's filename before the general
read-only command policy, then allowed only the three fixed action commands.
The older update helper had an exact read-only hash and mode exception; the
new Focus helper did not.

## Fix

Admit only exact SHA-256 and executable-mode reads of the Focus helper in its
installed pinned directory or the pinned helper environment path. Keep Start,
verify-start and End behind the existing source-bound work grant. The Mac agent
must rerun the installed-byte check after this policy reaches its Mac release.

## Acceptance scenario

- **Seed:** A Mac-file request names the installed pinned Focus helper.
- **Action:** Run exact `shasum -a 256` and `stat -f %Sp` reads on that path.
- **Expected:** Both reads pass, while executing the helper or app actions from
  the Mac-file request remain refused.
- **Replayable offline:** yes (the guard's exact command policy is deterministic).
