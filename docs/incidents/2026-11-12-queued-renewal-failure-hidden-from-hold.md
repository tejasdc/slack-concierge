---
failure: A Claude renewal queued for three days failed outside the hold's two-day window, so two more renewals reached his Mac within ten minutes.
date: 2026-11-12
fix_commits: []
cause_status: confirmed
---

# Queued renewal failure hidden from the retry hold

## What was seen

The server sent three Claude renewals for `tejastej.dc@gmail.com` to the Mac
worker on November 12: `50ed01b6-88e5-4766-8e58-746b8d0b9adc` (acknowledged
18:56:13 UTC), `d43efa4d-7c12-4173-828c-4f4afdbb05a5` (19:00:04) and
`d522b504-cb9d-4963-82e4-4123cd8134fb` (19:06:06). The first two answered
`PREAUTH_ENTRANCE_BLOCKED:` for the same obstruction: the active Chrome page
changed under the Accounts window. The runbook allows one short retry, then six
hours; the third request should not have existed. Each attempt took his Mac's
foreground while he was using it.

## Cause

`50ed01b6` was created on November 9 and stayed queued while the Mac was
unreachable (owner journal: `session_peer_request_unavailable` from November 9).
Its failed answer was recorded at 18:58:30 UTC. The hold read failed renewals
only from requests created in the last two days, so this failure was invisible.
At 18:59:14 the owner saw no failure and recorded a new renewal at once.
When that one failed at 19:01:50 it was counted as the first failure of its
kind, which earned the one short retry at 19:05:24. The same lookup scanned every
peer request by `LIKE` and took 835 ms in the 19:05:24 owner loop-lag event.

## Fix

Failed renewals are found by their action name with no creation cutoff, through a
partial index on failed peer requests and the external requests' unique key. Each
failure is dated from its final answer's own record (falling back to when it is
first seen), so a request answered days after it was queued holds from its answer.

## Acceptance scenario

- **Seed:** A signed-out Claude account with one delivered renewal notice and peer
request created three days ago, answered failed `PREAUTH_ENTRANCE_BLOCKED:` now.
- **Action:** Check the account 44 seconds later, then after two minutes, then let
the retry fail and check at 3.5 minutes, 10 minutes, 5 hours and 6 hours 1 minute.
- **Expected:** None at 44 seconds; exactly one retry after two minutes; none for six
hours after the retry's failure; then one renewal.
- **Replayable offline:** Yes, against a scratch ledger with the clock set.

## Second gap, seen while checking the fix

With the first fix installed, the Gmail account stayed held, but at 19:48:58 and
19:52:07 UTC renewals for `tejas@chann.app` and `hey@tejas.nyc` went to the Mac.
Each account had its own clean record, yet the obstacle (the page changing while he
used the Mac) belongs to the Mac. Pre-sign-in failures now count across every
account, a later renewal that gets past the obstacle clears it, provider refusals
stay with their account, and only one renewal is with the Mac at a time.

- **Seed:** Two `PREAUTH_ENTRANCE_BLOCKED:` failures for account A within six hours.
- **Action:** Account B's sign-in is refused.
- **Expected:** No renewal for B until six hours after A's second failure, unless a
renewal answered in between other than with a pre-sign-in failure.
