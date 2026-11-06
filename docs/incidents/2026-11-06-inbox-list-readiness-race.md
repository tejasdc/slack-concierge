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

## Fix

Each HTTP list request now captures the ledger head at admission and yields while
the existing worker reaches that head. It returns a bounded, prepared page and its
revision when reached. If the worker remains behind for two seconds, it still
returns incomplete coverage and the client keeps its visible copy. The ledger
fallback still serves the initial rebuild. This does not change Open requests.

## Acceptance scenario

- **Seed:** A prepared list is ready but one source change behind.
- **Action:** Begin an HTTP list read, accept a later unrelated write, then advance
  the worker to the head captured by the read.
- **Expected:** The response is ready through that captured head. With no worker
  advance, it remains incomplete after the bounded wait.
- **Replayable offline:** yes, with the isolated `prepared-topic-readiness` test.

The installed acceptance is a fresh list read during active source writes, with
its coverage and duration recorded; a before and after device rate needs a
comparable observation window.
