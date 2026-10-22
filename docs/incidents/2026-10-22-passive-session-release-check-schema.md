---
failure: The Concierge release check stopped because its isolated session database lacked the passive canvas event ledger.
date: 2026-10-22
fix_commits: []
cause_status: confirmed
---

# Passive canvas session release check stopped before publication

## What was seen

The required release check failed with SQLite's `no such table: session_owner_events` while preparing a canvas voice session card. No release was installed from this failed check.

## Cause

The session card now reads finalized speech time from the existing session event ledger for passive canvas sessions. The isolated release check's in-memory database omitted that table, although the production owner creates it.

## Fix

The isolated release check database creates the event ledger table alongside its other session tables. Runtime session admission and storage are unchanged.

## Acceptance scenario

- **Seed:** Use the isolated release check's session database with a passive canvas session card.
- **Action:** Build the prepared session card through the required release check.
- **Expected:** The card reads the ledger query without a missing-table error and the release check advances.
- **Replayable offline:** yes.
