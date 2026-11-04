---
failure: Concierge's own bookkeeping notices rang Tejas's devices with nothing for him to act on.
date: 2026-11-04
fix_commits: []
cause_status: confirmed
---

# Alerts he could not act on

## What was seen

Tejas, Mac capture `646846d48bc3c91b441bc5455f7676beca2a597bff46242ad933bd948007a1a9`, Nov 4,
3:23 PM ET: "I'm also getting a lot of unnecessary notifications ... a few notifications coming in
that were nothing I could actually act on." thnkr.ing's delivery record shows 12 alerts sent to
his Mac, Linux and iPhone apps that day. Four were Concierge notices: "Your request is still open.
Concierge has tried twice to restart its work" at 2:29 PM (two threads) and 2:38 PM, and "A result
reached this conversation, but the agent stopped without confirming what happened" from the
repair agent's session at 12:07 PM.

## Cause

Thread upkeep posted the "still open" line with `notify:true`, a requested notification. The return
audit recorded an unread result as a `needs_you` outcome; thnkr.ing leaves most of those to the
Inbox, but a session with no human origin (the repair agent) has nobody to leave it to, so it rang.

## Fix

The "still open" line is posted without a notification. The unread-result notice is recorded as
`response`, which stays in Needs attention and does not ring. See
[requested phone delivery](../contracts/requested-phone-notifications.md#concierges-own-notices-never-ring).

## Acceptance scenario

- **Seed:** an Inbox request whose work is lost twice, and a repair-agent session with a return its run errored on.
- **Action:** thread upkeep and the return audit run.
- **Expected:** the thread shows the "still open" line and Needs attention shows the unread result; no requested or blocking notification event exists for either.
- **Replayable offline:** yes
