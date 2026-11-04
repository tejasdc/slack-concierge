---
failure: Presentation worker remained thousands of events behind after a busy restart.
date: 2026-11-04
fix_commits: []
cause_status: best-explanation
---

# Presentation worker catch-up under busy agent traffic

## What was seen

The worker applied about 500 change-journal records per minute while the source
arrived at roughly 650 per minute after the 11:26 ET restart. Health showed no
failed passes, but the gap exceeded 5,000 and thnkr.ing read a stale prepared
view. CPU was saturated and the worker used about 90% of one core.

Bounded ledger windows showed 3,845 source changes across 24 sessions in the
15 minutes before restart and 13,772 across 120 sessions in 21 minutes after.
Tool-message events rose from 939 to 3,119 and session rows from 244 to 2,808.
Sixty-one newly imported conversations produced only 73 of the later changes;
they cannot explain the sustained rate. A later four-minute surge included 134
distinct agent inputs to the Inbox router, 61 requests and 21 cancellations.
These are distinct accepted operations rather than duplicate change-journal
rows from one replay. Their upstream reason is not established by this worker.

## Cause

In one bounded 500-change apply page, ten router-session row changes dirtied
609 dependent topics. The worker drains those topics in pages of 20. Before
this repair, each page rebuilt the same router context, reading up to 2,000
human inputs and resolving their roots plus pending work. That is at least 31
context constructions and up to 62,000 root resolutions for the same source
batch. The per-phase wall-time share was not observable before the repair;
this repair adds a bounded batch timing record to test whether this measured
repeated work was the limiting cost after installation.

## Fix

The worker keeps one topic context per session for the lifetime of one
500-change source batch. Later topic pages reuse it. The cache is discarded
before the next source batch so new accepted inputs and changes are included.
Topic storage writes, source sequence order, page size, scheduling priority,
write caps and checkpoint boundary are unchanged. The batch timing record
reports primary apply, topic and Lab phase wall time, and topic-context
construction without storing content or session identities. Phase wall time
includes progress yields and any search maintenance they run.

## Acceptance scenario

- **Seed:** A busy source with several hundred topics depending on one session
  and a backlog of accepted source changes.
- **Action:** Apply source changes that dirty those topics over multiple drain
  pages while new changes continue to arrive.
- **Expected:** Topic context is built once per affected session in a source
  batch; the installed worker reaches a near-zero backlog and stays there for
  15 minutes while real events arrive.
- **Replayable offline:** yes (a fixture can seed many topics and inspect
  context build counts without a production ledger copy).

The normal release gate and existing topic lifecycle fixture also must pass.
