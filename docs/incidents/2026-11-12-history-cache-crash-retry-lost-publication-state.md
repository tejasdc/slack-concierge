---
failure: History cache recovery confused an interrupted publication or rollback with an unrelated cache generation.
date: 2026-11-12
fix_commits: []
cause_status: confirmed
---

# Cache publication needed byte-based recovery

## What was seen

Three disposable schedules failed on local commit 7404b909: a pre-rename intent
retry hit EEXIST; a post-rename retry reported a stale skip without completing its
verifier/result; rollback after the original-cache rename refused to finish the
sidecar. The designing session identified the rollback window after independent
review found the optional-deployment wedge. Nothing was activated in production.

## Cause

Recovery inferred progress from receipt existence and expected only the old
inode at conversion admission or only the converted digest at rollback admission.
It did not distinguish the two exact byte generations across atomic rename and
the separate verifier-checkpoint publication.

## Fix

Retain the exact staged generation with its intent. Reconcile original, intended
and unknown bytes; resume the same prepared file or complete the already published
generation without rebuilding. Pin rollback targets and verifier state in a
durable restore intent; finish the sidecar when original bytes are already back.
Rollback takes precedence over conversion, and a completed rollback cannot replay
conversion. Unknown/newer bytes and changed verifier checkpoints stay protected.

## Acceptance scenario

- **Seed:** A disposable proven cache and immutable object, with one prepared
  conversion and retained old inode.
- **Action:** Exit the child process after conversion intent, cache publication,
  verifier publication or result publication; separately exit after either
  rollback publication step, then resume from another process.
- **Expected:** The exact intended generation and complete SDK values survive;
  the matching sidecar and receipt finish once. Rollback finishes with the exact
  original bytes/checkpoint and does not rename again. Published conversion is
  never called skipped, a pending rollback wins, and an unavailable new object
  causes exact old-cache recovery when that recovery can be proven.
- **Replayable offline:** yes; `bot/scripts/history-cache-crash-fixture.ts`. These
  are process-exit checks, not a power-loss claim.
