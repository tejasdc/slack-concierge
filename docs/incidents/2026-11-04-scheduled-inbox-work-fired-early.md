---
failure: Scheduled Inbox work set for 14:00 UTC was answered before 09:53 UTC after a Concierge restart.
date: 2026-11-04
fix_commits: []
cause_status: best-explanation
---

# Scheduled Inbox work fired before its due time

## What was seen

The Inbox scheduled a request at 09:37 UTC for 14:00 UTC. The accepted receipt held the correct due time (`1793800800000`). After a release restart at 09:52, the Inbox answered and settled the work before 09:53. The retained source report is Inbox topic `topic:c63c7d14-27fa-42c2-bf66-1debea663339`; the scheduled request is `2041177f-f71b-412e-bca6-bff0939f904b`.

## Cause

The queue's admission rule checked its mutable retry time but did not independently check the scheduled fire time. A recovery or retry path that clears the retry time could therefore admit saved work early. The retained receipt proves the requested due time and the observed early answer, but does not identify which path changed the retry time for this particular turn. This is a confirmed missing admission guard and a possible explanation of the incident.

## Fix

The queue checks the scheduled fire time at the final atomic claim, regardless of the retry time. Manual start remains an explicit exception. The queue's clock also watches the fire time, so a cleared retry time cannot strand the work after the due time. The schedule remains a durable property of the saved turn through recovery.

## Acceptance scenario

- **Seed:** a queued scheduled turn with a future fire time and a retry time cleared to zero.
- **Action:** claim the queue before and then at the fire time.
- **Expected:** no early claim; claim becomes eligible at the fire time, subject to the ordinary queue gates.
- **Replayable offline:** no. Agent-run tests are disabled by Tejas; verify the installed admission behavior through a marked scheduled request and inspect its owner receipt.
