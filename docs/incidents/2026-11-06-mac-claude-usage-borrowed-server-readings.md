---
failure: The Mac showed Claude usage borrowed from the server while one signed-in Mac account had no usage row at all.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# Mac Claude usage did not come from its own accounts

## What was seen

On November 6, the installed Mac owner listed three signed-in Claude accounts in Accounts.
Its Claude usage payload had only two account rows, both marked as borrowed from the cloud
and matched by label. The chann.app row retained a November 5 source time and said the
latest reading could not be taken. The hey@tejas.nyc account had no usage row.

## Cause

The Mac keeps Claude credentials in its GUI Keychain. The Claude usage reader returned an
empty list when claude-swap was not installed, then filled what it could by borrowing
server readings. It never asked the Mac's own Keychain logins for their usage.

## Fix

Read each signed-in Mac account's Keychain login in place and ask Anthropic for its usage.
The existing source-time, backoff and peer merge rules remain. A pressed Refresh asks for a
new local read even when the next scheduled read is not due.

## Acceptance scenario

- **Seed:** Mac Concierge in Tejas's GUI session with three signed-in Claude account homes;
  the server has only two Claude usage rows, one stale.
- **Action:** open Accounts and press Refresh.
- **Expected:** all three Mac Claude rows get Mac-local source times from the current pass;
  the page shows checking until the pass finishes. A refused account keeps its original
  source time and a visible problem instead of claiming a fresh number.
- **Replayable offline:** no (requires the Mac GUI Keychain and live provider usage endpoint).
