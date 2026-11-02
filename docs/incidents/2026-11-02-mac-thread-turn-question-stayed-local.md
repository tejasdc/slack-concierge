---
failure: A Mac agent could finish Inbox thread work waiting for Tejas without asking him in that thread.
date: 2026-11-02
fix_commits: []
cause_status: confirmed
---

# A Mac agent's turn question stayed on the Mac

## What was seen

The Uber Eats agent's request for a photo reached no device. The server's thread filing was
repaired separately, but the same end-of-turn question from a Mac agent still could not reach
the Inbox thread. A Mac `needs_decision` reply did reach that thread.

## Cause

The Mac retained its `needs_you` turn outcome in its own session record. Its peer channel
forwarded replies and execution status to the server, but not that outcome. The server alone
owns the Inbox thread and its alert.

## Fix

The Mac retains the declared question beside the exact peer request and forwards it through
the existing peer reply channel. The server checks that the request came from an Inbox thread
and files the question there with the existing once-per-ask decision rule. The event identity
survives retry and the retained peer status allows recovery after a missed push.

## Acceptance scenario

- **Seed:** A marked Inbox thread sends work to a Mac agent. The agent has the delivered request and the server has its thread root.
- **Action:** The Mac agent declares `needs_you` at the end of its turn, after a failed or partial reply.
- **Expected:** The same thread shows one agent question and one blocking decision alert. Repeated peer delivery and a same-run `needs_decision` reply create no second ask.
- **Replayable offline:** no (the accepted result requires the installed Mac and server peer path and the live Inbox notification surface).
