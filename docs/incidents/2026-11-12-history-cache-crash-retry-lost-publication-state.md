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
The subsequent source review also identified an exit during staging, before
intent exists: the fixed staging filename made that same batch fail every retry.
Each unaccepted copy now has a fresh exclusive name. A real exit after copy
preserves the original and leaves the unaccepted file unused; retry completes
the same proven batch and subtracts retained staging blocks from net savings.

## Acceptance scenario

- **Seed:** A disposable proven cache and immutable object, with one prepared
  conversion and retained old inode.
- **Action:** Exit the child process after conversion intent, cache publication,
  verifier publication or result publication; separately exit after either
  rollback publication step, then resume from another process.
  Also exit after the staged copy and before intent; seed a partial old staging
  file and verify retry neither adopts nor overwrites it.
- **Expected:** The exact intended generation and complete SDK values survive;
  the matching sidecar and receipt finish once. Rollback finishes with the exact
  original bytes/checkpoint and does not rename again. Published conversion is
  never called skipped, a pending rollback wins, and an unavailable new object
  causes exact old-cache recovery when that recovery can be proven.
- **Replayable offline:** yes; `bot/scripts/history-cache-crash-fixture.ts`. These
  are process-exit checks, not a power-loss claim.

When these fixtures entered CI, its ordinary user passed hybrid artifact checks
but could not remove sealed 0555 directories afterwards; the local root run had
masked cleanup failure. Fixture cleanup now restores write permission only within
its own disposable tree and never follows symlinks. A separate probe run as UID
65534 verifies sealed-tree removal and unchanged external target permissions.
Production sealing is unchanged.
The complete non-root replay then exposed a distinct earlier failure: release
preparation sealed a directory before moving it between parents. Linux refuses
that move without write permission on the directory, and finally cleanup masked
the original error. A read-only independent Sol diagnosis and UID65534 syscall
probe confirmed it. Preparation now moves the writable candidate to an unpublished
sibling, seals it and publishes by a same-parent atomic rename. The full non-root
hybrid fixture verifies 0555 publication and absence of leftover successful staging;
failed unpublished candidates remain retained rather than weakening a published seal.
