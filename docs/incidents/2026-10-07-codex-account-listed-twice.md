---
failure: Signing a Codex account in again created a second home for it, so Accounts listed the same account twice and none as in use.
date: 2026-10-07
fix_commits: [30b77e25]
cause_status: confirmed
---

# Accounts listed one Codex account twice

## What was seen

On 2026-10-07 Accounts showed the gmail Codex account twice after a sign-in, and no Codex row said which account
was in use.

## Cause

Confirmed from the commit. `CodexAccountLogin` (`bot/src/codex-account-login.ts`) filed a completed sign-in into
`~/.codex-accounts/<profileId(email)>`, naming the home by address alone. The long-standing gmail home had a
different directory name, so a second home for the same account was created and listed. Separately, the login in
use lives in the agents' own home (`~/.codex`), which had no row of its own, so nothing was marked in use.

## Fix

30b77e25: new `existingCodexHome` (`bot/src/provider-accounts.ts`) finds the kept home whose credential names the
same Codex account id, and sign-in files into that home when one exists. The Codex login in use is listed as its
own row marked in use (`session-execution-host.ts`), and Claude's message names the chosen account and where work
runs while it is at its limit.

## Acceptance scenario

- **Seed:** `~/.codex-accounts/<old-name>/auth.json` for account id A; a fresh sign-in completing as the same
  account A with an email whose profile id differs from `<old-name>`.
- **Action:** finish the Codex sign-in and read the Accounts list.
- **Expected:** the credential is filed into `<old-name>`, no new home appears, A is listed once, and the account
  in use is marked.
- **Replayable offline:** yes (scratch HOME with synthetic Codex credential files)
