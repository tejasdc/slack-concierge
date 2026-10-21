---
failure: For about nine hours after Pause all shipped, any agent turn on the server could be cancelled the moment one of its tools finished, with nobody pressing Stop.
date: 2026-10-14
fix_commits: [792e2f41]
cause_status: confirmed
---

# Agent turns were cancelled whenever a tool finished

## What was seen

Between about 03:16 and 12:04 ET on 2026-10-14, server agent turns ended as cancelled in the middle of
their work although no Stop, pause or update had been requested. The agent that built the fix confirmed
from its transcript that "the shipped code did cause the cancellations".

## Cause

2829628e (Pause all) taught `TurnCancellationController` in `bot/src/turn-dispatch-seams.ts` to stop a
turn at a safe point: `requestAtSafePoint()` waits while tools are running, and `toolFinished()` calls
`dispatch()` so the deferred stop fires once the last tool ends. `dispatch()` checked only that a cancel
function was attached, that it had not already fired, and that no tool was running. It never checked
`requested`. Every running turn has a cancel function attached, so the first tool to finish in any turn
reached `dispatch()` with no tools left running and cancelled that turn.

## Fix

792e2f41 adds `!this.requested` to the guard in `dispatch()`, so finishing a tool can only complete a stop
that Stop, Pause all or an update actually requested. A turn nobody asked to stop runs on.

## Acceptance scenario

- **Seed:** A running turn with its cancel function attached and no stop requested.
- **Action:** A tool starts and then finishes (`toolStarted`, then `toolFinished`).
- **Expected:** The turn is not cancelled. Calling `requestAtSafePoint()` while a tool runs cancels it
  only after that tool finishes, and `request()` cancels it at once.
- **Replayable offline:** yes (the controller is a plain class; no provider needed)
