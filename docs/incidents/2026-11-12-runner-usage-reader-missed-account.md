---
failure: A Claude account signed in through Accounts on the server was missing from Accounts usage again, because the runner's usage reader listed only claude-swap's accounts.
date: 2026-11-12
fix_commits: []
cause_status: confirmed
---

# The runner's usage reader lost the Nov 3 fix

## What was seen

On 2026-11-12 the server had three signed-in Claude homes (hey@tejas.nyc, tejas@chann.app,
tejastej.dc@gmail.com), but the Accounts provider reading for the server runner listed only chann and
Gmail. Running the installed reader by hand returned the same two accounts.

## Cause

The 2026-11-03 fix (`2026-11-03-usage-reader-missed-new-account.md`) taught the owner's reader to read
every kept home claude-swap does not list. When account custody moved to provider runners on
2026-11-05, usage collection moved to a second, runner-side reader written from the older shape: it
iterated `cswap list` only and dropped any account it did not list. hey@tejas.nyc was never added to
claude-swap, so it disappeared again.

## Fix

The runner reader now appends every signed-in runner home claude-swap does not list, read from that
home's own login, with "Usage could not be read." when that read fails. It also reads those homes
when claude-swap is missing or its list fails.

## Acceptance scenario

- **Seed:** a Claude account signed in through Accounts on a runner, not present in claude-swap.
- **Action:** the next runner usage reading.
- **Expected:** the account appears in Accounts with its own windows, or with "Usage could not be read."
- **Replayable offline:** no (needs a real signed-in Claude login)
