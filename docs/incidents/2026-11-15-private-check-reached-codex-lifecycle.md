---
failure: A disposable history check changed shared Codex process limits and reached its startup controller.
date: 2026-11-15
fix_commits: []
cause_status: confirmed
---

# A private database did not isolate shared provider lifecycle

## What was seen

During the WAL repair's disposable history-page checks, actual worker imports reached the
shared Codex lifecycle. Retained tool output recorded open-file limits raised from 1,024 to
1,048,576 for PID 3927354 at 21:32:42.509 UTC and PID 3961581 at 21:39:33.824 UTC. A later
21:39:43.245 UTC log recorded the daemon-start path answering `alreadyRunning`.

Those attempts were invalidated and reported. No follow-up production probe or attempted
undo was performed. `alreadyRunning` does not establish absence of effects: the startup path
also attempts directory creation, ownership and permission repair before invoking its manager.
Earlier missing-schema and readonly-import failures are separate source evidence; their
success-shaped later fixture outputs are not used as isolated acceptance.

## Cause

The existing private check boundary hid live databases but exposed Codex's private files,
host process namespace and process/service-control tools. The actual page worker connects at
startup. A successful connection can repair file limits or process placement; a refused
scratch socket can invoke automatic daemon startup. A scratch database, socket environment
override or parent-only module mock does not isolate lifecycle code in a real worker thread.
The pre-existing history-growth check also creates this worker, so the fault is a class of
check entrances rather than only the newly written fixture.

## Fix

Private check execution must establish and verify the existing check entrance's independent
data, process and native-command boundary before product imports, preserving the protected
database mounts and the caller's HOME environment. Synthetic fixture transports remain
fixture-owned. Root process-group custody stays outside a private process namespace, with
boolean nested-group attribution and explicit native cleanup at return.

The focused page fixture additionally compiles both parent and worker graphs with explicit
Codex lifecycle collaborators. It verifies replacements before execution, then verifies a
private Codex tmpfs and executable denial inside the child before importing product code.
Page/reset-delta and SQLite-cleanup results do not claim real provider lifecycle coverage.

## Acceptance scenario

- **Seed:** Disposable database state, real history-page source, retained local messages, and
  scratch marker tools standing in for host process/service commands. Keep real HOME spelling.
- **Action:** Establish the private entrance, verify barriers inside the child before imports,
  exercise the page worker, attempt a deliberately denied host-control operation, and cancel
  owned nested/native children through the existing bounded cleanup entrance.
- **Expected:** The deliberate command is refused with scratch evidence; shared Codex private files
  and host processes are inaccessible. Actual local pages and safe-reset deltas work under
  declared collaborators, canonical WAL bytes survive worker cleanup, and the owner can append.
  Cleanup receipts distinguish the owning group from nested leader custody. A hard-killed
  guardian never produces a successful cleanup receipt. No host resource repair is performed.
- **Replayable offline:** yes. The negative uses scratch executable markers and private
  namespaces; it must never repeat the observed live resource changes to reproduce the fault.

The check contract and its platform/runtime boundaries live in
[bounded release checks](../runbooks/RELEASE-CHECKS.md).
