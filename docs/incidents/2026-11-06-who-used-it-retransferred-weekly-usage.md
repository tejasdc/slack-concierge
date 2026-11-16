---
failure: Who used it failed after repeatedly fetching a full week of raw usage calls from the runner.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# Who used it could not finish a refresh

## What was seen

The background report failed at least twice with `PROVIDER_USAGE_BREAKDOWN_PAGE_LIMIT`, each
after about 18 minutes 53 seconds. The runner cache held 418,214 one-week sequence records.
The live allowance check was refreshing and allowing Codex requests during this failure.

## Cause

Every five-minute report refresh asked the runner to send the entire one-week record snapshot
in pages of at most 100. The 1,000-page guard was reached before the snapshot could finish.
The report read had used a raw-record transfer primitive for a question answered by a summary.

## Fix

The owner now sends only its relevant one-week attribution facts to each runner. Each runner
computes the report beside its incremental transcript cache and returns a compressed summary.
The owner combines runner reports and publishes only after all configured runners answer.
The cache diagnostics, account and session attribution, and separate allowance path remain.

## Acceptance scenario

- **Seed:** Two runner caches with more than 100,000 recent usage calls, and owner session and account facts for their conversations.
- **Action:** Refresh Who used it.
- **Expected:** One bounded report call per runner returns the complete account/session shares and cache diagnostics, with no raw-record page calls. A missing runner leaves the previous published report and timestamp intact. The live allowance and Codex dispatch checks still work separately.
- **Replayable offline:** yes (the runner report fixture covers attribution and volume; the installed release requires separate live checks).
