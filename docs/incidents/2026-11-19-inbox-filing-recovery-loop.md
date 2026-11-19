---
failure: The repair agent kept receiving notices for a capture that was already filed.
date: 2026-11-19
fix_commits: []
cause_status: confirmed
---

# Repeated Inbox filing recovery notices

## What was seen

After a capture was filed, the repair agent received successive recovery notices
with an additional `:filed` suffix each time.

## Cause

Inbox upkeep scanned the same key range for alerts and their recovery notices.
A recovery had no matching overdue capture, so upkeep settled it as if it were
an alert. If it had reached the repair agent, settlement emitted another
recovery. If it had yet to be delivered, settlement suppressed it.

## Fix

Upkeep excludes the recovery suffix from the active alarm scan. Delivery skips
existing duplicate recoveries while preserving their records in the ledger.

## Acceptance scenario

- **Seed:** an overdue Inbox capture and mark its repair alert delivered.
- **Action:** file the capture, deliver its recovery, and run upkeep again.
- **Expected:** the first recovery is available once. An old duplicate awaiting
  delivery is skipped, and an old delivered duplicate generates no further notices.
- **Replayable offline:** yes, through the Inbox filing fixture.
