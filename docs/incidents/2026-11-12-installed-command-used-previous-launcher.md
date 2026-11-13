---
failure: A healthy Concierge release contained its history maintenance command but the installed command still refused it.
date: 2026-11-12
fix_commits: []
cause_status: confirmed
---

# Installed command retained the previous release's vocabulary

## What was seen

Request `bf488059-703f-4779-93f7-09dfdf9fc85e` reported a healthy installed
release `667190bbf801305d816aed506769f42fc42ccbfb` whose sealed artifact
contained the maintenance worker and launcher command, while the stable host
command exited 2 with usage `<deploy|repair|recover>`.

## Cause

Runtime installation copied the invocation-pinned predecessor launcher before
activation. Promotion changed the controller pointer but never refreshed that
copied command. Updating only the new manager's promotion code would also miss
the first fixing rollout, which still runs the old manager. Existing sealed
shell launcher files may be nonexecutable, so direct symlinks are insufficient.

## Fix

Stable executable dispatchers invoke Bash on the launchers beneath the selected
control pointer. The service unit installs them through the sealed current
manager before recovery, without opening the ledger or copying Bun. The old
runner's normal pointer promotion then exposes the new command. Later controller
selection and full rollback preflight the complete sealed artifact and both
launcher entries; application-only rollback retains its documented controller.
Runtime installation selects the verified controller instead of stale environment
or checkout paths. The historical initial cutover installs runtime after selecting
the first sealed controller and before changing the service unit; failures before
that point retain the old service unit, and its failure handler uses its already
selected Bun and helpers rather than the new stable entrance.
The pre-start installer is guarded by its sealed capability marker, so an older
application restored under a newer service unit skips the unsupported command
while retaining the already-installed dispatchers.

## Acceptance scenario

- **Seed:** A disposable deployment root with an old sealed controller, copied
  regular-file entrance refusing maintenance, and a modern sealed candidate.
- **Action:** Activate the candidate, execute its real unit's launcher-installation
  pre-start command, then publish the control pointer as the predecessor manager
  does. Exercise full/application-only rollback, control recovery, stale invocation
  roots, and invalid artifacts.
- **Expected:** The existing stable command refuses maintenance before the switch,
  executes the modern sealed helper afterward, and follows the selected controller
  during rollback/recovery. Invalid artifacts preserve pointers and entrances.
  The pre-start command creates no ledger. The original service unit fails the
  fixture at its missing launcher-installation step.
- **Replayable offline:** yes, `bun bot/scripts/installed-control-command-fixture.ts`.
  Synthetic application/helpers, a tiny Bun forwarder and an owned supervisor
  forwarder replace production work. The original unit can be supplied with
  `FIXTURE_SERVICE_UNIT` for the negative control. No production cache workload is
  exercised or claimed.
