---
failure: A natural Concierge release paused request handling for more than seven seconds while the accepting thread waited for a Bun SQLite registry lock.
date: 2026-11-16
fix_commits: []
cause_status: best-explanation
---

# Release request handling paused at a SQLite registry lock

## What was seen

During an ordinary managed release, request acceptance was interrupted for 17.98 seconds. The outgoing process recorded a 7.388-second idle capture join and 7.226 seconds of event-loop lag. An external native trace placed the accepting thread in Bun's SQLite transaction-state accessor for 7.338 seconds, waiting for its process-wide database registry lock. The trace did not resolve the JavaScript caller or identify the lock holder. The capture join was concurrent with the wait; it is not proven to have caused it.

## Cause

The durability pump read the transaction-state accessor on every eligible periodic sample. Its only call sites run in a microtask, timer callback, or worker-message callback after the accepting connection's synchronous transaction wrapper returns. The accessor's registry lookup can wait for another Bun SQLite connection in the same process. This is the best explanation for the observed call site, not a claim that the actual lock holder was captured. A cache miss while preparing the change-counter query could also reach that registry lock.

## Fix

The pump no longer reads the transaction-state accessor. It prepares a dedicated change-counter statement on the existing accepting connection before serving starts and retains it outside the bounded query cache. It still captures a target before posting a sync and credits only a successful sync reply for that target. Worker lifetime, receipt barriers, and provider-send barriers are unchanged. The full request gap and exact provider-result continuity remain to be accepted on natural releases.

## Acceptance scenario

- **Seed:** Use the pinned Bun runtime, one accepting SQLite connection with the installed observation and transaction wrappers, a live durability sync worker, and a second worker connection exercising the registry lock.
- **Action:** Commit an accepted input, request durability from within a synchronous transaction callback, and allow the periodic pump to run during an ordinary release drain while the external observer records the accepting thread.
- **Expected:** The pump samples only after the transaction wrapper completes, uses its retained statement without preparation or a transaction-state lookup, and releases the dependent receipt only after a successful sync covering its captured target. A later committed write requires later coverage. The outgoing release has no corresponding registry-lock wait in this pump; exact accepted input and provider-result identities survive the handoff.
- **Replayable offline:** no (the Bun lock contention and request handoff require a live process and external native observation; the transaction and coverage ordering can be checked on an isolated ledger).
