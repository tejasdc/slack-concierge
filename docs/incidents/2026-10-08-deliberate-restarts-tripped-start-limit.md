---
failure: Six updates in ten minutes tripped the safety limit meant for crash loops, leaving Concierge and capture intake switched off.
date: 2026-10-08
fix_commits: [efc3fffa]
cause_status: confirmed
---

# Several updates in a row left Concierge stopped

## What was seen

On the morning of 2026-10-08 six pushes deployed within ten minutes. The sixth deliberate restart was refused by
systemd, and Concierge and capture ingress stayed stopped until someone intervened. (The capture ingress start
limit seen at 08:04 UTC in the separate
[capture ingress startup record](2026-10-08-capture-ingress-outage-crashed-concierge-startup.md) belongs to the
same morning.)

## Cause

Confirmed from efc3fffa. Both units use `StartLimitBurst=5` per 600 s to stop crash loops, but systemd counts
every start, including restarts the deployment runner asks for. `bot/scripts/deploy.sh` and
`deployment-repair-cutover.sh` called `systemctl restart`/`start` directly, so ordinary updates consumed the
crash budget.

## Fix

efc3fffa: `restart_unit` and `start_unit` in `deploy.sh` run `systemctl reset-failed` on the unit before each
start the runner requests (service, capture ingress, LKG restore path); the repair cutover uses the same. The
limit still stops a genuine crash loop, never an update.

## Acceptance scenario

- **Seed:** a unit with `StartLimitBurst=5`, `StartLimitIntervalSec=600`.
- **Action:** run the deploy restart path six or more times within ten minutes.
- **Expected:** every restart succeeds and the unit is active; a unit that crashes on its own five times within
  the window is still stopped by systemd.
- **Replayable offline:** yes (a scratch systemd unit on a test host)
