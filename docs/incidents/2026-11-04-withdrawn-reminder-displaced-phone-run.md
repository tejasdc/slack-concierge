---
failure: An unused automatic reminder replaced the phone agent's completed work with a Canceled zero-second status.
date: 2026-11-04
fix_commits: []
cause_status: confirmed
---

# Withdrawn reminder displaced the phone agent's run

## What was seen

The phone agent's session showed “Canceled · 0s” after it answered a question and
continued working. Tejas could not tell who canceled what or why.

## Cause

Concierge queued an automatic question reminder. The answer arrived before the
reminder reached the provider, so the owner withdrew it. The retained turn
recorded “Answered before this reminder was delivered.” The session's latest-run
projection chose the newest turn ID, including that canceled, unstarted reminder,
ahead of the real agent run, which later completed. The session surface had no
cancel actor or reason in its presence contract.

## Fix

The owner's shared session-presence rule excludes service inputs canceled before
provider admission from visible latest-run selection, including this reminder. It
also excludes empty turns whose input joined a running agent, the other observed
source of the same zero-second label.
The canceled turn remains in the ledger. Genuine cancellations carry an actor
and reason through exact views, prepared cards and the browser's shared presence
cache. The human Stop and queued-message paths now retain their reasons at the
turn boundary; older missing reasons are stated as missing.
An agent canceling saved work retains its session address as the actor instead
of being mislabeled as Tejas.

## Acceptance scenario

- **Seed:** A session has an agent run and an automatic question reminder queued
  afterward. The agent answers the question before provider admission for the
  reminder, and the reminder is withdrawn.
- **Action:** The agent run completes; read the session card and open session.
- **Expected:** Both show the real completed run and its duration. The unused
  reminder remains in retained history but never shows as a zero-second
  cancellation. For an actual canceled run, both surfaces name the actor and
  reason, including an explicit missing-reason statement for older records.
- **Replayable offline:** yes (seed the turn and accepted-input records in an
  isolated owner ledger and read the shared presence projection).
