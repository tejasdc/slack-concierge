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
filed by concierge:3246 on 2026-11-05). On November 6, the installed laptop-size page still
showed "Something went wrong" after the first repair was installed.

## Cause

The same search through the agent door returned 23 results; two (mac:34, mac:104) had no
`capabilities`, `attention` or `fidelity`. They are Mac sessions known here only from the Mac's
last catalogue while the Mac does not answer. Since 032f1df7 the peer catalogue stores prepared
session cards, but `federatedSearch` (catalogue-only matches) and `cachedView` (archive matches,
offline context, request targets) spread `view_json` as though it were a full session view.
thnkr.ing reads `session.capabilities.stop` for every row and threw.

The first repair normalized stored catalogue matches. The installed November 6 search still
returned mac:34 and mac:104 without those fields while the Mac was reachable: the live peer
search itself can return compact cards, and the merge passed them through unchanged.

## Fix

`catalogueOnlyView` in `bot/src/session-peers.ts` presents a stored card as a full view:
every capability explicitly false with the reason, the remaining view fields at their empty
values. Both catalogue readers use it. The search merge now also applies that shape whenever
a peer result lacks current control facts, whether the Mac answers or not.

## Acceptance scenario

- **Seed:** a fresh ledger whose `session_peer_catalogue` holds the mac:34 card from the live
  search answer, peer `mac` configured but unreachable.
- **Action:** `federatedSearch(local=no results, ['widgets'])`.
- **Expected:** the result's session carries `capabilities` with every control false and a
  reason, plus `attention` and `fidelity`. Before the fix `capabilities` was undefined.
- **Replayable offline:** yes

- **Seed:** a live peer search returning the compact mac:34 and mac:104 cards without
  `capabilities`, alongside ordinary complete session views.
- **Action:** search "Apple" on the installed Sessions page at laptop size.
- **Expected:** both Mac sessions appear and the page stays usable without an error; their
  search cards have explicit unavailable controls until the exact session is opened.
- **Replayable offline:** yes, with the compact peer result; installed browser observation
  also checks the real search boundary.
