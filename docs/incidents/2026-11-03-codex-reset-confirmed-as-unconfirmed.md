---
failure: A successful Codex reset was shown as unconfirmed when another account was selected.
date: 2026-11-03
fix_commits: []
cause_status: confirmed
---

# A redeemed reset looked unconfirmed

## What was seen

At 2:58 AM ET Tejas used a banked reset in Provider accounts. The screen waited without a local progress mark, then said the reset was redeemed but launch availability was unconfirmed and work remained held. The provider's direct post-redemption read at 07:58:06 UTC actually confirmed ordinary allowance for the account he reset. Concierge cleared that account's cached refusal. At 07:58:16 a later account switch released one held input. The two accounts had separate balances: the one still at 100% weekly use had zero credits; the account he reset had two resets left and a usable credit balance.

## Cause

After verifying the redeemed account, the action compared its provider identity to the *currently selected* account and downgraded a confirmed result when they differed. The page hid a successful result and only disabled its confirmation button while the request ran. Concierge also treated a full included weekly bar as no launch room without considering the same account's usable credit balance, a requested behavior gap whose spent-week-with-credits case was not observed in this incident.

## Fix

Keep the verified redemption result bound to the redeemed account. Clear only that account's refusal, refresh its provider reading, and immediately reconsider the guarded account move that releases eligible held work. Show a working mark beside the reset and then the actual result. Use a fresh, positive credit reading for Codex launch eligibility after included allowance is spent; a newer provider refusal still takes precedence. Keep account identities separate.

## Acceptance scenario

- **Seed:** Two signed-in Codex accounts; the selected one has spent its included week, while the saved account has a redeemable reset. Retain an ordinary Codex input waiting on the selected account.
- **Action:** Redeem the saved account's reset in Provider accounts.
- **Expected:** The row shows progress, then a confirmed redemption for the saved account. A fresh provider reading shows its restored allowance. Concierge moves to it through the guarded switch when safe and makes the held input eligible without a manual confirmation; a later provider answer is checked separately.
- **Replayable offline:** no (a real banked reset is finite and cannot be restored; use the retained provider outcome and a future authorized redemption).
