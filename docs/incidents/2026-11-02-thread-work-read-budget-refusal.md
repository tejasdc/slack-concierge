---
failure: Thread Work returned a 503 after batched request reads were installed.
date: 2026-11-02
fix_commits: []
cause_status: confirmed
---

# Thread Work read budget refusal

## What was seen

The installed owner route for the canvas thread's Work pane returned `READ_BUDGET_EXCEEDED` with reason `unbounded_collection` immediately after the cancellation-attribution release.

## Cause

The batch used three collection reads without a trailing SQL `LIMIT`. The serving read gate rejects every collection read without that syntactic bound, even when an `IN` set contains only the current page's 20 request identities. The previous growth fixture covered the key reader but never exercised these enrichment reads.

## Fix

Put a page-sized `LIMIT` on each of the two request reads and the canceled-source read. Keep those reads in one pure module and exercise the same functions in the thread-coordination growth fixture against unrelated request counts of 100, 1,000 and 10,000 under the runtime budget.
Project only the short summary and an at-most-8-KiB request preview, and only short activity text,
before the read budget counts bytes. The exact full text remains in the request receipt. The
growth fixture uses large retained briefs and activity bodies to refuse an accidental full-body read.

## Acceptance scenario

- **Seed:** A thread page with handoffs, including a canceled internal upkeep request, on the installed release.
- **Action:** Read the Work coordination route through the owner socket.
- **Expected:** HTTP 200; the canceled upkeep is absent, ordinary handoffs and suggestions remain, and an attributable canceled human request carries its actor. The bounded-growth fixture passes.
- **Replayable offline:** yes, through the thread-coordination growth fixture.
