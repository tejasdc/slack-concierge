---
failure: A Concierge update failed and its repair parked because activation asked the owner for release state while the owner was restarting, and the controller lost the command's error.
date: 2026-11-04
fix_commits: []
cause_status: best-explanation
---

# Update parked with "activation reached the controller before the owner's socket was ready"

## What was seen

Update run 031eadf3 for c4387e59 prepared and checked its candidate (20:24–20:26:15 ET), then
failed before recording an activation intent. LKG 314dd740 was restored and repair incident
dba27ddf started; the repair agent parked at 20:30 because the deploy journal held no activation
error and the fix lay in the controller, not the candidate. main stayed 13 commits ahead of the
installed release.

## Cause

Confirmed: `concierge-bot` received SIGTERM and restarted at 20:26:02 (a clean systemd stop and
start, not the update's own restart), and its request socket served again at about 20:26:18.
The release manager's `activate` reads the last-known-good release and records its activation
intent over that socket with a single attempt. Its catch prints `{"status":"error",...}` on
stdout; `deploy.sh` captured that stdout with `output=$(...)` under `set -e`, so the script
stopped on the assignment before printing it, and nothing reached the journal or the incident.

Best explanation, not observed: the single attempt ran at about 20:26:15–17 and hit the missing
socket (Bun reports it as `FailedToOpenSocket`). The exact message is gone; what restarted the
service at 20:26:02 was not established from the journal.

## Fix

- The controller's owner calls (release manager and deployment-run state) wait for the owner's
  socket to accept the connection, on the bounded owner-restart retry policy; only never-reached
  requests and reads are resent.
- `deploy.sh` runs every command whose output it captures during candidate preparation through
  one helper that keeps stdout and stderr on failure, adds their tails to the failure reason,
  and copies them into the repair incident's `failed-command/` folder.

## Acceptance scenario

- **Seed:** a scratch state directory with no `request-owner.sock`.
- **Action:** a release-manager owner call starts; a listener appears on the socket 4 seconds later.
- **Expected:** the call succeeds as soon as the listener accepts, with `deployment_owner_socket_wait`
  lines on stderr; a POST whose connection is dropped is not resent; a failing captured command
  leaves `stdout.log`, `stderr.log` and `status.json` in the incident's `failed-command/` folder.
- **Replayable offline:** yes (scratch socket and scratch release root).
