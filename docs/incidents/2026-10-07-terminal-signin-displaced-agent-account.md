---
failure: A Claude sign-in typed by hand in a server terminal silently moved every agent off his personal account.
date: 2026-10-07
fix_commits: [5652883f]
cause_status: confirmed
---

# A terminal sign-in silently took agents off his chosen Claude account

## What was seen

At 19:31 UTC on 2026-10-07 someone ran `claude auth login` by hand on the server. It replaced the main `~/.claude`
login (his personal account) with tejas@chann.app. Agents silently stopped running on his personal account; nothing
told him, and Accounts did not show the change as a different account.

## Cause

Confirmed from the commit. Claude keeps no copy of the login it replaces, and agent dispatch
(`bot/src/provider-account-dispatch.ts`) ran on whatever the main folder held whenever the selected account's own
home was not yet proven or not listed by the usage reader. Sign-in hold releases also probed the main folder rather
than the selected home, and Accounts listed the main folder's login as if it were a kept account.

## Fix

5652883f (reviewed SHIP after two should-fix findings were fixed):
- Once any Claude account has its own home, agents never run on the main folder's login (`claudeRunsFromOwnHomes`);
  the selected account runs from its home without waiting for a background proof, even when the usage reader does
  not list it yet. With no launchable home the turn is held for sign-in instead of falling back.
- Releasing that hold probes the selected home; a home that proves itself releases sign-in holds; the hold notice
  names the selected account.
- Accounts no longer lists the main folder's login as an account and says when a terminal sign-in there is a
  different account. The Mac (Keychain logins, no homes) is unchanged.

## Acceptance scenario

- **Seed:** two Claude account homes, account P selected; the main `~/.claude` credential then replaced by account C.
- **Action:** dispatch an agent turn; read Accounts.
- **Expected:** the turn launches from P's home (`CLAUDE_CONFIG_DIR` points at it), never the main folder; Accounts
  still shows P selected and notes the terminal login is a different account; with P's home signed out the turn is
  held for sign-in rather than running on C.
- **Replayable offline:** yes (scratch homes with fake credentials and a stub `claude` that reports its config dir)
