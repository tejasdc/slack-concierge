---
failure: Concierge's release safety gate timed out because its packaged controller had no fixture owner socket to answer a last-known-good read.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# Release safety fixture waited for an owner it had not started

## What was seen

Twice in an isolated Concierge worktree, the database safety fixture expected a missing-release
result but the packaged release controller retried `/internal/deployment-last-known-good` until
the fixture's three-second child deadline. Its stderr named `FailedToOpenSocket`. The affected
source bundled, but the full build gate could not finish.

## Cause

The fixture mounts a temporary database at Concierge's canonical path so the packaged controller
takes the same live-entrypoint path as an installed release. That path deliberately sends
last-known-good reads to the serving owner instead of opening SQLite in the controller. The
fixture created the database and held its writer, but never started an owner socket in its
temporary state directory. The timeout was a fixture setup defect, not evidence that the
installed owner refused a request.

## Fix

Start a scratch owner socket for the packaged-controller assertion. It returns the expected
missing-release result only for the exact read endpoint. Assert that the read reached this
socket while the separate database writer remains held. Keep the direct read, packaged writer,
live-entrypoint and private database isolation checks.

## Acceptance scenario

- **Seed:** A temporary empty release ledger, a separate connection holding its writer, and a
  packaged release controller that sees the ledger at the canonical path.
- **Action:** Run its last-known-good read through the fixture's scratch owner socket.
- **Expected:** The controller reports a missing release within the child deadline and the
  fixture records exactly one GET of the owner endpoint. Without the socket, the original
  three-second timeout remains reproducible.
- **Replayable offline:** yes (the owner socket and database are both temporary).
