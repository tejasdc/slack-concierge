---
failure: A reply Tejas sent to an agent in an Inbox thread appeared twice, once as his message and again as an internal request card.
date: 2026-11-02
fix_commits: []
cause_status: confirmed
---

# A direct agent reply appeared twice in the thread

## What was seen

Tejas's 11:56 PM reply in the Nightly upkeep thread appeared as his message, followed by a Sent to receipt and a second full request card attributed to an agent. The router had not sent a second request or woken for the answer.

## Cause

The Inbox projection treated the internal forwarding request as a separate conversation message even though the accepted human message and route receipt already represented that delivery. Earlier prepared rows kept the duplicate after the source path changed.

## Fix

Exclude forwarding requests from the live conversation projection and remove their existing prepared rows on upgrade. Keep the human message, route receipt, exact request record, answer, deadlines and final disposition. Expose request coordination and automatic earlier-work suggestions through the thread's bounded work view, including local and peer requests.

## Acceptance scenario

- **Seed:** An Inbox thread has a human reply addressed to an agent and its retained forwarding request; the projection has an old request row.
- **Action:** Rebuild or upgrade the thread projection, then read the conversation and work view.
- **Expected:** The conversation shows his reply once, its compact Sent to receipt, and the agent answer. The request remains reachable by exact receipt and retains its closure and reminder state; the work view shows applicable coordination without a duplicate conversation card.
- **Replayable offline:** yes (seed the source events and prepared projection, then run the production projection and read paths).
