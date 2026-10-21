---
failure: The Mac never listed or used its extra Claude accounts, and a new Claude sign-in on the Mac was reported as not finished.
date: 2026-10-08
fix_commits: [3217fa80, c90e9271]
cause_status: confirmed
---

# Mac Claude accounts kept in the Keychain were invisible

## What was seen

On 2026-10-08 a Claude account signed in on the Mac was reported as not finished, and newly signed-in accounts
never appeared in the Mac's Accounts list. The Mac only ever ran agents on its main login and never chose
between accounts, unlike the server.

## Cause

Confirmed from both commits. On macOS, Claude Code stores a home's login in the Keychain under that folder's
name, not in `.credentials.json`. `provider-accounts.ts` listed a Claude home only when its credentials file
existed and judged `signedIn` from that file, so every Mac Claude home was filtered out. The sign-in flow in
`claude-account-login.ts` looked for the new login in the staging folder's credentials file, so a completed
sign-in looked unfinished and was never filed under its account's home.

## Fix

- 3217fa80: new `claude-keychain.ts` reads the login stored under the staging folder's name and, if it is
  JSON, moves it to the account's home; anything else (hex binary output) is not moved blindly.
  `claude-account-login.ts` and `provider-account-dispatch.ts` use it.
- c90e9271: `provider-accounts.ts` counts a Claude home whose login is in the Keychain
  (`claudeKeychainHasLogin`) and treats it as signed in, so the Mac lists and chooses between its accounts.

## Acceptance scenario

- **Seed:** a Mac with two Claude homes whose logins are only in the login Keychain (no credential files).
- **Action:** read Accounts; then sign in a third account through the Accounts flow.
- **Expected:** both homes listed as signed in and eligible for dispatch; the new sign-in is reported finished
  and appears as its own account home.
- **Replayable offline:** no (needs macOS Keychain and a real Claude sign-in)
