---
failure: Tejas was told a Claude account was running low only after it had already run out; the advance warnings were dropped or watched the wrong account.
date: 2026-10-07
fix_commits: [70ebafc0, 97d12e65, 104773c0]
cause_status: confirmed
---

# Running-low warnings arrived only after the account ran out

## What was seen

On 2026-10-07 both Claude accounts were forecast to run out (18:57 and 20:16 UTC), yet Tejas heard only when each
had already run out: "I'm only getting fucking notified after the fucking usage is used up." He heard about
chann.app only after it was out, and the one 60-minute warning that was computed came 25 minutes before an account
ran out.

## Cause

Confirmed from the commits, three causes:

- Wrong account (70ebafc0): the usage reader marks as `current` whoever is signed in to the main `~/.claude`
  folder. Once accounts had their own homes that was the terminal's login, so the forecast, the "other accounts
  with room" list and the notice's account name followed the wrong account.
- Dropped carrier (97d12e65): `publishUsageForecastNotices` (`bot/src/provider-usage-notice.ts`) recorded the
  warning only as a `provider_outage` event with no message behind it, and thnkr.ing sends an outage push only
  when it holds one of his messages, so every forecast warning was silently dropped. The banked-reset expiry
  notice had the same drop.
- Too late (97d12e65, 104773c0): it watched only the agents' account with a 60-minute lead, so a burst after a
  quiet spell gave minutes of warning.

## Fix

- 70ebafc0: `withAgentsAccountCurrent` marks the account selected for agents as current wherever usage is read.
- 97d12e65: the warning became a provider-free Inbox notice (`publishProviderFreeNotice`) with its own thread,
  reading item and push, keyed per account/window/period, for every account, at a 90-minute projection, and its
  thread closes when the window refills; the reset-expiry notice moved to the same carrier.
- 104773c0: also warns at 60% while usage is still climbing.

Later policy changed: [decision: usage-notice-only-at-90-percent] now limits the notice to an account reaching 90%;
the carrier and correct-account fixes are what this record's scenario checks.

## Acceptance scenario

- **Seed:** two Claude account homes with the second selected for agents while the main folder holds the first;
  usage readings showing the selected account climbing toward its window limit.
- **Action:** run the usage watch at the warning threshold.
- **Expected:** one Inbox notice in its own thread naming the selected account, delivered as a push through the
  reading-item path; no notice about the main-folder account; the thread closes when the window refills.
- **Replayable offline:** yes (scratch ledger with synthetic usage readings; push checked at Thinkering's notifier input)
