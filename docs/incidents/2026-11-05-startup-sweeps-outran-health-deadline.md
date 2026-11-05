---
failure: A Concierge update was rejected and parked because, on a busy host, Concierge's own startup took longer than the update's 90-second health deadline, and the logs could not say which step was slow.
date: 2026-11-05
fix_commits: []
cause_status: best-explanation
---

# The 04:49 ET update parked: startup outran the health deadline

## What was seen

Update run 8edc9478 started candidate 825933f7 at 04:49:06 ET. By 04:50:38 the candidate had
logged nothing past `session_purposes_filled` (04:49:56), so the controller's 90 s deadline expired
and it restored 576bfc4a. The restored release then held its main thread for 125,959 ms
(`owner_task_blocked`, label `startup`, `ledger_wait_ms` 0) before logging its first phase at
04:52:48: `session_purposes_filled` came at +73 s and `timed_request_posts_retired` at +121 s. A warm
start at 04:58:53 took 15 s. Host load was about 40 on 12 cores and journal writes lagged over 5 s.
Repair incident ce2c2192 parked because the retained logs did not localize the slow step.

## Cause

Confirmed: the startup path runs, synchronously and on every start, repairs written for past
incidents that sweep history: every forwarded post in the owner's event log (placed-answer
reconciliation, timed-post retirement) and every session with a nested turn lookup (purpose
backfill). Confirmed: the watchdog's ledger time read 0 because storage timing was enabled only
once the owner object existed. Best explanation, not measured per step: on a cold page cache under
heavy disk load those sweeps account for most of the 126 s, since the same work took 15 s warm.

## Fix

- Each synchronous startup step is timed and labelled (`concierge_startup_step`, with ledger
  statements, time and slowest fingerprint; `module_load` for import-time work), and ledger time
  is counted from the first statement.
- Each history sweep is a catch-up with a high-water mark: the start path reads only what changed
  since the last start; a first pass runs after Concierge is online in small paged steps.
- Awaited startup phases log their duration and ledger work.

## Acceptance scenario

- **Seed:** a ledger with a large owner event history and completed repair markers.
- **Action:** Concierge starts on a cold page cache.
- **Expected:** each startup step logs its time; the history sweeps are skipped or bounded to new
  events; the first startup phase begins well inside 90 s.
- **Replayable offline:** partly (scratch ledger; cold-cache timing needs the real host).
