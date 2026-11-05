---
failure: An idle Claude account with weekly room appeared unreadable while its access token had expired, so work could not move to it.
date: 2026-11-05
fix_commits: []
cause_status: best-explanation
---

# Renewed Claude login stayed unreadable

## What was seen

On November 5, the server showed `hey@tejas.nyc` with its last successful Claude usage reading from November 4 at 17:51 UTC. That reading showed 62% weekly use, but its five-hour window was spent and the reading was stale. The account's own credential was renewed at 06:29 UTC on November 5. A direct, read-only request to Anthropic's usage endpoint with that credential succeeded at 06:33 UTC and showed 63% weekly use. Concierge recovered a current reading at 06:35 UTC without this change. The personal Claude account had reached 100% weekly use during the stale interval.

## Cause

The account's access token expired while the home was idle. The own-login reader deliberately refuses an expired token and does not renew it; that belongs to Claude Code. The account chooser correctly refused to infer current capacity from stale data, but could not move work to this home while its room was unknown. The reader also backs off for up to thirty minutes after failed reads, keyed only by account address. The source of the 06:29 renewal has not been established, and no live trace proves that this account would otherwise have remained idle indefinitely.

## Fix

The repair has two parts. When the reader sees an expired access token and a saved renewal key, it starts Claude Code's local `/usage` command in that account's own home. A live probe of this command on an expired account renewed its credential and returned with zero model tokens and zero model cost; it took 88 seconds. The command runs asynchronously and has a bounded lifetime. Concierge still never copies, refreshes or logs the credential itself. The retry schedule also records the credential file's inode, modification time and size; after Claude renews it, the next usage pass reads the new allowance rather than waiting through the old failure backoff. Ordinary unchanged credentials retain pacing.

## Acceptance scenario

- **Seed:** a Claude home has a saved renewal key, an expired access token, and a stale usage reading that last showed weekly room; another home is nearly spent.
- **Action:** the next usage pass starts Claude Code's local renewal, then another usage pass occurs.
- **Expected:** a current reading for the renewed account is shown and ordinary dispatch may choose its proven home; no model turn is charged for renewal.
- **Replayable offline:** no (requires a real Claude login and Anthropic's usage endpoint).

A fresh usage reading alone does not establish that an already running process changed account; account choice happens at turn dispatch. At 06:39 UTC the `hey@tejas.nyc` home was proven launchable by the installed system, and its usage view showed 63% weekly use.
