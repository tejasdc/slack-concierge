---
failure: A completed Claude renewal still appeared signed out in Accounts and held agent work.
date: 2026-11-07
fix_commits: []
cause_status: confirmed
---

# Runner Claude renewal was filed but Accounts still showed signed out

## What was seen

At 01:45:36 UTC on November 7, the server runner's Claude Code CLI exited zero after one
browser approval for `tejastej.dc@gmail.com`. Its durable sign-in operation became completed,
the account's own credential home changed, and a direct provider usage read from that home
returned HTTP 200. The owner selected the exact account. Yet Accounts still displayed
`This account needs signing in again` after its usage refresh.

## Cause

The runner's usage reader took the sign-in status from claude-swap's separately saved copy.
That copy still said `relogin_required`; Accounts filed the new working login only in the
runner's own home. The stale copy therefore overrode the login that agent turns actually use.
The browser worker correctly stopped without another approval when it saw the discrepancy.

## Fix

The runner now asks the provider for allowance through the exact own home when claude-swap
reports a problem. A successful own-home read supersedes the stale warning. It keeps only
allowance and source time in a five-minute in-process cache, keyed by credential file version,
so filing a new login takes effect on the next read. A failed own-home read retains the prior
warning; it is not treated as proof that the renewal succeeded. No token or sign-in code enters
the owner ledger or the incident record.

The fresh provider reading showed this account at 100% of its weekly allowance, with extra
usage off and the next reset on November 11. Successful sign-in therefore removes the false
authentication hold, but does not provide allowance for a Claude turn. The allowance hold must
remain distinct from this repair.

Proof before release: the completed runner operation, exact account selection, own-home
Claude status, and HTTP 200 usage response were observed. After release, verify Accounts shows
the exact account signed in and that work waits on the actual allowance while it is full.

## Acceptance scenario

- **Seed:** A runner has a freshly approved Claude login in its own account home, while
  claude-swap's separate copy still reports `relogin_required` for the same address.
- **Action:** The runner refreshes provider account readings.
- **Expected:** The own-home provider response supplies current allowance; Accounts shows that
  account signed in, and dispatch applies its real allowance instead of asking for another approval.
- **Replayable offline:** no (the signed-in own-home provider response is live).
