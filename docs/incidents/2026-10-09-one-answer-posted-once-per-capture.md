---
failure: One agent answer to several requests in the same thread was posted, filed and notified once per request (three times on October 9).
date: 2026-10-09
fix_commits: [0c0cdfef]
cause_status: confirmed
---

# The same answer appeared three times in one thread

## What was seen

On October 9 an agent gave one identical answer to several requests the router had sent for one thread; Tejas saw it
posted three times, filed three times and got three notifications.

## Cause

`bot/src/session-inbox.ts` suppressed a repeat only when the same agent's byte-identical words were already posted on the
one capture (`input_id`) the request named. The router sends follow-ups for one topic under different captures placed in
that topic, so each request's answer looked new.

## Fix

0c0cdfef widens the check to every root input placed in the thread's topic (`inbox_topic_roots`), so an identical answer
within the hour is posted, filed and notified once.

## Acceptance scenario

- **Seed:** A topic with three captures as roots; three requests from the router to one agent, each naming a different
  capture.
- **Action:** The agent sends the same final text to all three (separately or with `--also`).
- **Expected:** One post in the thread, one reading item, one notification; all three requests close.
- **Replayable offline:** yes (scratch ledger)
