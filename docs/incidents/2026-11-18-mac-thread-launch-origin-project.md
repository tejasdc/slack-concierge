---
failure: New Mac sessions for Inbox threads rejected projects registered on the Mac.
date: 2026-11-18
fix_commits: []
cause_status: confirmed
---

# Mac project rejected by the server runner

## What was seen

Request 8db18e29-ef2b-4da0-b87b-b0334559d8fa carried report
capture:e7451e8eba6eaa0a7ac8fd9581f0b4e9b7e21e2d339391885eb3b9f4a91a45bd.
The pinned Inbox router reproduced the installed refusal on November 18:
runner ax41 could not resolve device-lab, although the Mac project catalogue listed
/Users/tejasdc/workspace/device-lab. Nothing was admitted by that failed attempt.

## Cause

The shared ask path prepared the requested project on the originating owner's
configured runner before dispatching a peer request. The peer receiver already
resolves its project through its own session creation boundary. A Mac-only project
therefore failed the redundant server lookup before reaching the Mac.

## Fix

Skip origin project preparation for peer requests. Preserve project, source and
thread identity through the existing peer transport. The destination still refuses
unregistered projects. No retry, fallback project or Inbox router move is added.

## Acceptance scenario

- **Seed:** A Mac registered project absent from the server registry; an admitted
  Inbox source and marked test thread.
- **Action:** Start a new Mac session in that project for the test thread and have
  it report its machine and working directory, then reply completed.
- **Expected:** The Mac session starts in its registered project and its answer
  appears in the named thread. Local launches still resolve locally.
- **Replayable offline:** yes (origin lookup boundary in the frozen ask fixture;
  actual Mac execution and thread presentation additionally require live acceptance).
