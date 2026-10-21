---
failure: A message sent to a running Gemini agent just before a Concierge update stayed "uncertain" after the agent had read and answered it.
date: 2026-10-13
fix_commits: [d8d42737]
cause_status: best-explanation
---

# A Gemini agent answered a message, but Concierge kept showing it as uncertain

## What was seen

Steering into a running Gemini CLI, and Gemini runs surviving Concierge updates, shipped in fb0ba735
(PR #74, merged 09:45Z on 2026-10-13). Concierge restarted for updates at 09:47, 09:51, 09:57 and 10:03Z,
adopting the same execution (turn 7883) each time. At 09:57:48Z the new coordinator logged
`unsettled_steering_recovered` with one ambiguous message. The fix commit describes the observed outcome: the
CLI picked up a message the previous Concierge had written and answered it, but the message stayed uncertain.

## Cause

When a new Concierge adopts a Gemini execution host, `runAntigravityTurn` in `bot/src/antigravity.ts` replays
the host's record. A steering message written by the previous coordinator arrives through
`onReplayedInput`, which pushed it onto the `written` list without any callback. When Gemini later picked it up
(or the run ended without doing so), nothing reported that to the new coordinator, which now owns the
message's record, so its acknowledgement was never written and it stayed `STEERING_DELIVERY_UNCONFIRMED`.
Claude's adopted runs already reported this.

Best explanation: the journal shows one ambiguous steering message recovered on a repeatedly adopted run in
the window between the Gemini steering release and this fix; the run's provider and message identity were not
confirmed from retained records here.

## Fix

d8d42737: `AntigravityRun` gains `onRecoveredSteering(clientMessageId, "acknowledged" | "unacknowledged")`,
and each replayed steering write carries resolve/reject callbacks that report its pickup or loss to the
adopting coordinator, the way Claude's replayed steering does. 12ef5998 (rebuild the input-closing decision
from replayed state) fixed a flaw in fb0ba735 within the same pull request, before it ever ran, so it is not
listed.

## Acceptance scenario

- **Seed:** A Gemini execution host (or stub CLI) running a turn, with one steering message written by
  coordinator A and not yet picked up.
- **Action:** Restart into coordinator B, which adopts and replays the host; the CLI then picks up and
  answers the message.
- **Expected:** B records the message as acknowledged (not ambiguous). If the run ends without picking it
  up, B records it as unacknowledged.
- **Replayable offline:** yes (stub CLI behind the execution-host transport; no Google account needed)
