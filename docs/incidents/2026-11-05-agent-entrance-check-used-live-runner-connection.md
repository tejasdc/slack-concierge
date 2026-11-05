---
failure: The isolated agent entrance check sent its scratch token to the live runner address and failed the build.
date: 2026-11-05
fix_commits: []
cause_status: confirmed
---

# An isolated entrance check reached the wrong owner

## What was seen

On November 5 the guarded local build failed its agent entrance check. The
synthetic network owner accepted direct calls, but the client call returned
401 AGENT_UNAUTHORIZED.

## Cause

The check inherited the current session's runner connection file. The client
correctly preferred that live address over the fixture's synthetic address,
then sent the fixture's scratch token to the live owner.

## Fix

Clear the inherited runner connection setting inside the fixture before its
client call. The application keeps its production rule of rereading the
runner's current connection on each request.

## Acceptance scenario

- **Seed:** An agent shell with a live runner connection setting.
- **Action:** Run the isolated agent entrance check through the private code entrance.
- **Expected:** Direct and client calls reach the fixture's synthetic owner;
  invalid tokens are refused; the check passes without opening the live ledger.
- **Replayable offline:** yes.
