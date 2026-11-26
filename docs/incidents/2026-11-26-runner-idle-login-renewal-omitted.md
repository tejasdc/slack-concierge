---
failure: An idle Claude account's token expired on the runner without renewal, and unreadable accounts were omitted from the usage report.
date: 2026-11-26
fix_commits: []
cause_status: confirmed
---

# Runner idle-login renewal omitted and unreadable accounts vanished from usage report

## What was seen

On November 26 at 05:00 UTC, `tejas@chann.app` was absent from the Claude usage report. Its home held a valid refresh token and a credential written at 20:55 UTC, but its access token had expired at 04:55 UTC. An expired access token returned 401 Unauthorized from Anthropic's usage endpoint. The account was not renewed for over an hour, and vanished completely from `sessions usage` output and forecasts rather than appearing as unreadable. Consequently, the foreground protection pool for banked work did not count the account, holding banked work back.

## Cause

1. The runner's usage reader (`runner-provider-account-readings.ts`) read `accessToken` directly from `.credentials.json` without verifying whether the token was expired, and had no renewal mechanism. When Anthropic returned 401, it cached failure for five minutes and never invoked Claude Code's local `/usage` command. The server's idle renewal in `claude-account-facts.ts` was bypassed because account custody ran on runner `ax41`.
2. When an account's reading failed or had no windows, `provider-usage-forecast.ts:usageSignal` only included accounts in `accountsWithRoom` and fresh window forecasts in `forecasts`. It did not surface unreadable or stale accounts, causing unreadable accounts with existing sign-ins to vanish entirely from `sessions usage`.

## Fix

1. In `runner-provider-account-readings.ts`, added `liveAccessToken` and `renewClaudeHomeForUsage`. When an account's access token is expired or expiring within 60 seconds (or upon a 401 response) and its refresh token is valid, Claude Code's local `/usage` command is spawned with `CLAUDE_CONFIG_DIR=<home>` with backoff and deduplication, renewing `.credentials.json` without model tokens.
2. In `provider-usage-forecast.ts:usageSignal`, every known account is now surfaced in `accounts` with its status (`current`, `old`, `unknown`, or `unreadable`), alongside explicit `unreadableAccounts` and `unreadable` arrays identifying accounts that need attention rather than omitting them.

## Acceptance scenario

- **Seed:** A runner Claude home has an expired access token and a valid refresh token.
- **Action:** A provider account reading pass runs, followed by `sessions usage`.
- **Expected:** The runner triggers local `/usage` renewal to refresh `.credentials.json` and fetches fresh windows; if a read fails, the account remains visible in the usage report with `status: "unreadable"` and appears in `unreadableAccounts` rather than vanishing.
- **Replayable offline:** yes (`bot/scripts/runner-provider-account-readings-fixture.ts`).
