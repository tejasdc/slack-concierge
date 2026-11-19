---
failure: An Essos agent finishing an older request got a refusal when it used that request’s original turn identity.
date: 2026-11-19
fix_commits: []
cause_status: confirmed
---

# An older request’s reply was refused

## What was seen

Item 4 in the November 19 Essos bug list reported that the older request's input
and run pair was refused. The transcript of Concierge session 10113 contains the
refusal and records the current pair as the working route.

## Cause

The request identifies the obligation being answered. The reply also identifies
the actor, which must be an admitted input on a live run. The command required
the agent to supply both and gave it no default actor, so copying the identity
from the original request failed after that run ended.

## Fix

An ordinary reply can use the admitted actor supplied to its shell. The command
still carries the exact request ID and the owner checks the live actor and
recipient as before. Explicit source pairs remain available, including for an
exact retry of an accepted reply after its run has ended.

## Acceptance scenario

- **Seed:** An active session holds a request delivered on an earlier run.
- **Action:** Finalize that request using its ID and the current shell's admitted pair, with the source flags omitted.
- **Expected:** Exactly that request settles with a reply attributed to the live turn.
- **Replayable offline:** yes (command parser and native communication fixtures).
