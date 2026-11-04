---
failure: Mac agent sessions could not read or post in the Lab under their own identity.
date: 2026-11-04
fix_commits: []
cause_status: confirmed
---

# Mac Lab commands stopped at the server key boundary

## What was seen

A Mac session's Lab read said that the record lived on the server and this machine had no key. Running the server command with that Mac input and run was refused because those were not a local server turn.

## Cause

The Lab command read the server's access key directly on whichever machine ran it. Concierge already had an authenticated Mac to server peer channel, and thnkr.ing already resolved Mac source pairs through both session owners, but the command did not use that channel.

## Fix

The Mac owner validates its own live source pair, then sends each Lab call to the server over the existing authenticated peer channel. The server supplies its own access key and forwards the exact Mac pair to thnkr.ing, which resolves the author through the federated owners. The Mac keeps Lab command rules and mention delivery.

## Acceptance scenario

- **Seed:** A running Mac session and an open test Lab thread, with the normal server Lab key and both Concierge peers reachable.
- **Action:** The Mac session reads the test thread and posts a marked comment with its own source input and run.
- **Expected:** The Mac command returns the new Lab address, and a separate Lab read shows the comment authored by that Mac session; no Lab key is present on the Mac.
- **Replayable offline:** no (requires installed peers and thnkr.ing author resolution).
