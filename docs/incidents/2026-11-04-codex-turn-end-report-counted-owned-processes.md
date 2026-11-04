---
failure: Concierge filed repeated background-process issues for processes still owned by a finishing Codex execution.
date: 2026-11-04
fix_commits: []
cause_status: best-explanation
---

# Finished Codex turns generated repeated background-process reports

## What was seen

Eight Inbox agent-report topics appeared soon after the first Codex turn-end detector was
installed. Four reports came from consecutive turns of session concierge:8251 between
20:24 and 20:25 UTC. Its exact run identities no longer had live processes when checked.
The marked detached-sleep test correctly reported a real survivor, and a marked no-job
turn produced no report.

## Cause

The Stop hook checked every process carrying the run identity except its own ancestors and
browsers. That test also includes Codex's coordinator and tool processes while Stop runs.
During the investigation a live Codex coordinator and code-mode process carrying a session
run identity were observed inside `concierge-exec-a660ba52a8fd31a9.service`. Systemd
confirmed the unit uses `KillMode=control-group`; Concierge owns and releases the whole
unit after provider completion. The earlier reports did not retain process names or PIDs,
so which exact processes each historical report saw cannot be proven. The observed unit
ownership and hook predicate are the best explanation for repeated reports from ordinary
consecutive turns.

## Fix

The hook excludes processes inside Concierge-owned execution units before deciding that
a run left an unowned process. It still reports a matching process outside those units,
including a detached tool process in the shared Codex App Server scope. The exception is
based on the unit's existing control-group kill guarantee, not a timer or a process-name
allowlist.

## Acceptance scenario

- **Seed:** Start a marked Codex turn with its coordinator running in a Concierge execution
  unit. In a separate marked turn, leave a harmless detached process outside that unit.
- **Action:** Finish both turns.
- **Expected:** The owned coordinator turn creates no background-process report; the detached
  process creates one tracked report, and the test process can be stopped by exact identity.
- **Replayable offline:** no (requires the installed Stop hook and live systemd cgroups).
