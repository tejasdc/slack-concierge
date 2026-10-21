---
failure: While every Claude account was out of usage, the line under Tejas's waiting message said "the last attempt failed" instead of saying it was waiting for the reset.
date: 2026-10-08
fix_commits: [b0a30043]
cause_status: confirmed
---

# A usage hold was shown as a failed retry

## What was seen

At 6:06 AM on 2026-10-08, during a usage hold, Tejas read "Retrying - The last attempt failed ... (tried 1
times so far)" under his message, while a notification said the same message waited until 6:20. Other waiting
statuses referred to "the time below", which the app never shows.

## Cause

Confirmed from b0a30043. The receipt status in `session-owner.ts` classified a usage hold by matching the
error's wording (`/\busage (?:is|for)\b/` and `/exhaust/`). The multi-account dispatcher throws "Every
available Claude account is out of room.", which matched neither pattern, so the status fell through to the
generic `RETRY_SCHEDULED` text. Status messages also relied on a separate time field the app does not render.

## Fix

b0a30043: the hold is recorded on the turn when it is decided: new column `turns.dispatch_hold='usage'`,
written by `retryRunningTurnAfterProviderFailure` from `heldUntilMs` (`turn-execution.ts`, `state.ts`). The
status reads that column, not the wording, and says "Every Claude account is out of usage until <time>". Usage
holds, other retries, scheduled work and chosen-time continuations carry their time in the sentence, in his
time zone (`noticeTime`); a scheduled item with no known start says nothing.

## Acceptance scenario

- **Seed:** a queued human input whose turn was held after every Claude account refused with the current
  dispatcher wording, next attempt at a known instant.
- **Action:** read the input's receipt.
- **Expected:** code `PROVIDER_USAGE_HELD`, message naming the product and the local time it resumes; never
  "The last attempt failed".
- **Replayable offline:** yes (scratch ledger rows)
