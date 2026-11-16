---
failure: The worker identity release check failed because its fixture opened a writable SQLite connection outside the ledger write wrapper.
date: 2026-11-16
fix_commits: []
cause_status: confirmed
---

# Worker identity fixture bypassed the ledger write rule

## What was seen

The required release check rejected the diagnostic candidate before merge. Its SQLite constructor check named the new fixture's writable connection.

## Cause

The fixture created a temporary database directly, bypassing the repository's required write wrapper. The focused worker identity check did not run that repository-wide constructor rule.

## Fix

The fixture opens its temporary database through the same write wrapper as other writable ledger connections. The constructor rule is run on the candidate before merge.

## Acceptance scenario

- **Seed:** The worker identity fixture is present in a candidate checkout.
- **Action:** Run the worker identity fixture and the SQLite constructor check over the source tree.
- **Expected:** The fixture reads five native worker identities and the constructor check accepts every writable connection.
- **Replayable offline:** yes
