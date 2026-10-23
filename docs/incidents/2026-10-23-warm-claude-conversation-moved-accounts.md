---
failure: A Claude conversation moved to another subscription account while its prompt cache was still warm and rewrote its context.
date: 2026-10-23
fix_commits: []
cause_status: confirmed
---

# Warm Claude conversation moved accounts

## What was seen

The installed cache report found 133 Claude calls with an account change and 68.2 million
rewritten input tokens in the preceding 48 hours. In its listed recent calls, all 14 account
changes within 50 minutes of the preceding call were cold. These figures show the scale of
account-change coincidences; other changes may contribute to individual rewrites.

## Cause

Concierge ranked ordinary turns by how fast each account's weekly allowance would lapse.
The previous account only broke ties, so a conversation could move even while its account
had room and its one-hour prompt cache was warm. Anthropic isolates prompt caches between
organizations; separate subscription accounts cannot read each other's cached prefix.

## Fix

The session owner records the latest real Claude response's account and receipt time.
The next ordinary turn first tries that account while its conversation prefix is eligible
and the account has room, using the existing last-good-reading rule if a usage reading
has gone stale. Explicit new account selection and banked work keep their priority.
A confirmed usage refusal excludes the account; cold conversations still use weekly
allowance lapse pressure. The choice reason remains on the turn for diagnosis and is
not announced to Tejas.

## Acceptance scenario

- **Seed:** A conversation last called Claude on account A 30 minutes ago and cached its input. A's last good reading shows room but is now stale. Account B has a fresh reading with room and higher weekly allowance lapse pressure.
- **Action:** Dispatch the conversation's next ordinary turn.
- **Expected:** It runs on A and records warm-cache affinity as the choice reason. If A instead has a cached usage refusal, it runs on B. A banked turn remains bound to its saved account, and a fresh manual account choice wins once.
- **Replayable offline:** yes (the chooser and room evidence can be supplied without provider credentials).
