---
failure: Concierge froze for seconds at a time while his phone polled the Inbox, delaying replies.
date: 2026-10-07
fix_commits: [08672901]
cause_status: confirmed
---

# Inbox polling froze Concierge for seconds at a time

## What was seen

On 2026-10-07 the owner process was held for seconds repeatedly while Tejas's phone checked the Inbox, and
his replies waited. The same restarts also re-logged years-old returned results as fresh errors.

## Cause

Confirmed from the commit and its code comments. The Inbox polls request receipts about every two seconds, with
232 open requests. `SessionCommunicationCoordinator.find()` built each receipt through `receipt()`, which
included `owner.view()` of the request's target session, a full session view that nothing read from the
receipt, so every poll paid that cost 232 times on the owner's loop. Second contributor:
`auditUndeliveredReturns` scanned every settled result on each communication wake, which runs many times a
second under load; it was a tenth of the owner's busy time. On each restart it also re-reported old unhandled
returns (`session_return_unhandled`) as new errors.

## Fix

08672901 (`session-communication.ts`, `session-return-audit.ts`):
- `find()` builds the receipt without the target view (`receipt(row, false)`).
- The returns audit runs at most once a minute (`AUDIT_EVERY_MS`), safe because nothing is reported before a
  ten-minute grace.
- Results older than `REMINDERS_SINCE_MS` or already recorded as `return_unhandled:<event>` are marked
  reported instead of logged again after every restart.
- Same commit: the meaning-search engine child is tied to Concierge's lifetime so it cannot outlive it.

## Acceptance scenario

- **Seed:** a ledger copy with ~230 open requests each targeting a session with a large history, plus old
  settled results from before reminders existed.
- **Action:** poll request receipts every two seconds for a minute while the owner also serves normal traffic;
  restart the owner once.
- **Expected:** `owner_event_loop_lag` stays under the repair threshold during polling; receipts contain no
  target view; the audit scan runs about once a minute; no old results are logged as new
  `session_return_unhandled` errors after the restart.
- **Replayable offline:** yes (scratch ledger and a polling loop; the timing check should compare against the
  pre-fix commit)
