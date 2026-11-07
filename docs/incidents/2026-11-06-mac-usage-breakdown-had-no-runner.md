---
failure: The Mac's Who used it report stopped refreshing because its local sessions had no provider runner.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# Mac Who used it showed an old report

## What was seen

The Mac Concierge logged `usage_breakdown_refresh_failed` 697 times from November 6
06:30 UTC through November 7 03:27 UTC. Its per-session usage read answered HTTP 200
with a report last computed at November 6 06:24 UTC. Current Codex, Claude and
Antigravity account allowance readings continued independently.

## Cause

The report reader changed to collect transcript usage from provider runners. The Mac
peer still runs native provider sessions locally and has no configured runner. Its
background refresh called the runner-only reader, which refused every attempt with
`NO_PROVIDER_USAGE_RUNNERS_CONFIGURED`; the response path kept serving the old shared
report without marking it stale.

## Fix

The no-runner Mac peer scans its existing local Claude and Codex transcript trees and
joins them to its own bounded session ledger snapshot. Configured owners keep the
runner report path. A report older than fifteen minutes carries an explicit stale
flag while refresh is pending or failed. Provider allowance checks and turn admission
do not use this report.

## Acceptance scenario

- **Seed:** A Mac peer with a local native provider session and transcript, no provider runner, and an old published usage report.
- **Action:** Refresh Who used it, then read it again.
- **Expected:** The local session appears in a newly computed report without a runner error; the result is marked stale only while its published copy is older than fifteen minutes. A non-Mac owner with no runners still refuses to scan, and a configured owner still uses runner reports.
- **Replayable offline:** yes (the Mac peer fixture runs with a synthetic local ledger and transcript; the runner report fixture keeps the configured path).
