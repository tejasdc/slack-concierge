---
failure: A Codex observation kept the ledger busy after release drain began, delaying capture shutdown and request recovery.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# Codex observation delayed a Concierge release

## What was seen

During the 06:43 UTC managed release, Concierge stopped accepting requests at
06:43:11.337 and reopened its request API at 06:43:38.391. Capture shutdown took
9.304 seconds. The owner recorded a 9.290-second synchronous ledger lock wait in
the Codex lifecycle observer after drain began. The source of that write was a
lifecycle refresh, not capture delivery.

## Cause

The owner let observational provider callbacks continue while it awaited capture
shutdown. An in-flight lifecycle refresh could enter a synchronous ledger
transaction after drain began, preventing capture cancellation from running on
the event loop. The observer also waited for provider reads before closing its
own connection, so moving its stop earlier alone could add a provider deadline
to shutdown.

## Fix

Planned drain stops observer admission before the first awaited shutdown step.
Lifecycle, history and retry continuations check the stop before writing. The
observer immediately rejects pending reads and closes only its own App Server
bridge, then joins its work. Active turn execution retains its separate App
Server connection and its existing custody and result persistence path.

## Acceptance scenario

- **Seed:** A Codex observation has an in-flight lifecycle read that will not
  answer, and capture delivery has an unanswered claim.
- **Action:** Begin a managed release drain.
- **Expected:** The observer's pending read is released promptly, it starts no
  lifecycle or history ledger write after stop, capture cancellation progresses,
  and the next owner resumes exact requests and active turns.
- **Replayable offline:** yes (with a stalled observer client and an injected
  capture claim; the installed interruption still requires live measurement).
