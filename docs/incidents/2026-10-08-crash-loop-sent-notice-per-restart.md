---
failure: A service that kept failing to start sent a new failure notice on every automatic restart, five within a minute.
date: 2026-10-08
fix_commits: [c8294403]
cause_status: confirmed
---

# One crash loop produced a notice per restart

## What was seen

At 4:04 AM EDT on 2026-10-08, while Concierge crash-looped at startup (see the
[capture ingress startup record](2026-10-08-capture-ingress-outage-crashed-concierge-startup.md)), five
service-failure notices were filed within one minute, one per restart, for a single episode.

## Cause

Confirmed from c8294403. The systemd failure hook `bot/scripts/service-failure-notice.sh` filed a notice every
time it ran. A unit in `auto-restart` runs the hook on each failed start, so one episode produced one notice
per restart attempt.

## Fix

c8294403: when the unit's sub-state is `auto-restart` and its restart count is non-zero, the hook exits without
a new notice ("restart N in an episode already announced"). Only the first failure after a deliberate start is
announced; if the unit never recovers, the "stopped" notice follows. The same commit removed the duplicate
update-wait Inbox notice Tejas rejected (the update line already shows the wait).

## Acceptance scenario

- **Seed:** a unit with `Restart=on-failure` whose process exits immediately, with the failure hook installed.
- **Action:** start it and let it fail five times.
- **Expected:** exactly one failure notice for the episode, then one "stopped" notice when systemd gives up; a
  new deliberate start that fails later produces a new single notice.
- **Replayable offline:** yes (scratch unit with the hook pointing at a stub notice sink)
