---
failure: The Mac's Concierge restarted every 5 to 10 seconds whenever a reconnecting phone or browser's event-stream page failed.
date: 2026-10-15
fix_commits: [4b98c57f]
cause_status: confirmed
---

# The Mac's Concierge restarted every few seconds after an event-stream page failed

## What was seen

From 15:26 UTC (11:26 AM) on 2026-10-15 the Mac owner crash-looped, restarting every 5-10 seconds, which stalled
Mac work. It happened when a phone or browser reconnected to the live event stream while the owner's readers were
busy.

## Cause

Confirmed from the commit message and diff. In the event-stream page loop in `bot/src/session-owner.ts`, the
`catch` for a failed page called `log.warn(...)`, but the shared `log` is a plain function with no `warn` member.
The error handler itself threw a `TypeError` outside any handler, an uncaught exception that killed the process;
the service manager restarted it and the next reconnect repeated it.

## Fix

4b98c57f changes the call to `log('warn','session_event_stream_failed',{error:String(error)})`, so a failed page
is logged and the stream stops cleanly instead of taking down the owner.

## Acceptance scenario

- **Seed:** A running owner with an open event-stream subscription whose page read is forced to throw (a busy or
  failing reader).
- **Action:** A client reconnects and requests a stream page that fails.
- **Expected:** One `session_event_stream_failed` warn line is logged, that stream closes, the owner process stays
  up with the same pid, and other streams and requests keep working.
- **Replayable offline:** yes (inject a throwing page reader; no Mac needed)
