---
failure: An exact Claude review resume inherited an expired login instead of the original transcript account.
date: 2026-11-13
fix_commits: []
cause_status: confirmed
---

# Exact Claude resume used the ambient login

## What was seen

A November 13 review transcript records its original account and organization in Claude's
session-owner rows. An exact resume inherited a different, expired ambient login. The ongoing
review is retained and must not be replayed to prove a fix.

## Cause

The agent-shell launcher verified the account for fresh Claude commands but exempted all
resume commands. Shared transcript history did not establish which login Claude would use.

## Fix

Resolve an unpinned exact UUID resume from the transcript's consistent original identity to
one local home whose recorded identity and Claude authentication status agree. Refuse an
unavailable or ambiguous binding before sending the prompt. Continue, forks without an exact
resume, explicit pins and Claude's own subagents retain their existing behavior.

## Acceptance scenario

- **Seed:** A fresh verified account writes a transcript; the ambient login is unusable.
- **Action:** Resume that exact UUID through the agent-shell launcher.
- **Expected:** Claude receives the unchanged resume under the original working home; missing,
  conflicting or unavailable identity refuses before a model request.
- **Replayable offline:** yes (isolated launcher and fake Claude/owner; live authentication is separate).
