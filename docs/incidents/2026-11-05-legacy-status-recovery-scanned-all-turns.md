---
failure: A thread action waited while Concierge scanned every retained turn to find no pending historical statuses.
date: 2026-11-05
fix_commits: []
cause_status: best-explanation
---

# A thread read waited behind an empty historical status scan

## What was seen

On November 5 at 09:44:32 UTC, a thread read confirmed 3.97 seconds after the
browser action. Concierge logged 3,235 ms of owner-loop lag, of which 3,215 ms
was a synchronous status-projection query. Its installed stack pointed to the
minute recovery pass. The command completed and its event reached the browser
98 ms after owner settlement. The delayed part preceded worker processing.

## Cause

The recovery query filtered for pending statuses but had no matching index. The
production query plan scanned all 22,302 retained turns, although zero had a
pending status. Its overlap with the command delay supports this as the cause
of that action's pre-processing wait; the storage stall's deeper cause is not
known.

## Fix

Index pending statuses by turn ID. The existing recovery pass still applies
its historical eligibility filter and retries genuinely pending statuses.
An empty pass now traverses an empty index rather than accumulated history.

## Acceptance scenario

- **Seed:** More than 22,000 retained turns and no pending historical statuses.
- **Action:** Run the minute recovery pass while accepting a thread action.
- **Expected:** The status lookup uses the pending index, returns no rows, and
  does not delay the action's owner admission by scanning retained turns.
- **Replayable offline:** yes (query plan and returned rows; live owner timing
  still requires an installed check under its actual storage load).
