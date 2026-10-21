---
failure: The Mac held Claude work "until October 18" on a spent account while his personal Claude account had 81% of its week left.
date: 2026-10-15
fix_commits: [d764e290, dc002d8f]
cause_status: confirmed
---

# Mac work held for three days while another Claude account had room

## What was seen

At 12:05 PM ET on 2026-10-15 the Mac's Concierge held Claude work with the reason that no account had room until
October 18, the reset of the spent `tejas@chann.app` account. Tejas's personal Claude account on the same Mac was at
19% of its week.

## Cause

Two independent things removed the personal account from `chooseClaudeDispatch` in
`bot/src/provider-account-dispatch.ts`, and with no account left it fell through to the timed usage hold at the
earliest readable reset:

1. On a Mac a Claude home's login is a Keychain item. `claudeKeychainHasLogin` in `bot/src/claude-keychain.ts` treated
   any non-zero exit from `security find-generic-password` as "no login". During an owner restart the lookup did not
   answer (timeout or busy Keychain), so the personal home was dropped from the launchable accounts
   (`claudeHomeHasLogin`, `installedAccounts`, `readProfiles`).
2. Its usage reading was 7.8 minutes old against the six-minute freshness limit. Accounts are read about every twelve
   minutes, so an account with room routinely looked unreadable, and an unreadable account was never chosen.
Once held, the release check on each new reading (`claudeAccountWithRoomBesides`) also required a fresh reading, so
a hold made while the account looked stale could stay parked.

## Fix

- d764e290: `claudeKeychainLogin` returns present / absent / unanswered; only exit 44 (errSecItemNotFound) means no
  login, and an unanswered lookup is logged once as `claude_keychain_lookup_unanswered`. Listing and launching use
  `claudeKeychainMayHoldLogin`; filing a new sign-in still requires "present". When no freshly read account has room,
  dispatch tries a launchable account whose last reading showed room and that has no cached refusal (preferring the
  expected account, then the least used); Claude's own refusal caches and excludes it if it is really spent.
- dc002d8f (after GPT-6 Sol review): only a reading that was good when taken counts (not one with a problem or
  signed-out state, which keeps its old percentages), and each usage refresh releases held work by the same rule
  through `claudeHeldWorkCanRun`.
docs/architecture/PROVIDER-USAGE.md records both.

## Acceptance scenario

- **Seed:** A Mac-like owner with two Claude homes: chann.app with a fresh 100% weekly reading and reset in three
  days; personal with a good 19% reading 7.8 minutes old, no cached refusal, and a stub `security` that times out
  (exit other than 0 or 44). One Claude input already usage-held until the chann.app reset.
- **Action:** Dispatch a new Claude input, then run a usage refresh.
- **Expected:** The new input runs on personal; the refresh releases the held input onto personal; one
  `claude_keychain_lookup_unanswered` log; no hold names October 18. If personal's last reading has a problem or is
  signed out, or `security` exits 44, it is not chosen.
- **Replayable offline:** yes (stub `security` and seeded readings; no real Mac Keychain needed)
