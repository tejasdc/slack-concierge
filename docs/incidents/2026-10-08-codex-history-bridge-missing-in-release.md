---
failure: After an update, opening a Codex conversation's history failed because the history worker could not find the Codex bridge in the installed release.
date: 2026-10-08
fix_commits: [562e3ee5]
cause_status: confirmed
---

# Codex history pages failed in the installed release

## What was seen

The release installed on the morning of 2026-10-08 failed every Codex history page, even though the
candidate's file-set verification had passed. Codex conversations could not be read in thnkr.ing.

## Cause

Confirmed from 562e3ee5 (DEPLOYMENT-REPAIR.md). Provider history page projection had just moved into a
separate worker sealed in the application release (bcea78e8, c4508c24). The Codex app-server bridge is sealed
at `bot/src/codex-app-server-bridge.mjs` under the application root, but the history worker lives under
`control/application/` and resolved the bridge beside its own bundle, a path that does not exist. The release
gate checked only that the file was present in the artifact, not that the worker could load it.

## Fix

562e3ee5: `codex-app-server-client.ts` and `release-worker.ts` resolve the bridge from the immutable
application root for both the owner and its history worker. New `bot/scripts/sealed-codex-history-bridge.ts`
builds a real candidate, runs its bundled history worker on scratch state with a deliberately absent Codex
socket, and proves the bridge executes before the expected socket error;
`deployment-application-check.ts` performs the same resolution and execution before activation.

## Acceptance scenario

- **Seed:** a built release artifact with the history worker under `control/application/`.
- **Action:** run the bundled history worker for a Codex session against scratch state with no Codex socket.
- **Expected:** the bridge module loads from the application root and the worker fails only with the expected
  socket-unavailable error (not a module-not-found error); the preactivation check refuses an artifact where
  it cannot.
- **Replayable offline:** yes (scratch build and state; no live Codex needed)
