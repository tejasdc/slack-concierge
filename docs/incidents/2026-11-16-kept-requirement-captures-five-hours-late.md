---
failure: Captures kept in a requirement record showed times five hours later than he made them
date: 2026-11-16
fix_commits: []
cause_status: confirmed
---

# Kept requirement captures showed times five hours late

## What was seen
On the Thread options requirement record, capture 7a425975 (ledger 2026-11-16 07:17:34 UTC) was kept
with 2026-11-16T12:17:34Z, and capture a0ce4e2b (22:47:47 UTC) with 2026-11-17T03:47:47Z.

## Cause
`requirements keep` sent the ledger's `created_at`, SQLite CURRENT_TIMESTAMP: UTC written without a
zone. thnkr.ing's server runs in America/New_York, and `new Date("2026-11-16 07:17:34")` there reads
New York time, giving 12:17:34Z.

## Fix
keep and file send ledger times as ISO UTC (`ledgerUtcAsIso`), and thnkr.ing now refuses a
zone-less requirement time instead of guessing; keeping a kept capture again with a different
time corrects it.

## Acceptance scenario

- **Seed:** a requirement record and a capture whose ledger time is "2026-11-16 07:17:34".
- **Action:** `router-actions.sh requirements keep <record> --from capture:<id>`.
- **Expected:** the kept source's sourceAt is 2026-11-16T07:17:34.000Z; a direct POST with a zone-less sourceAt answers 400 REQUIREMENT_TIME_ZONE.
- **Replayable offline:** no (needs thnkr.ing's capability socket)
