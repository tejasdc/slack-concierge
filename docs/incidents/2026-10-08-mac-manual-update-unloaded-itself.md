---
failure: A manual Mac update vanished partway through installation, after pulling and installing dependencies but before restarting Concierge.
date: 2026-10-08
fix_commits: [2b95eb6f]
cause_status: best-explanation
---

# The Mac's manual update disappeared mid-install

## What was seen

On 2026-10-08 a manual Concierge update on the Mac stopped after checkout and dependency installation and
before the coordinator restart. The checkout's HEAD had moved, which made the update look complete, but the
old coordinator kept running.

## Cause

Best explanation (2b95eb6f, PEER-INSTANCES.md); the job's actual environment was not captured.
`scripts/install-mac.sh` rewrote the update job's plist and, unless `XPC_SERVICE_NAME` equalled the update
job's label, ran `launchctl bootout` on that job and bootstrapped it again. `XPC_SERVICE_NAME` is not a
reliable test of whether the installer runs inside that job; when the manual update job invoked the installer
and the test failed, `bootout` ended every process the job had started, including the installer itself. The
same self-unload had already happened to the automatic updater on 2026-09-29.

## Fix

2b95eb6f: the installer never unloads either updater; it bootstraps a job only when absent
(`launchctl print … || launchctl bootstrap …`). A changed updater definition must be reloaded from outside both
update jobs. The runbook adds recovery for an update that stopped after pulling: restore the manual job only if
missing and kickstart it, which skips the automatic path's HEAD-equals-origin shortcut, then verify the new
coordinator's process and revision.

## Acceptance scenario

- **Seed:** Mac with both update jobs loaded and a pending origin/main change.
- **Action:** kickstart the manual update job (`com.tejasdc.concierge-update`).
- **Expected:** the job runs to completion: new coordinator process at the new revision, both update jobs
  still loaded afterward, no `bootout` in the installer's trace.
- **Replayable offline:** no (needs macOS launchd)
