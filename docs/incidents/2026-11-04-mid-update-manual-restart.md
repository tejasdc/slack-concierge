---
failure: A direct service restart interrupted Concierge while its deployment checked a candidate.
date: 2026-11-04
fix_commits: [4f6e7621]
cause_status: confirmed
---

# Direct restart interrupted a candidate check on November 4

## What was seen

- At 20:24:00 Eastern, deployment run `031eadf3-a765-4664-829b-8c50f6d7ed79`
  claimed the deployment gate and began updating toward `c4387e59`.
- At 20:26:02 Eastern, systemd stopped `concierge-bot.service` while the
  deployment's candidate check was still running. The owner logged SIGTERM with
  eight active turns. The candidate check passed at 20:26:15, after the stop.
- The retained Claude Code transcript for session `09cd285c-ae9b-40fd-9a90-392fe32e7ce8`
  records a command at `2026-11-05T01:26:02.774Z` from the runner acceptance worktree:
  `timeout 300 systemctl restart concierge-bot.service`. This supplies the caller
  that the systemd stop line did not record. The deployment ledger later marked the
  run failed because the service invocation changed before candidate activation.
- The earlier 17:05 UTC restart was a normal deployment stop in unit
  `concierge-deploy-c21cae96-43a.service`. Systemd stopped Concierge at 17:05:22
  UTC. The server Codex session began a Claude Code reinstall at 17:05:47 UTC,
  after that restart. The earlier report's “5:06 PM ET” label conflated UTC with
  Eastern time; the service event was 12:05 PM Eastern.

## Cause

Direct service restarts can bypass the deployment gate, even if the gate correctly
waits for running agent turns.

## Fix

The service refuses manual stops. A
deployment that has claimed its gate stops Concierge through a named, short systemd
conflict transaction ordered after the service's stop; the transaction's description records the deployment run and
stage. The host supervisor starts a stopped service and uses systemd's automatic
restart for a frozen owner. It has no reason to restart a running service manually.

The controller support must install before the service refusal. An older controller
uses a direct stop and would be refused by the new unit. The first release adds the
compatible controller path and updates the host supervisor. The second release
enables the service refusal. Verify the installed property, a direct restart refusal
on a disposable service, the deployment's named stop, and the new release's health.

This guard prevents ordinary `systemctl stop` and `restart` calls from interrupting a
live service. It does not claim to protect against an intentionally privileged root
process using signals or changing the systemd unit; those actions remain outside
the deployment contract and need their own provenance if used.

## Acceptance scenario

- **Seed:** Concierge is running on a release whose unit refuses manual stops, and a
  separate deployment has claimed its update gate while checking a candidate.
- **Action:** An agent attempts `systemctl restart concierge-bot.service`.
- **Expected:** systemd refuses the command and keeps the running service invocation;
  the deployment later records its named, ordered stop and starts the candidate.
- **Replayable offline:** no (the refusal and ordered stop require a systemd service;
  use a disposable service for the refusal and stop ordering probe).
