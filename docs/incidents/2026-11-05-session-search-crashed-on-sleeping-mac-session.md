---
failure: Searching sessions in thnkr.ing replaced the whole list with an error when a match was a session on the sleeping Mac.
date: 2026-11-05
fix_commits: []
cause_status: confirmed
---

# Session search showed "Cannot read properties of undefined (reading 'stop')"

## What was seen

In thnkr.ing's Sessions page, searching for "Apple" replaced the session list with
"Something went wrong: Cannot read properties of undefined (reading stop)" until search was
closed (report capture c6513f14ea6c281018d1ec67e22d915d93a9304426f040bfd1f9957fca0de43c,
filed by concierge:3246 on 2026-11-05).

## Cause

The same search through the agent door returned 23 results; two (mac:34, mac:104) had no
`capabilities`, `attention` or `fidelity`. They are Mac sessions known here only from the Mac's
last catalogue while the Mac does not answer. Since 032f1df7 the peer catalogue stores prepared
session cards, but `federatedSearch` (catalogue-only matches) and `cachedView` (archive matches,
offline context, request targets) spread `view_json` as though it were a full session view.
thnkr.ing reads `session.capabilities.stop` for every row and threw.

## Fix

`catalogueOnlyView` in `bot/src/session-peers.ts` presents a stored card as a full view:
every capability explicitly false with the reason, the remaining view fields at their empty
values. Both catalogue readers use it.

## Acceptance scenario

- **Seed:** a fresh ledger whose `session_peer_catalogue` holds the mac:34 card from the live
  search answer, peer `mac` configured but unreachable.
- **Action:** `federatedSearch(local=no results, ['widgets'])`.
- **Expected:** the result's session carries `capabilities` with every control false and a
  reason, plus `attention` and `fidelity`. Before the fix `capabilities` was undefined.
- **Replayable offline:** yes
