---
failure: A request scheduled for a later time sent its asker a "no confirmed answer after 15 minutes" reminder one second after its scheduled time, while the work was about to start.
date: 2026-11-04
fix_commits: [aae28bde]
cause_status: confirmed
---

# Scheduled request reminded as overdue at its fire time

## What was seen

Request fcbfdb21 was asked at 18:40:27 UTC for 18:42:30 UTC. At about 18:42:31 its asker got
reminder d088f612: "No confirmed answer … after 15 minutes", recipient state "queued". The
scheduled run started on time at 18:42:36. Only two minutes had passed.

## Cause

A request's reminder clock (`due_at_ms`) is normally the ask time plus 15 minutes. For a
scheduled request it was set to the scheduled fire time itself, so the overdue inspection ran
the moment the fire time passed, found the saved turn still queued for its claim, and sent
the 15-minute reminder. The Nov 2 fix for requests queued behind other requests and PR #422
(scheduled work waits for its fire time) did not touch this clock.

## Fix

A scheduled request's clock starts 15 minutes after its fire time. The overdue inspection also
reads the recipient turn's current saved fire time, so an edited schedule moves the clock with it.

## Acceptance scenario

- **Seed:** a scheduled request two minutes out.
- **Action:** the fire time passes and the turn starts a few seconds later.
- **Expected:** no overdue reminder; the earliest one is 15 minutes after the fire time.
- **Replayable offline:** no (needs the saved-work clock and the request dispatcher).
