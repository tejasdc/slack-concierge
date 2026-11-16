---
failure: Automatic provider choice for new work weighed each provider by one account, so three Claude accounts counted like one and a provider nearly out overall could still be picked.
date: 2026-11-16
fix_commits: []
cause_status: confirmed
---

# New work was routed as if each provider had one account

## What was seen

Tejas, Mac capture, Nov 16 (capture
`0797e5b46976742b4dac1865f4b82dd0978b668075f535a924dea287d577e0d4`): "does our system have
awareness that we have three Claude accounts and only two Codex accounts? And is it taking that
into consideration, or is it just looking at the existing usage per single account? It has to look
at aggregated usage per provider, not existing usage per single account." That night Codex had hit
100% on every account while the three Claude accounts sat at 14 to 16%.

## Cause

`chooseProviderForNewWork` took each provider's single roomiest account and spread starts in
proportion to that one account's remaining room; for Codex only the account signed in to the shared
App Server was a candidate at all. The held-work and Inbox failovers compared receivers the same
way, by one account's used percentage.

## Fix

Every candidate now carries its provider's total remaining weekly room across the accounts that
provider can run on (`providerTotalRoom`), and the spread (`pickByProviderRoom`) and both
failovers use that total. Whether a provider can start now is still decided by its roomiest
account; the in-provider account choice (lapse pressure, warm cache) is unchanged.

## Acceptance scenario

- **Seed:** Claude has three launchable accounts at 14%, 14% and 16% weekly (total room 256); Codex's signed-in account is at 14% and its kept account at 100% (total room 86). Both are below the 90% warning.
- **Action:** Choose a provider for new unbound work over many stable request identities.
- **Expected:** About three quarters of starts go to Claude and a quarter to Codex, instead of half and half. With Codex's signed-in account at 100% and no paid credits, Codex is not startable regardless of its kept account's room.
- **Replayable offline:** yes (`pickByProviderRoom` is a pure function over candidates).
