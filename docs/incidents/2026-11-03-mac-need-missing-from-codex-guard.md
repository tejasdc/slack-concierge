---
failure: A Mac Codex session created with an accepted mac-app need had its hidden app launch refused as if it had no need, and a later request's need did not apply to the running session.
date: 2026-11-03
fix_commits: []
cause_status: confirmed
---

# The Voice Memos session on the Mac could not open Voice Memos in the background

## What was seen

The Inbox started mac:258 (Codex) with `--machine-need "mac-app:Voice Memos syncing from his iPhone
only happens in the Mac's Voice Memos app"`. Its first message on the Mac carried that need, but the
tool guard refused `open -g` for Voice Memos with "A background Mac app launch needs an accepted
Mac-only reason". A reissued request to the same running session, steered in, was refused the same way.

## Cause

The guard read the need only from the agent process's environment, set per turn from the run's
first message. Codex turns all run on the one shared Codex App Server, whose hooks never see a
per-turn environment; and no process environment changes when a later request is steered into a
running turn.

## Fix

The owner answers "the machine need of the run holding this provider conversation" from the inputs
that run took (its first message and anything steered in), newest first. The guard asks it before a
refusal stands, on the Mac only, so ordinary allowed commands cost nothing extra.

## Acceptance scenario

- **Seed:** a Mac Codex session created by a request with `--machine-need mac-app:<reason>`.
- **Action:** its agent runs `open -g -a Calculator`.
- **Expected:** the launch is allowed; a session with no recorded need is still refused.
- **Replayable offline:** no (needs the Mac's Codex App Server and managed hook)
