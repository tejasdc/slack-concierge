---
failure: A burst of merges to main restarted Concierge about twenty times in four hours while Tejas was working, refusing his requests and freezing the owner after each restart.
date: 2026-11-02
fix_commits: []
cause_status: confirmed
---

# Twenty Concierge restarts during one evening's merges

## What was seen

Between 02:00 and 06:00 UTC on 2026-11-02 (Tejas working on his Mac, 10 PM–1 AM ET), PRs
#285–#312 merged to `main` 2–14 minutes apart. `journalctl -u concierge-bot` shows a
`Stopping concierge-bot.service` / `Started concierge-bot.service` pair after nearly every one
(for example 23:03:13, 23:14:11, 23:16:50 and 23:24:15 EST). Thinkering's nightly review
(`thinkering/tmp/reviews/nightly-2026-11-02-perf.md`, item 2) counted the cost: 2,264
`SESSION_OWNER_UNAVAILABLE` lines, event-loop lag up to 6.4 s, two Mac conversation opens that
never rendered after 120 s, 246 of the night's 302 writer freezes, hourly backups at
800–1,070 s instead of ~400 s, thread actions taking 10–50 s, and share captures refused with
502/503/404/409.

## Cause

The deployment worker created a run for every push as soon as no run was active. Pushes landing
before a run's activation intent already joined that run, but its build takes about two minutes
under the drain gate, so a push every few minutes nearly always arrived after it and started the
next run, often within a second of the previous one finishing (23:14:41 → 23:14:42). Each run
holds new agent turns for ~2.5 minutes, restarts the owner, and is followed by minutes of
startup catch-up lag.

## Fix

An automatic update now starts only when `main` has been quiet, and Concierge has been settled
since its last update, for 10 minutes; a burst that never pauses still installs 30 minutes after
it began (`automaticDeploymentStartsAtMs` in `deployment-state.ts`, applied by the worker before
it creates a run, with a timer to wake it at that instant). Replaying the evening's 27 real merge
times: 24 restarts under the old rule, 7 under this one, the newest push waiting at most
34 minutes. A zero-gap handover was not chosen: it needs two owners sharing the one canonical
ledger writer, a far larger change, and it would still pay the build and startup catch-up cost
on every merge.

## Acceptance scenario

- **Seed:** an installed release; deployment worker running.
- **Action:** two pushes to `main` four minutes apart, then none.
- **Expected:** one `deployment_settling` log per push, one deployment run created ten minutes
  after the second push, one `Stopping/Started concierge-bot.service` pair, and the installed
  release is the second push's commit.
- **Replayable offline:** yes (scratch ledger: `automaticDeploymentStartsAtMs` against recorded
  push and run times).
