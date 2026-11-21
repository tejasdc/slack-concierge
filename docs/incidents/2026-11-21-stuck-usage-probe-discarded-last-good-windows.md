---
failure: Stuck Claude usage probe silently discarded stored allowance numbers; every Claude turn refused "out of room" while the Accounts tray showed two accounts with headroom.
date: 2026-11-21
fix_commits: []
cause_status: confirmed
---

# Every Claude turn refused while two accounts clearly had room

## What was seen

Tejas wrote a message in the thread "Questions for Varun about joining Essos" at 10:08 ET on
2026-11-21. The agent's badge showed **Held — This work is waiting for Claude allowance.
Your message is kept. Concierge will check again at November 22 at 9:59 PM ET or sooner
if another account can run it.**

The Accounts tray at the same time showed, for the server:

- `hey@tejas.nyc` — "Usage could not be read · included allowance unknown · based on provider
  read at **time unavailable**"
- `tejas@chann.app` — "**Weekly 75% used**", "Weekly Fable only 2% used", plus "Showing the
  last reading; the latest could not be taken"
- `tejastej.dc@gmail.com` — "5-hour 35% used", "**Weekly 43% used**", "Weekly Fable only 6%
  used", plus "Showing the last reading; the latest could not be taken"

The service was running the latest release (`01dc3b98`) with every earlier account-switching
fix shipped. In the service log every three minutes:

```
provider_account_usage_observed  provider:"claude-code"  accounts:3  unreadable:3  problem:false
native_provider_refused         "Every available Claude account is out of room."
  at chooseClaudeDispatch (bot/src/index.js:134359:34)
```

Every probe had been returning "unreadable" for the entire hour; the stored windows from the
prior successful reads were preserved on disk and in the tray, but the dispatcher threw.

## Cause

In `bot/src/account-authority.ts`, Step 5 ("last-showed-room") required
`reading.problem === null` to admit a stale-but-positive reading. When the latest probe
attempt failed, the per-account `.problem` was set to "Usage could not be read" and
preserved alongside the prior windows. With that flag non-null, Step 5 was skipped; Step 6
fired and returned `reading-stale`; the dispatcher's `attemptRoom` filter does not list
`reading-stale` as hold-worthy (only `ready`, `unknown`, `last-showed-room`,
`proven-attempt`). Result: zero candidates, dispatcher threw "Every available Claude
account is out of room."

The confusion was treating "the latest probe couldn't talk to the provider" as if it
invalidated the prior allowance numbers. The stored windows say nothing about the probe's
health. "Fresh probe failed" ≠ "your allowance went to 100%."

## Fix

Broaden Step 5 to admit a stale reading with stored windows showing room **regardless of
`reading.problem`**. If the attempt itself hits a real API refusal, that caches through the
refusal path and blocks the next pass. If every stored window was already at 100% used,
Step 5 still refuses — the condition `windows.every(w => w.usedPercent < 100)` preserves
that case.

## Acceptance scenario

- **Seed:** Claude home exists for `tejas@chann.app`; `provider_account_usage` row holds
  one account with `problem: "Usage could not be read"` and a preserved window
  `{usedPercent: 75}`, observed 9 days ago (stale).
- **Action:** `canTakeWork("claude-code", {provider:"claude-code", label:"tejas@chann.app"},
  "claude-opus-5-5")`.
- **Expected:** `ok: true`, `reason: "last-showed-room"`,
  `source.readingUsedPercent: 75`, `source.readingFresh: false`.
- **Replayable offline:** yes (`bot/tests/incidents/2026-11-21-probe-failure-discards-last-good.test.ts`).
