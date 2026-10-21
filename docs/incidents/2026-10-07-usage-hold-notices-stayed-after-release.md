---
failure: "Claude has no usage left" notices stayed on his Lock Screen for hours after the held work had already resumed.
date: 2026-10-07
fix_commits: [d4440d9c]
cause_status: confirmed
---

# Out-of-usage notices stayed on his phone after work resumed

## What was seen

On 2026-10-07 switching to his other Claude account released six held inputs at 5:59 PM EDT, but two "Claude
has no usage left" notices stayed on Tejas's Lock Screen past 8 PM (bug report 541713f0). The notices claimed
work was stopped when it was not.

## Cause

Confirmed from the commit. Usage holds publish `provider_outage` events (`provider-usage-hold:*`,
`provider-continuation-hold:*`, `provider-usage-forecast:*`), and Thinkering withdraws a notice from his devices
only on a matching `provider_outage_resolved` event. The sign-in hold already sent that resolution
(`provider-activation.ts`), but `releaseUsageHeldWork` and `clearProviderUsage` in `bot/src/provider-usage.ts`
only released the work and logged; they never recorded a resolution.

## Fix

d4440d9c: new `announceUsageHoldEnded` records `<event_id>:resolved` (`provider_outage_resolved`, with who
released it and how many inputs) for every unresolved usage, continuation or forecast notice of that provider
from the last two days, whenever an account switch or a cleared allowance releases held work.

## Acceptance scenario

- **Seed:** a ledger with two unresolved `provider_outage` events keyed `provider-usage-hold:claude-code:*` and
  queued inputs held on Claude usage.
- **Action:** release the hold (account switch, or clear usage).
- **Expected:** each notice gets exactly one `<event_id>:resolved` event of kind `provider_outage_resolved`;
  Thinkering's notifier withdraws both notices; releasing again records nothing new.
- **Replayable offline:** yes (scratch ledger; notifier withdrawal checked against Thinkering's event consumer)
