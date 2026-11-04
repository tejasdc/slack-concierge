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
they cannot explain the sustained rate. At restart, the execution host attached
19 existing runs and launched 30, processing 1,082 recorded frames. The frame
replay may contribute to the initial burst, but its exact source-journal share
was not measured. A later four-minute surge included 134
distinct agent inputs to the Inbox router, 61 requests and 21 cancellations.
Those are distinct accepted operations. The restart window also overlapped two
open reminder deliveries: two existing overdue-event rows generated 1,108
communication changes in four minutes. One of those rows generated 1,924
changes in the following 21-minute window. The same loop had already generated
1,648 changes in the 15 minutes before restart, so it was a persistent source
floor and a transient burst contributor, not the whole post-restart jump.

The reminder delivery path updated its communication row on every coordinator
pass even when the accepted input, status and error were unchanged. Each SQLite
update appended two source changes (old and new row), requiring the
presentation worker to apply both. The post-restart source mix also rose
broadly across session, owner, turn and input records; those changes remain
separate from this no-op loop.

These counts came from bounded primary-key journal ranges: 2,109,439–2,113,282
before restart, 2,113,283–2,117,641 across restart, and
2,117,642–2,131,412 afterwards. The repeated rows were grouped by their exact
communication-event ID and checked against the currently retained overdue
events, which identify the reminder-delivery branch.

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

Reminder delivery now writes its communication row only when its accepted
input, status or error changes. Its normal receipt and delivery behavior remain
the same, while idle coordinator passes stop creating source changes.

## Acceptance scenario

- **Seed:** A busy source with several hundred topics depending on one session
  and a backlog of accepted source changes.
- **Action:** Revisit an already accepted reminder on repeated coordinator
  passes, then apply source changes that dirty the same session's topics over
  multiple drain pages while new changes continue to arrive.
- **Expected:** Topic context is built once per affected session in a source
  batch, unchanged reminders append no source change, and the installed worker
  reaches a near-zero backlog and stays there for 15 minutes while real events
  arrive.
- **Replayable offline:** yes (a fixture can seed many topics and inspect
  context build counts without a production ledger copy).

The normal release gate and existing topic lifecycle fixture also must pass.
