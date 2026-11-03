---
failure: A Claude account signed in through Accounts on the server never appeared in usage readings, so Accounts could not show its usage and nothing waiting for room could see it.
date: 2026-11-03
fix_commits: []
cause_status: confirmed
---

# The new Claude account was invisible to the usage reader

## What was seen

hey@tejas.nyc was signed in through Accounts on the server at 12:59 PM ET and passed its account
check. Every later Claude usage reading listed only tejastej.dc@gmail.com (100% of its week) and
tejas@chann.app; hey@tejas.nyc never appeared.

## Cause

The Claude usage reader took its account list from claude-swap (`cswap list`), which manages only
the accounts added to it. Signing in through Accounts files the login into its own home under
`~/.claude-accounts/` and never adds it to claude-swap; adding it would copy the login, which dies
the first time the original renews.

## Fix

After claude-swap's list, the reader reads every signed-in home Concierge keeps that claude-swap does
not list, from that home's own login (the same read it already used when claude-swap's copy was dead).

## Acceptance scenario

- **Seed:** a Claude account signed in through Accounts, not present in claude-swap.
- **Action:** the next usage reading.
- **Expected:** the account appears in the readings and in Accounts with its windows.
- **Replayable offline:** no (needs a real signed-in Claude login)
