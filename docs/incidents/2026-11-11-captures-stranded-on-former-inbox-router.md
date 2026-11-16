---
failure: Captures delivered to an Inbox session that then lost the router role stayed in no thread for six days, and no part of the system noticed.
date: 2026-11-11
fix_commits: []
cause_status: confirmed
---

# Five captures from Nov 5 showed "Never filed" on Nov 11

## What was seen

On Nov 11 Tejas's Inbox "Not in a thread yet" list showed captures from Nov 5 marked
"Never filed", while newer requests were all being worked. The router found eight captures
(Nov 5, 17:59–20:21 UTC) delivered to the Inbox session in use that day (concierge:8785) and
never filed; it filed and dispatched them on Nov 11.

## Cause

The end-of-turn filing check (Filing before stopping) counted only inputs the *current*
router session had received. When the Inbox role moved to another session (failovers on
Nov 5 and Nov 9–11), unfiled captures on the former router belonged to no session that would
ever end a turn again, and nothing handed the new router the list thnkr.ing already showed.
No timer looked at the sorting pile either, so an idle router was never woken.

## Fix

The current router's Stop check and its per-input turn context now include every unfiled root
in the whole Inbox (the same entry index as the sorting pile). The owner's thread-upkeep pass
wakes an idle router once per set of captures unfiled for 10 minutes and records a repair
notice for any capture still unfiled at 30 minutes. See
`docs/contracts/native-inbox.md#filing-before-stopping`.

## Acceptance scenario

- **Seed:** Two Inbox sessions; a human capture accepted on the first; the `inbox` role then moved to the second.
- **Action:** The second session's Stop check, turn context and the upkeep pass run.
- **Expected:** The capture is listed for the second session with `received_by` naming the first, appears in its turn context, wakes it at 10 minutes, and raises a repair notice at 30 minutes.
- **Replayable offline:** yes (`bot/scripts/inbox-unfiled-across-routers-fixture.ts`, part of the release build)
