---
failure: An agent's question to ChatGPT was reported unanswered after 15 minutes even though ChatGPT had answered it.
date: 2026-10-09
fix_commits: [623ddd26]
cause_status: confirmed
---

# ChatGPT answers never settled the request that asked for them

## What was seen

In the live ChatGPT Pro check on October 9 the asking agent received a 15-minute overdue notice instead of ChatGPT's
answer. The code comment states no successful ChatGPT answer had ever settled its request.

## Cause

The owner settles a turn-answered request only after the provider acknowledged the input. In
`bot/src/session-capability-client.ts` acknowledgement was read only from the ChatGPT start receipt, which never carries
it: Thinkering confirms the sent message a few seconds later through the identity event (ChatGPT's own copy of the
message, the native turn id). Without an acknowledgement the request stayed open until the overdue check fired.

## Fix

623ddd26 calls `onInputAcknowledged` when the identity event reports the native turn id, so the ChatGPT answer settles
the request and returns to the asker.

## Acceptance scenario

- **Seed:** An agent request to a ChatGPT session; a stub capability that returns a start receipt without
  acknowledgement, then an identity event with a native turn id, then an answer.
- **Action:** The run completes.
- **Expected:** The input is marked acknowledged at the identity event; the request settles with the answer and one
  return reaches the requester; no overdue notice is produced.
- **Replayable offline:** yes (stub ChatGPT capability)
