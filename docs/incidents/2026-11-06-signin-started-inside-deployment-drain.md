---
failure: A Claude sign-in began during a server release and its runner was restarted before the approval code could be filed.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# A release cut off a valid Claude approval

## What was seen

The Mac browser worker reached Claude's approval page as `tejastej.dc@gmail.com`, pressed Authorize once, and received a code. The server runner logged the Claude sign-in as awaiting that code at 18:30:45 UTC. At 18:30:46 UTC the release restarted that runner. The worker's code submission then found no live sign-in and the server account remained signed out. This was a machine restart, not a rejected browser approval.

## Cause

The deployment drain includes pending sign-ins in its active-work check, but a runner sign-in could start after the drain had claimed its gate and passed its check. The sign-in start wrote its pending row without first checking that gate. The release and sign-in therefore crossed after the safety decision.

## Fix

Runner sign-in admission now reserves its pending row in the same ledger transaction that checks the deployment gate, before it starts the provider CLI. If the release claimed first, no sign-in begins and Accounts explains that the machine is updating. If the sign-in reserved first, the release drain sees the pending row and waits. The runner's existing operation identity and pending-row cleanup remain in use.

## Acceptance scenario

- **Seed:** A server release is preparing to drain while a Mac browser worker starts a server Claude sign-in.
- **Action:** The release claims its gate and the sign-in reserves its operation in either order.
- **Expected:** The release wins and no sign-in CLI starts, or the sign-in wins and the release waits for it. A code is never offered for a runner process that the same release then stops.
- **Replayable offline:** the SQLite admission ordering can be replayed; the actual browser approval and runner restart require the installed machines.
