---
failure: The Mac showed Claude usage borrowed from the server while a Mac account with a valid local login had no usage row at all.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# Mac Claude usage did not come from its own accounts

## What was seen

On November 6, the installed Mac owner listed three Claude homes as signed in because each
had a Keychain item. A read-only local auth check on November 6 confirmed chann.app and
hey@tejas.nyc as signed in, but Claude reported the Gmail home signed out despite its
Keychain item. Keychain item presence does not prove a usable Claude login.
The two confirmed homes initially returned HTTP 401 from Anthropic's usage and profile
endpoints. Claude Code's own `/usage` command renewed each login in its saved home without
a model turn or sign-in prompt. Both usage and profile requests then returned HTTP 200;
the profile emails matched the saved home labels. The Gmail home was not touched.
Its Claude usage payload had only two account rows, both marked as borrowed from the cloud
and matched by label. The chann.app row retained a November 5 source time and said the
latest reading could not be taken. The hey@tejas.nyc account had no usage row.

## Cause

The Mac keeps Claude credentials in its GUI Keychain. The Claude usage reader returned an
empty list when claude-swap was not installed, then filled what it could by borrowing
server readings. It never asked the Mac's own Keychain logins for their usage.

## Fix

Read each Mac account's saved Keychain login in place and ask Anthropic for its usage when
the login is usable. A signed-out home must not acquire an invented fresh reading.
When an access token has expired or Anthropic rejects it with 401, let Claude Code renew
that same home's login. A pressed Refresh waits for the renewal, then retries the usage
read once rather than ending with the old value while renewal runs in the background.
The existing source-time, backoff and peer merge rules remain. A pressed Refresh asks for a
new local read even when the next scheduled read is not due.

## Acceptance scenario

- **Seed:** Mac Concierge in Tejas's GUI session with three saved Claude account homes;
  two confirmed signed in by Claude, one reported signed out; the server has only two
  Claude usage rows, one stale.
- **Action:** open Accounts and press Refresh.
- **Expected:** the two confirmed Mac logins get Mac-local source times from the current
  pass; the page shows checking until the pass finishes. The signed-out or refused home
  keeps its original source time and a visible problem instead of claiming a fresh number.
- **Replayable offline:** no (requires the Mac GUI Keychain and live provider usage endpoint).
