---
failure: A release drain scanned every retained execution to find queued runner turns and blocked the accepting owner.
date: 2026-11-07
fix_commits: []
cause_status: confirmed
---

# A release drain blocked new Concierge work while looking for queued runner turns

## What was seen

At 03:56:06 UTC the owner was blocked for 1,422 ms in `queuedTurnJobsForOwner` during
`beginRunnerTurnDrain`. The statement made 13,349 sampled read calls and physically read
84.5 MB. This was an owner-loop pause, separate from the 03:30 WAL synchronization delay.

## Cause

The join expressed a queued job ID as `'turn:' || execution.execution_id`. On the installed
database, `EXPLAIN QUERY PLAN` began with `SCAN execution`, then looked up each job by primary
key. It therefore traversed retained executions even when no queued turn job needed draining.
The observed 1,422 ms pause is attributed to that statement; the plan and read counters support
read amplification, while storage contention may also have lengthened individual reads.

## Fix

Derive the execution ID from each queued job ID for a primary-key execution lookup, while
retaining the original exact identity predicate. The existing `runner_jobs_queued` index now
drives the plan. This changes neither claim state nor accepted input identity and adds no
schema, writer, or durability boundary. Required owner-side writes can still block the loop;
this correction is limited to the demonstrated drain lookup.

## Acceptance scenario

- **Seed:** Many retained executions and no queued runner turns, plus a queued turn whose job
  ID exactly matches its execution ID and a malformed/nonmatching job ID.
- **Action:** Drain the owner through the ordinary release path while admitting a routed request.
- **Expected:** The plan begins with queued jobs and uses the execution primary key; the exact
  matching turn is found, the nonmatching job is ignored, and an empty queue causes no retained
  execution scan. The routed request still receives its normal durable receipt.
- **Replayable offline:** yes (synthetic ledger and query plan; installed latency still requires
  a real drain under representative storage load).
