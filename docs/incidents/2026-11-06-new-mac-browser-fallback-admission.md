---
failure: A new Mac browser fallback session was refused despite its recorded server failure.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# New Mac browser fallback request refused despite a recorded server failure

## What was seen

On November 6, a server browser reached `https://thnkr.ing` but its API returned
401, leaving the app at “Opening your local workspace.” The requesting session
sent a Mac browser fallback request with that exact URL and observation. The Mac
session accepted the work, but its isolated browser launcher exited 2. The Mac
owner returned `MAC_BROWSER_FALLBACK_REFUSED`: “No active recorded server failure
permits this Mac browser.” No browser page opened and no capture was replayed.

## Cause

The peer receiver stores the machine need inside the retained first input when it
creates a new Mac session. The Mac browser admission check read only the outer
input, which is where requests to an existing session store the need. Thus the
new-session path discarded the evidence at the final gate, even though it was
retained and visible to the agent.

## Fix

The repair reads the need from the accepted input shape selected by its kind.
The existing exact input/run, active turn, recorded failure and origin checks
remain in place. The current peer-instance runbook documents both shapes.

## Acceptance scenario

- **Seed:** A server browser has a recorded failure at `https://thnkr.ing`, and a new Mac peer session receives a browser fallback need with that URL and failure.
- **Action:** The accepted Mac input's active run invokes the isolated browser launcher.
- **Expected:** The Mac owner admits that exact run and opens only the recorded origin; a stopped or mismatched run remains refused.
- **Replayable offline:** no (the acceptance requires the installed Mac owner and isolated browser launcher).

Verification: a source build passed. The required independent review and an
installed Mac browser check remain pending; all available Claude review accounts
were out of room at the time of this change. A fresh Mac fallback request must
be sent after the reviewed change reaches the Mac release. The old failed
request must not be replayed.
