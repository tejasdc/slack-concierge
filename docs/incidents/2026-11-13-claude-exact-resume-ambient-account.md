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
The first repair also missed Claude's attached `-r<uuid>` spelling and read every line of a
transcript, even though later owner rows can reflect later logins and transcripts can be hundreds
of megabytes. Independent review found both gaps before release.

## Fix

Resolve an unpinned exact UUID resume from the transcript's first owner header to
one local home whose recorded identity and Claude authentication status agree. Refuse an
unavailable or ambiguous binding before sending the prompt. The first newline-terminated header
must fit within 64 KiB and contain the expected identity; missing, incomplete or malformed
headers refuse. Later rows do not redefine the original account. Continue, forks without an exact
resume, explicit pins and Claude's own subagents retain their existing behavior.

## Acceptance scenario

- **Seed:** A fresh verified account writes a transcript; the ambient login is unusable.
- **Action:** Resume that exact UUID through the agent-shell launcher.
- **Expected:** Claude receives the unchanged resume under the original working home; a missing
  or malformed original header, unavailable identity or ambiguous working homes refuse before a model request.
- **Replayable offline:** yes (isolated launcher and fake Claude/owner; live authentication is separate).
