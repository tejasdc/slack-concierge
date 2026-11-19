---
failure: Candidate preparation timed out while seeding the compressed backup safety check.
date: 2026-11-18
fix_commits: []
cause_status: confirmed
---

# Database safety fixture timed out before starting compression

## What was seen

Deployment `563fccd7-93dd-4ef3-8d0d-fe92b46413e1` failed to prepare candidate
`de8b738ca6e55a496e295160db625a9dbcd8685f`. The detached controller recorded the
failed database safety child at 19:28:09 Eastern and verified that
`4b9e33f4ad9ad589940687b367dc5dfaff3f93d0` was still serving at 19:28:11.
The child emitted no stderr before the deadline.

## Cause

The compressed-copy fixture seeded 4,000 rows in a scratch SQLite database in
separate autocommit transactions. Its retained write-ahead log was last written
at 19:28:09 and held 2,532 commit frames, including the table creation. The
main file was still one page and the scratch directory held no ledger-check
receipt or copy. The 30-second child deadline interrupted seeding before the
compression and restore checks began.

## Fix

Seed the same 4,000 rows in one transaction with automatic checkpointing still
disabled. This keeps the committed rows in the write-ahead log for the copy
check to exercise. Include the child's exit status, signal and elapsed time in
the retained failure output so a silent failure still has diagnostics.

## Acceptance scenario

- **Seed:** Archive the candidate and give the normal isolated presentation gate
  its disposable state directory and the host's `zstd`.
- **Action:** Prepare the candidate through the sealed release path.
- **Expected:** The database safety child finishes within 30 seconds. The
  compressed copy restores all 4,000 rows and matches the checkpointed ledger
  bytes. An interrupted child leaves termination details in retained output.
- **Replayable offline:** yes, through the isolated presentation gate.
