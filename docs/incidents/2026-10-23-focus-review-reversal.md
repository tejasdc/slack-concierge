---
failure: Focus capture review kept seven requests from ordinary routing after Tejas reversed the hold.
date: 2026-10-23
fix_commits: []
cause_status: confirmed
---

# Focus capture review reversal

## What was seen

Tejas reversed capture review holding for now. The cloud owner was live with an
inactive Focus lease and seven held captures; the Mac owner reported zero local
held captures. These are current owner counts, not an estimate from UI rows.

## Cause

The earlier Focus client explicitly requested capture review. The accepting owner
honored both lease review and capture-time review flags, including delayed gateway
delivery. Ending Focus did not release held captures by design. Once Tejas reversed
that behavior, those seven captures still required an explicit owner release, and
old clients could keep requesting holds until both sides changed.

## Fix

The seven cloud captures were released in one action,
`tejas-focus-hold-reversal-20261023-cloud-1`, oldest first. The owner returned
`released:true` and `heldCaptureCount:0`. A subsequent cloud read still returned
zero, and the Mac read returned `localHeldCaptureCount:0`. Each of the seven exact
capture detail reads returned its original capture ID, original recorded time and
attachment count with `held:false`; the earliest retained image attachment remains
present. The release admitted the original inputs to ordinary routing; it did not
mint new capture identities. Provider completion and topic placement are separate
later effects, not established by the release response.

The capture IDs, in original time order, were:

1. `209901c5f1850d0d8b8176fa39e1b48422108177ab8bb4511e1985c5171b67e5`
2. `ff70c08b3a9563421172cea2b8a3b9cc159098ad0ccd74212913a17a02e29047`
3. `e6e9d3b22111c7d6e8c15217ee4e5fc61a8834d3335954527c18d155261c522c`
4. `2ea8b0641b131b965e394861a6a24fcb8222bd39f38ee6d1caf130eff2b0bd3e`
5. `18e95577ef9f5223e993a7700f331b1ac04b6bc6c92d4341474b61cd453d4a9e`
6. `99c37d4aef1fbad32f54247b7cdbe373bcd042ca414f9ab0e31a6be449fc59d8`
7. `77873f29b05b51f9ea9946ccc01e1fd221976f57ef74eccb656b2d0ef4aa5170`

New capture review admission is now an owner opt-in, off by default on both
machines. This prevents an older app version or delayed gateway delivery still
sending the former review flag from holding a new capture. The Focus router-turn
lease and an explicit urgency reason retain their existing behavior. To restore
capture review later, both owners must enable the switch and the Focus client must
opt in on each lease; the product must provide a release entrance before doing so.

## Acceptance scenario

- **Seed:** A cloud owner has seven distinct held Focus captures, including one with
  an image and two bug reports with attachments; a Mac owner has zero local held
  captures. A prior client still sends review flags.
- **Action:** Release the seven exact cloud capture IDs once, then install the
  owner default-off switch on cloud and Mac and admit ordinary and explicitly
  flagged captures.
- **Expected:** The release returns seven original IDs and zero still held;
  repeating the release action returns `released:false`. Each original detail
  retains its recorded time and attachment count. New captures from either
  client route normally while review is off. Queue-only Focus still holds router
  turns when its lease is active.
- **Replayable offline:** yes (the focused capture admission fixture covers owner
  paths; live owner reads establish the recorded seven-capture case).
