---
failure: Standing roles selected a newer neighboring session in the same agent folder instead of their own session.
date: 2026-10-29
fix_commits: []
cause_status: confirmed
---

# Standing role selected a neighboring session

## What was seen

The journal keeper's folder held the keeper at `concierge:4571` and a newer scheduled daily
review at `concierge:4572`. The role lookup selected 4572. The messaging agent's folder held
the agent at 3912 and newer reminder and watch sessions through 7514; the lookup selected
7514. The Inbox folder also held audit sessions, and the thread reader folder held two
sessions with the same title. These are live session facts supplied in the review finding;
no misdelivered journal observation or repair notice was reported.

## Cause

The role lookup used folder membership and descending session number. A folder can hold
several different jobs, so recency did not identify which session owned the standing role.

## Fix

The session holds an explicit standing-role binding. The owner accepts a binding only when
the session is in that role's declared folder, clears any earlier holder of the same role,
and resolves only a non-archived bound session in that folder. Role-based creation records
the binding with the new session. The agent command can move it to an existing session.
The agent list shows roles without a binding. Until those existing roles are bound, journal
observations use the known keeper at 4571 and repair notices use the exact-title repair
session in its agent folder; neither service selects the newest neighbor.

## Acceptance scenario

- **Seed:** In the journal keeper folder, create an unbound keeper session and a newer scheduled review session. In another role's folder, create two sessions, bind the older one, and retain a newer unbound neighbor.
- **Action:** Resolve both roles, bind the keeper to its exact address, then bind it to a session outside the keeper folder using a new action ID.
- **Expected:** Before binding, the journal observation chooses the known keeper while the role list says unbound. After binding, role resolution chooses the explicitly bound session despite newer neighbors. The outside-folder binding is refused and the prior binding remains. Repeating the accepted binding action does not move it again.
- **Replayable offline:** yes (with an isolated owner ledger and registered agent folders).
