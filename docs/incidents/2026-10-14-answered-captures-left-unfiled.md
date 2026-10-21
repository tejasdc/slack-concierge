---
failure: The Inbox agent answered Tejas's messages but never put them in a thread, so they sat as "Never filed".
date: 2026-10-14
fix_commits: [3476a064]
cause_status: confirmed
---

# Answered Inbox messages stayed "Never filed"

## What was seen

On 2026-10-14 at 1:16 PM ET Tejas found five of that day's messages (10:58, 10:59, 12:11, 12:23 and
12:58) marked "Not in a thread yet · Never filed" in his Inbox. The Inbox router (concierge:3172,
Claude Code) had received and answered each one, but never placed any in a topic. His words: "This
is very, very unacceptable. Why have my requests never been filed? … Can we add a stop hook for you:
before you stop, every time you stop, you have to check the queue."

## Cause

Filing depended only on instructions. Every unplaced input carried a `<topic-placement>` reminder
("This capture is not yet in a topic. Place it…"), and nothing checked the result. The shared Stop
hook (`bot/scripts/owed-reply-stop-hook.ts`) refused a turn end only for owed request replies, and it
let the turn end at once on a repeated Stop (`stop_hook_active`) or while background tasks ran. So
a router turn could answer, skip filing, and end, and an input missed in one turn was never
rechecked in later turns.

## Fix

3476a064 adds `unfiledReceivedInputs` (`bot/src/session-topics.ts`) and returns its result as
`unfiled` from `/session-communication/owed`. That is every human input this Inbox session actually
received (provider-acknowledged, or the turn now stopping; steering needs its sent receipt) whose
root has no topic placement, including earlier turns. Queued inputs, service returns and agent
requests are excluded. The Stop hook now blocks on every Stop, including repeated Stops and Stops
with background work, while anything is unfiled. It names each input with a short preview and gives
ready commands to place it, create its topic, or create and close a noise topic with a reason.
Filing anywhere satisfies it, so the router cannot be trapped. Running turns kept their pinned hook;
new turns got the check. `docs/contracts/native-inbox.md` ("Filing before stopping") and `AGENTS.md`
record it.

## Acceptance scenario

- **Seed:** An Inbox router session with one delivered human input (agent-marked test capture)
  whose root has no topic, from an earlier turn.
- **Action:** The router ends a later turn without filing it, then tries to stop a second time.
- **Expected:** Both Stop attempts are blocked and name that input with place/create/noise
  commands. After `sessions topics place` (or a closed noise topic), the next Stop is allowed.
- **Replayable offline:** yes (scratch owner plus the hook script fed a provider Stop payload; no
  real provider needed)
