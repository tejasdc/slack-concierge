---
failure: A resumed Codex turn left a detached server process running, while repeated checks opened separate reports for the same problem.
date: 2026-11-04
fix_commits: []
cause_status: confirmed
---

# Resumed Codex turn kept an old run ID

## What was seen

The first server process check generated several Inbox issues for ordinary Codex turns. Its
owned-unit exclusion reduced those reports, but a marked resumed turn launched a detached
sleep process that stayed in the shared Codex App Server scope. The process's environment
carried the thread ID and the *first* turn's Concierge run ID, not the resumed turn's ID.

## Cause

The Stop hook checked before provider cleanup finished and matched the current run ID. A
resumed Codex shell can retain an older run ID. Each report used the current input and run
as part of its capture identity, so successive sightings opened new issues.

## Fix

The server owner checks after provider completion using the stable thread ID. It records a
durable intent and retries an interrupted check. The Inbox receiver returns an existing open
Codex-process issue for subsequent sightings. It records exact process identity for repair.

## Acceptance scenario

- **Seed:** A marked Codex session on the server has completed one ordinary turn.
- **Action:** Resume it, leave a detached process carrying its thread ID, and finish the turn.
- **Expected:** The owner reports the survivor once after the turn ends. A later sighting while
  that issue remains open returns the same issue; an ordinary turn creates no issue. The
  process is stopped by exact PID and start time after inspection.
- **Replayable offline:** no (requires live Codex App Server process custody and Inbox routing).
