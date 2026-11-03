---
failure: Agents' progress replies and corrections rang Tejas's phone 16 times in two hours because a reply's notify flag was honored on any reply.
date: 2026-11-02
fix_commits: [7fd06aad]
cause_status: confirmed
---

# His phone rang for every progress update and correction

## What was seen

Tejas, Pebble capture `8fd6c24a4717635e87d4a1ac685b2ea41aa7de3054f4601d24feff6a25e621f0`,
Mon Nov 2, 3:14 AM ET: "Why is this agent going crazy and notifying me of every single message?
... Why can't it wait until everything is deployed and tested and then let me know?"

Between 06:00 and 08:14 UTC the Inbox recorded 16 requested-notification alerts. Every one came
from a partial reply. Fourteen were from the think-aloud Canvas agent (`concierge:7446`), five of
them in the last hour, three of those corrections within two minutes (08:12:30, 08:13:01,
08:13:48 UTC). Two were from the phone-restart agent (`concierge:7689`).

## Cause

`sessions reply --notify` produced a requested phone notification for any reply that had words,
partial or final, whatever its disposition. The Inbox router had told the Canvas agent to notify
as each piece landed, so it marked nearly every progress update. Nothing in the owner limited
which replies may ring his phone.

## Fix

`7fd06aad` (PR #320): the reply command honors `--notify` only on a final `completed` reply that
carries `--checked`. On a partial, failed or unchecked reply the flag is dropped, the reply is
recorded as written, and the receipt says why. Questions only he can answer keep their own
blocking alert. The router help and
[requested phone delivery](../contracts/requested-phone-notifications.md) state the rule.

## Acceptance scenario

- **Seed:** an Inbox thread with a request dispatched to a worker session.
- **Action:** the worker sends three partial replies with `--notify`, then one final
  `--work-disposition completed --checked "..." --notify`.
- **Expected:** all four replies are posted in the thread; exactly one requested-notification
  alert exists (for the final reply); each partial reply's receipt carries the dropped-flag notice.
- **Replayable offline:** yes
