---
failure: A conversation's history showed "history is still reconnecting" for ten minutes because an out-of-date page position was answered as an outage.
date: 2026-10-13
fix_commits: [a0d25121]
cause_status: confirmed
---

# History said it was reconnecting for ten minutes over an out-of-date page position

## What was seen

Report f63bab21 (2026-10-13, Mac session mac:75): opening older history in thnkr.ing showed "history is still
reconnecting" over and over for about ten minutes. Nothing was down; the conversation had been re-indexed
while it was still being written.

## Cause

When the owner re-indexes a conversation's provider history, every earlier-page cursor handed out before is
invalid, and the history projection throws `STALE_HISTORY_CURSOR` (or `INVALID_HISTORY_REFERENCE` for a cursor
that names no page of that conversation). The history route in `bot/src/session-owner.ts` caught only
`HISTORY_PAGE_STILL_PREPARING` specially; every other error became status 503 `HISTORY_PAGE_UNAVAILABLE`, the
code for an outage. thnkr.ing treats that as transient, retried the same stale cursor, and showed the
reconnecting state until it gave up. The history delta route had the same mapping.

## Fix

a0d25121: the page route answers a stale cursor with 409 `HISTORY_CURSOR_STALE` and a foreign cursor with
400 `HISTORY_CURSOR_INVALID`, both definite answers. The delta route answers a stale cursor with
`{reset: true}`, the existing signal to reload from the newest page. The companion thnkr.ing change renews its
cursor on the 409 and also translates the old 503 for owners that predate this commit.

## Acceptance scenario

- **Seed:** A Claude or Codex session with a projected history of several pages; a client holds an
  earlier-page cursor from that projection.
- **Action:** Re-index the session's history (append to the transcript so the snapshot is rebuilt), then
  request the earlier page and a delta with the old cursor.
- **Expected:** The page request answers 409 `HISTORY_CURSOR_STALE` (not 503); the delta answers
  `{reset:true}`; a cursor from another conversation answers 400 `HISTORY_CURSOR_INVALID`.
- **Replayable offline:** yes (scratch transcript and history index; no live provider needed)
