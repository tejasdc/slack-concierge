---
failure: Messages Tejas sent from his Mac and phone were saved but never delivered, held behind an earlier command that had given up or had never arrived.
date: 2026-10-16
fix_commits: [17e1a719, 5f7392f2, b51c3a65]
cause_status: best-explanation
---

# His later Inbox messages sat saved but undelivered behind a stuck earlier command

## What was seen

The Mac and phone Inbox streams held later human messages in the capture store without delivering them to Concierge.
Each stream was blocked at its head: one behind a read action whose automatic delivery had stopped (`exhausted`),
and others behind two browser sequence slots that never arrived (b51c3a65, 2026-10-18). Nothing alerted anyone: the
stuck-work watch only sees admitted turns, and these messages had not reached the owner yet.

## Cause

Human commands from a browser carry a per-client, per-session sequence number. Capture ingress
(`bot/src/human-command-state.ts`, `capture-queue-api.ts`) delivers a stream strictly in order, so a later ordinary
command waits until its predecessor settles. Two kinds of head never settled:
- **Exhausted:** `HumanCommandWorker.retryOrStop` (`bot/src/human-command-worker.ts`) gave an owner delivery one
  bounded retry window (about two minutes). After a Concierge or Thinkering outage longer than that, it called
  `/exhaust`: the command stayed `pending` with `exhausted_at_ms` set, reported `unconfirmed`, and only a human Retry
  could resume it. Everything behind it in the stream waited.
- **Missing:** the stream's next sequence had no row at all. Best explanation (5f7392f2): an older browser build
  discarded a command before it reached server custody, leaving a gap the queue could never fill and was correctly
  forbidden to invent. Not observed: the browser-side discard itself.

## Fix

- 17e1a719: an expired window no longer exhausts. The worker files one repair notice, then starts a fresh window
  with the same action ID and prepared bytes; the owner's idempotency key makes an ambiguous retry safe. Older
  `unconfirmed` heads can still be resumed with the same identity.
- 5f7392f2: a private, audited recovery operation marks one proven absent head as missing (it must be the current
  head, still absent, with a later ordinary command pending), releasing later commands with their original bytes and
  IDs and claiming nothing about the missing one.
- b51c3a65: the worker checks every 30 s for retained messages waiting at least a minute behind a missing or exhausted
  head and files one deduplicated notice per stream head to the standing repair agent, without message text.
Follow-on hardening of the recovery operation, not fixes of this failure: 5aa90f2b holds a late-arriving original
after a bypassed gap until a separate audited release; 57dc8663 reports a terminal cancellation ahead of that hold.

## Acceptance scenario

- **Seed:** A capture store with stream (client C, session S) whose next sequence is 3; no row for sequence 3; a
  pending ordinary input command at sequence 4 retained two minutes ago. Separately, a stream whose head delivery
  meets an owner returning 503 for five minutes.
- **Action:** Run the human-command worker.
- **Expected:** One repair notice names C, S, sequence 3, `missing`, one waiting message. After the audited
  missing-slot release, sequence 4 is delivered once with its original action ID. The 503 stream's head keeps retrying
  in new windows and is delivered when the owner answers, with no human Retry and no `unconfirmed` state.
- **Replayable offline:** yes (capture database plus a stub owner endpoint)
