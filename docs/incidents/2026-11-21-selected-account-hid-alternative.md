---
failure: A refused Claude conversation could hide another account with room in its continuation notice.
date: 2026-11-21
fix_commits: []
cause_status: confirmed
---

# Selected Claude account hid another account with room

## What was seen

On November 21, a queued agent request in the thread gardener's existing Claude conversation was reported as waiting until November 22 at 10 PM Eastern, although Accounts showed room on `hey@tejas.nyc` and `tejastej.dc@gmail.com`. A fresh exact-model request could start. The existing conversation's turn was refused under both account labels; the original request later completed through a custody-preserving handoff to a fresh Claude conversation. That recovery does not establish why the old conversation was refused or which subscription the provider charged.

## Cause

One source-confirmed defect in the continuation notice path was independent of that provider refusal. The “another account has room” check passed the refused account to a parameter that means *prefer this account*, then inspected only the one account the dispatcher selected. If it selected the refused account, the check returned false even when another launchable account had a fresh reading with room.

## Fix

The check now enumerates the alternatives for the exact model and machine, excluding the refused account.

## Acceptance scenario

- **Seed:** The selected account has an unreadable usage reading; another launchable account has fresh room for the exact model.
- **Action:** Check whether another account can take a refused continuation.
- **Expected:** The answer is yes. When only the refused account has room, the answer is no.
- **Replayable offline:** yes, using the disposable account-home and usage fixture.

This is a source-level boundary; a future provider refusal on the long conversation remains a separate question.
