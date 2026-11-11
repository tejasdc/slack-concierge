---
failure: An hourly Codex firing kept waiting for a spent account after the active account had room.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# An unbound scheduled firing stayed usage-held

## What was seen

The 14:00 UTC firing of the overnight checkpoint remained queued for the old Codex account's
November 12 reset. Its saved account was empty. The server's active personal Codex account
had a fresh reading with 16% of its weekly allowance used. Subsequent hourly firings skipped
while the older one stayed queued. An Accounts tool-free retry returned an invalid-column error.

## Cause

The Codex room and account-switch paths released usage-held ordinary turns only. They
excluded every saved turn even though scheduled firings have no account binding and dispatch
through the active shared Codex login. Only banked turns must retain their selected account.
The manual retry path separately read a removed session metadata column.

## Fix

Fresh Codex room, account switching, and verified resets release ordinary turns and unbound
scheduled firings. They leave account-bound banked turns held. The scheduled fire instant
remains independent of the retry instant. The manual retry reads the current session metadata.

## Acceptance scenario

- **Seed:** A queued hourly Codex firing with no saved account, a usage hold until an old account's reset, and a fresh active Codex account with room; also a banked turn bound to the old account.
- **Action:** Record the fresh account reading after the switch.
- **Expected:** The exact hourly firing's retry moves to now and it resumes in its original queue after its fire time. The banked turn remains bound. A tool-free retry can inspect the held turn without a database error. No accepted input is re-created.
- **Replayable offline:** yes (an isolated owner ledger can exercise the release predicate and fire-time claim; a live release verifies the actual queue).
