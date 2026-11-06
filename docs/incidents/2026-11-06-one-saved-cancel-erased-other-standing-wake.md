---
failure: Canceling one saved follow-up erased another queued follow-up in the same standing agent session.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# One saved cancellation erased another standing-agent wake

## What was seen

The Concierge repair agent held two one-time saved turns. One was a November 9 follow-up
for the open PR #632 request. The other was a same-day check of a Grafana recovery alert.
At 18:42 UTC, the agent cancelled the Grafana check by its exact turn ID, but the PR #632
turn was also cancelled. Its requester received a failure saying the work did not finish.
The live ledger showed both turns ended at the same instant with the same cancellation text;
the agent's command named only the Grafana turn.

## Cause

The saved-work drop path selected the requested turn, then updated every queued turn in
its session and every cancelled input receipt in that session. Standing agents legitimately
hold multiple unrelated queued turns, so session identity was too broad for this action.

## Fix

The drop path now changes only the named queued turn and its accepted input receipt.
Repeating schedules continue to use their own recorded root and firing identity to stop
future firings. This does not revive a turn already cancelled by the old path; the PR #632
follow-up must be scheduled again after installation.

## Acceptance scenario

- **Seed:** The existing Concierge repair session has a queued PR #632 one-time wake and a
  separate disposable future wake.
- **Action:** Cancel the disposable wake by its exact saved turn ID.
- **Expected:** The disposable wake and its receipt are cancelled; the PR #632 wake remains
  queued in the same bound session, with its original future time and an open request.
- **Replayable offline:** yes, in an isolated saved-work ledger. The live acceptance uses the
  installed owner because agent-run ledger tests are disabled by Tejas.
