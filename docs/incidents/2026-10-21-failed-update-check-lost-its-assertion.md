---
failure: A failed update check kept only the end of its output, so the automatic repair could not see why it failed and gave up.
date: 2026-10-21
fix_commits: []
cause_status: confirmed
---

# An update failed and its repair parked for lack of evidence

## What was seen

Update run b264626d (desired commit acf987d6, 21:20 UTC) failed with "Candidate presentation
cost check failed: exit status 1". The child that failed was the foreground composed fixture.
Autonomous repair incident ca762012 parked as `operator_required`: the controller had kept only the
last 2,000 bytes of each stream and removed staging, and those bytes held fixture diagnostics (a
13.1 s header wait under heavy host load) but not the failing assertion. The next update, which
contained the same commit, passed the same check about ten minutes later.

## Cause

Confirmed for the lost evidence: the controller's failure message kept only each stream's final
2,000 bytes, the fixture wrapper put its child's stderr before kilobytes of later diagnostics, and
staging was deleted after the attempt, so nothing else held the assertion. The check's own failure
remains unexplained; load-sensitive timing in the foreground fixture is the best explanation and is
not proven, so its deadlines were not changed.

## Fix

A failed presentation check keeps its complete stdout and stderr (first 256 KB and last 768 KB of
larger streams) under the deployment root's `candidate-check-failures/` before staging is removed,
newest 20 retained, and the failure message names that folder and the first failure line. The
release check prints each lifecycle failure on its own line, and the fixture wrapper leads its
error with the child's own error line.

## Acceptance scenario

- **Seed:** a presentation check whose fixture child logs tens of kilobytes, fails an assertion,
  then logs more.
- **Action:** the controller records the failed check.
- **Expected:** the failure message's `first failure:` line contains the assertion text, and the
  named `complete output:` folder holds stderr containing it.
- **Replayable offline:** yes (agent-scripts `exercise-candidate-check-evidence.ts` drives the real
  wrapper and controller functions in a scratch folder).
