---
failure: Planned update restarts exited as crashes, so Tejas's Inbox said Concierge had crashed when nothing had broken.
date: 2026-10-07
fix_commits: [2686d3ac]
cause_status: confirmed
---

# Update restarts were announced as Concierge crashes

## What was seen

The 8:03 PM and 8:18 PM EDT exits on 2026-10-07 were both planned update restarts, yet the service exited
with status 1, systemd ran its `OnFailure` hook, and the Inbox told Tejas Concierge had crashed.

## Cause

Confirmed from the commit. During `drainAndStop` (`bot/src/index.ts`), `app.stop()` closed the deprecated
Slack socket while it was mid-reconnect; that close rejected with no error value. Nothing handled the
rejection, so Bun exited 1 and systemd treated the planned stop as a failure, which fed the crash notice
(`bot/scripts/service-failure-notice.sh`).

## Fix

2686d3ac: once drain begins, `unhandledRejection` and `uncaughtException` are logged as
`service_drain_error_ignored` instead of terminating the process, and `app.stop()` is wrapped so its failure
is logged as `slack_app_stop_failed`. Drain then finishes with its normal exit, and the crash notice only
fires for real failures.

## Acceptance scenario

- **Seed:** a running owner whose Slack app (or a stub with the same stop contract) is mid-reconnect and whose
  `stop()` rejects with `undefined`.
- **Action:** send SIGTERM as an update restart does.
- **Expected:** the process exits 0 after drain; the log has `slack_app_stop_failed` or
  `service_drain_error_ignored`; no `OnFailure` notice and no "crashed" message reach the Inbox.
- **Replayable offline:** yes (stub socket that rejects on close; scratch state directory)
