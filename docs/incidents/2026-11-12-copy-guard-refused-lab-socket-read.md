---
failure: The machine copy guard refused the Lab nightly preflight because its script named Concierge's request socket and reserved its own feature-trail database with BEGIN IMMEDIATE.
date: 2026-11-12
fix_commits: []
cause_status: confirmed
---

# A request-socket path was mistaken for the live ledger

## What was seen

Request `86eb9d58-3006-458b-8e7a-14604d981316` from `concierge:9547`: the guarded runner refused `python3 scripts/expertise-nightly.py preflight` in agent-ecology. The script reads session views over `/root/.local/state/concierge/requests.sock` and separately opens the project's own feature-trail database read-write, takes `BEGIN IMMEDIATE` to fence the trail collector, and rolls back. It never opens or copies a Concierge database.

## Cause

The guard first asks whether a command (or a script it runs) names a live store, then whether it contains a copy or rehearsal marker. Any path inside the state directory counted as naming a live store, including the request socket. `BEGIN IMMEDIATE` is a rehearsal marker. Two unrelated facts in one script were joined into "copies the live ledger".

## Fix

Before the live-store check, the guard drops path tokens ending in `.sock` unless they resolve to an existing file that is not a socket. A socket is the owner's supported read entrance and holds nothing that can be copied. A database renamed or hard-linked to a `.sock` name is still a regular file and still counts; any real database path beside the socket keeps every refusal.

## Acceptance scenario

- **Seed:** Install the candidate guard on the server.
- **Action:** Through the machine command wrapper, run a script that names `requests.sock` and runs `BEGIN IMMEDIATE` on a non-Concierge database; then a script that names the socket and runs `BEGIN IMMEDIATE` on the live ledger; then `cp` of the live ledger to a `.sock` destination.
- **Expected:** The first passes; the second and third are refused.
- **Replayable offline:** yes (`bot/scripts/database-safety-fixture.ts` covers the policy, including a hard-linked `.sock` disguise).
