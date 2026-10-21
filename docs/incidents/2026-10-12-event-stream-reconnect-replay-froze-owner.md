---
failure: When the app or notification service reconnected after a long absence, Concierge froze for seconds sending everything it had missed in one go.
date: 2026-10-12
fix_commits: [1c9b4c06]
cause_status: confirmed
---

# Event-stream reconnects replayed their whole gap synchronously

## What was seen

At 04:43:44 UTC on October 12 one client's reconnect replayed 37,996 events (417 MB) in 2.2 s on the owner loop; over 72
hours there were twelve such replays of 100 MB or more, up to 674 MB and 5.6 s. The replay was noted, unfixed, in the
[thread-index record](2026-10-12-thread-index-rebuilt-in-his-first-tap.md).

## Cause

`stream()` in `bot/src/session-owner.ts` replayed every event after the client's cursor in one synchronous read with no
page bound before switching to live events.

## Fix

1c9b4c06 reads the replay 200 events at a time, yields the loop between pages and waits for the reader when its buffer is
full. Frames and cursors are unchanged, and the notification worker still receives every event (a reset frame was
rejected because it would drop events for it).

## Acceptance scenario

- **Seed:** A ledger with 40,000 events after a client's cursor.
- **Action:** That client reconnects with its old cursor and reads slowly.
- **Expected:** It receives all 40,000 events in order then live events; no owner loop tick exceeds a few hundred ms.
- **Replayable offline:** yes (scratch ledger, slow reader)
