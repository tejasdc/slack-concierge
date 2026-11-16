---
failure: An informational note woke a working agent under information-only scope and stranded its open work request.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# An informational note stranded open work

## What was seen

The Inbox router reported that the worktree cleanup agent held an open work request,
then received an informational note lifting a release hold. The next turn opened from
that note. Concierge refused the agent's work delegation and refused the router's
attempt to send work steering from its own informational turn. The exact report is
`capture:83c15eaad4e21d397f4e5dec4c73964d303a8091b2843861011af825c29edc7e`.
The router later sent a separate work request; the original work was finished. That
recovery did not repair the scope rule.

## Cause

Concierge checked only the input that opened the current turn. It did not consider
an earlier work request still assigned to the same session. A work delegation from
the informational turn therefore appeared unauthorized even though the work request
had not closed.

## Fix

For an informational wake, Concierge finds a delivered, still-open work request
held by that session. It uses that exact request as the authority for new work while
retaining the waking input and current run as the action's source. The derived grant
also travels with local and peer requests so the recipient sees the original task
scope and human attribution. If several open tasks cannot be distinguished by their
thread, Concierge refuses to choose an unrelated task's authority. Closing the work
request ends this grant.

## Acceptance scenario

- **Seed:** Give an agent a work request; leave it open after its first turn. Send it an informational note that opens a later turn.
- **Action:** From the later turn, delegate part of the original work to another agent.
- **Expected:** Concierge admits one delegated request, retains the informational note as the source and the original work request as authority, and does not replay the original work. Once the work request closes, another delegation from that informational turn is refused.
- **Replayable offline:** yes (the native communication fixture; agent-run tests are currently disabled by project policy).
