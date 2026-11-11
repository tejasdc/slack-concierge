---
failure: A built Inbox thread list often answered not-ready while the presentation worker briefly trailed new ledger changes.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# Inbox list reads returned pending during ordinary catch-up

## What was seen

The retained report recorded 2,360 pending and 135 failed outcomes among 5,553
`threads.open` attempts over 36 hours. The client records pending when list coverage
is incomplete and keeps its last device copy on screen. A live agent list read on
November 6 returned complete coverage; another shortly afterward returned
`presentation_indexing` while the prepared list was already built. Worker batch
records show ordinary changes taking hundreds of milliseconds, sometimes over a
second. The worker also logged disk-full failures on November 5; those explain an
outage interval but are not needed to produce the ordinary catch-up race. The
135 failed device outcomes have no retained per-attempt reason in this report.

## Cause

The list reader compared the prepared copy to the ledger's newest change head at
the moment it answered. Any write between preparation and the read made the whole
list unready, even when the worker was advancing normally. The client then retried
without adopting the otherwise valid rows, increasing reads.

Re-measured on November 10 on the installed release: 590 of 2,676 device list opens
in 24 hours ended pending (22%). About a third of those ended within 250 ms, on the
first page; the rest ended part-way through the device's twenty-row page walk (it
reads about 420 rows in 21 pages over roughly 3.4 seconds), where every later page
was held to the then-newest head again. Live events make the device re-read about
600 ms after a change, while worker batches for that change took 0.7 to 3.6 seconds,
so the first read usually lost the race. A probe walking the list through the agent
entrance returned `presentation_indexing` on the first page in 15 of 15 attempts
during active work.

## Fix

The first page of a list now captures the ledger head at admission and yields while
the existing worker reaches that head, for at most four seconds. It returns a bounded,
prepared page and its revision when reached. If the worker remains behind longer, it
still returns incomplete coverage and the client keeps its visible copy. A cursor page
continues the walk without a newer-head requirement: its generation is checked by the
cursor and topic changes by the client's revision check. The ledger fallback still
serves the initial rebuild. This does not change Open requests.

## Acceptance scenario

- **Seed:** A prepared list is ready but one source change behind.
- **Action:** Begin an HTTP list read, accept a later unrelated write, then advance
  the worker to the head captured by the read.
- **Expected:** The response is ready through that captured head. With no worker
  advance, it remains incomplete after the bounded wait, while a cursor page of the
  same generation answers complete at once.
- **Replayable offline:** yes, with the isolated `prepared-topic-readiness` test.

The installed acceptance is a fresh list read during active source writes, with
its coverage and duration recorded; a before and after device rate needs a
comparable observation window.
