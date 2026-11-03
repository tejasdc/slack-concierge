---
failure: After a new Claude account was signed in and proven, the Inbox's captures stayed held for about 35 minutes while other sessions resumed.
date: 2026-11-03
fix_commits: []
cause_status: best-explanation
---

# The Inbox stayed held after he added an account with room

## What was seen

At 12:59 PM ET Tejas signed a Claude account in through Accounts; its check passed ("works"). Other
held sessions resumed after his Accounts checks at 1:06 and 1:18 PM. The Inbox's captures from 12:48
and 12:55 PM still showed "Held: No Claude account has room until November 4 at 3:00 AM ET". The Inbox
ran them only at 1:30 PM, right after a Concierge update restarted the service.

## Cause

1. Holds were filed by model name. The Inbox runs Claude Code's extended-window Opus (`opus[1m]`),
   which spends Opus 5.5's own allowance but had its own scope. The Accounts check tests the oldest
   held turn's model and releases only that scope: it proved Opus 5.5 (8 turns) and then Sonnet
   (1 turn), never `opus[1m]`.
2. The sign-in's own successful check released only plain usage holds, never refused turns'
   continuations; those waited for a usage reading showing room. The usage reader could not read the
   new account (only the spent account appears in its readings), so no such reading ever came. The
   17:59 UTC release logged nothing, consistent with the held turns being continuations; their hold
   kind at that moment was not retained, so this link is inferred.
3. The restart at 18:30 UTC ran the startup check, which released everything.

## Fix

Usage scopes name the allowance (`opus[1m]` is Opus 5.5's); fallbacks keep the exact model. A sign-in,
switch or background account check that answers also releases continuation holds.

## Acceptance scenario

- **Seed:** the Inbox (Opus 1M) has captures held on a spent account; the usage reader cannot read a
  second account.
- **Action:** a second account is signed in through Accounts and its check passes.
- **Expected:** the Inbox's held captures run within seconds, without an Accounts Refresh or restart.
- **Replayable offline:** no (needs a real spent account and a real sign-in)
