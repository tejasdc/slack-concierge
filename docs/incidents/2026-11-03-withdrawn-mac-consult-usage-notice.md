---
failure: A withdrawn informational Mac consult remained usage-held with a queued cancellation instruction, and its hold was pushed as a human message.
date: 2026-11-03
fix_commits: []
cause_status: confirmed
---

# Withdrawn Mac consult shown as a usage-held human message

## What was seen

On November 3 at 2:28 PM ET, Mac session `mac:75`, “Third spaces online: research and walkthrough,” produced a Claude Opus 5.5 usage notification. Tejas had sent no message to that session and saw no queue. The notification said a message would start at 3:00 AM.

## Cause

- At 19:27:39 UTC, the Mac owner admitted informational agent request `request:75273dc5-ebf6-4143-8cc6-65ea1f7aaecc` as turn 1204. At 19:27:41 its preflight recorded a usage hold before any Claude execution row or provider turn existed.
- At 19:27:48 the origin canceled the request. The origin settled it, but the peer closed only the delivery, leaving 1204 queued. It added turn 1205, a cancellation instruction, behind 1204. Those were the two pending inputs in the Mac owner projection. Neither was a human message.
- The Mac's selected account was `tejas@chann.app`, weekly exhausted until November 9 03:00 UTC. The personal account was also exhausted until November 4 08:00 UTC (3:00 AM ET); that was the displayed earliest reset. `hey@tejas.nyc` had weekly room in the server reading, but no runnable credential home on the Mac. The reset was therefore an opportunity to recheck, not a guaranteed start.
- The Mac receipt projection retained both inputs, while provider history contained neither because no provider turn began. The visible session did not present the held consult to Tejas. The notification originated from the hold event before cancellation, not a later human input.

The primary defect was peer cancellation that settled the origin without revoking an unstarted target. The notice also treated an internal agent consult as a user message and promised a start from a reset calculation that did not prove launchability.

## Acceptance scenario

- **Seed:** an accepted peer informational request with an unstarted, usage-held target turn.
- **Action:** cancel the origin while its peer is offline; then reconnect before the usage reset and let reconciliation run.
- **Expected:** the peer target and redundant cancellation instruction become terminal, the request stays settled, no provider execution starts at reset, and no user-facing usage outage is produced for the internal consult.
- **Replayable offline:** yes, through a diagnostic owner with one peer disconnected and then reconnected. Agent-run tests are disabled under the current delivery policy; the live ledger pair is the current acceptance check.

## Fix

The origin retains cancellation until the peer acknowledges revocation, including when delivery and cancellation cross. The peer also checks the origin when a queued target has not changed locally, so a sleeping Mac learns of withdrawal on its next reconciliation. The peer's cancellation transition revokes the unstarted target and its redundant instruction atomically. Restart reconciliation visits historical canceled deliveries with that pair. Usage and authentication holds remain diagnostic events; a receipt describes a live wait without promising execution at a reset. Unreadable usage evidence permits a real attempt through a proven local account instead of being treated as exhaustion. The live checks still owed are: both Mac turns terminal, `pendingCount` zero for session 75, and a new canceled peer consult staying out of the queue after a reset deadline. The installed Thinkering notification path must be checked separately from the owner event.
