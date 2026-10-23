---
failure: An obsolete phone question remained in Needs attention after fresh logs answered it.
date: 2026-10-23
fix_commits: []
cause_status: confirmed
---

# Obsolete phone question stayed in Needs attention

## What was seen

At 21:31 UTC the update-flow agent in `concierge:7105` declared `needs_you` for
`request:037208aa-7255-4193-bd02-04915b6333d2`, asking Tejas what his phone showed.
Fresh phone logs then arrived. At 21:41 UTC the owner still returned the exact outcome
event `turn_outcome:action:74672801-8a79-4331-b154-2a3e63012957` in its open set
with `needsAttention:true`; another read at 21:52 UTC showed it unchanged. The
agent could not replace its declared outcome, and no topic question existed to settle.

## Cause

The one-outcome-per-turn rule correctly preserved the original declaration, but the
owner had no separate command to retire an obsolete open question. Dismissing it on
Tejas's behalf would have lost the reason the agent no longer needed his answer.

## Fix

The asking session or Inbox router may name one exact open `needs_you` event and a
reason from an admitted run. Concierge keeps the declaration, atomically removes
that one question from the open set, and retains a withdrawal event and a bounded
visible reason. Retries use the original action ID; other sessions and stale event
IDs are refused. thnkr.ing reads the owner's open set and shows the withdrawal in
the session after later turns.

## Acceptance scenario

- **Seed:** A session has one declared `needs_you` whose event is still in its open set; another open question, if present, has a different event ID.
- **Action:** The asking session or Inbox router withdraws that event with an exact ID, a stable action ID, and a reason; retry the same action, then try a new action ID on the retired event.
- **Expected:** The first call records one withdrawal and removes only the named need; the retry returns the first receipt; the new action is refused. Needs attention reflects any other open questions, the original declaration remains in history, and the session shows the reason through later turns.
- **Replayable offline:** no (the requested acceptance uses the retained production flag and installed thnkr.ing view; no isolated owner fixture is provided by this repair).
