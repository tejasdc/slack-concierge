---
failure: Mark read on the Mac was delayed 5.8 seconds in owner delivery by ledger I/O contention on the serial event loop.
date: 2026-11-23
fix_commits: []
cause_status: confirmed
---

# Mark read on the Mac was delayed 5.8 seconds in owner delivery

## What was seen

The 2026-11-23 nightly review measured `topic.action` confirmation p95 over budget at
1,514 ms (against a 1,500 ms target in `docs/runbooks/nightly-review.md#3a`). Retained Mac
Inbox mark-read incident action `ccc3022d-a6b5-4e36-99f9-7a66b8463c4d` in the interval
03:43:47–55 UTC showed 11 ms local UI screen prediction, but final status confirmation took
6,692 ms. The client waited 6,003 ms before falling back to status polling
(`commandConfirmationSource: "status"`). On the Concierge owner, delivery took 5,802 ms
(`human_command_owner_settled`).

## Cause

Contention on the single-threaded owner event loop across three sequential operations during
disk I/O:

1. The mark-read mutation itself (`POST /sessions/v1/inbox/topics/:id/actions`, request
   `a4b4cbd3-1b1a-4e2c-8bd9-f062ae0a8965`) ran synchronously in `humanMutation`. Its statement
   `INSERT INTO session_inputs...` (fingerprint `6bf319d4baacb4c9`) spent 1,100 ms waiting in
   Linux uninterruptible disk sleep ('D' state on `folio_wait_bit_common`). Total DB time was
   2,222 ms across 146 calls, request duration was 2,238 ms, and owner event loop lag reached
   2,194 ms (blocked 2,269 ms, ledger wait 2,245 ms).
2. This loop freeze delayed delivery of the completed WAL sync `sync_id: 5840` (`fdatasync`
   646 ms) by 1,647 ms.
3. Immediately following, a background runner sync (`POST /runner/v1/sync` sharing time with
   `POST /sessions/v1/sessions/:id/inputs`) blocked the loop for 2,497 ms (ledger wait 2,400 ms,
   statement fingerprint `f3bbdab217488abb` also sleeping in 'D' state on `folio_wait_bit_common`).
   Event loop lag reached 2,447 ms.
4. This second freeze delayed delivery of WAL sync `sync_id: 5841` (which carried the mark-read
   command `a4b4cbd3-1b1a-4e2c-8bd9-f062ae0a8965`, `fdatasync` 956 ms) by 1,742 ms.
5. A routed communication ask (`POST /session-communication/ask`, statement `b0d6d1fae311aaee`)
   added another 735 ms blocked wait (ledger wait 690 ms, loop lag 565 ms).
6. Competing with this, a 64.5 MiB passive WAL checkpoint (`16,432` frames, `ledger_checkpoint`)
   was running on the checkpoint worker for 6,864 ms (`ioPressure: 2.69`), causing ext4 page
   cache contention.

All told, owner delivery took 5,802 ms, pushing client-observed confirmation to 6,692 ms.

## Fix

Join this failure to the asynchronous ledger command authority (PR #707,
`docs/plans/2026-11-07-async-ledger-authority.md`). Moving synchronous business transactions
off the owner event loop to a dedicated ordered command executor worker ensures that kernel
uninterruptible disk sleep during `session_inputs` insertion or runner sync does not freeze
the event loop. The owner can continue answering GETs and status polls while postcommit targets
await physical sync on the WAL sync worker. Durable command settlement invariants are preserved:
a command confirms only after physical WAL sync on its committed target generation.

## Acceptance scenario

- **Seed:** An admitted mark-read action `ccc3022d-a6b5-4e36-99f9-7a66b8463c4d` arrives during heavy concurrent ledger writes (runner sync and WAL checkpointing).
- **Action:** Deliver the mark-read action through the owner command authority and observe event-loop lag, writer execution time, and WAL sync release.
- **Expected:** The owner event loop remains responsive (lag < 100 ms); the command commits and awaits durable WAL sync without delaying or being delayed by unrelated event-loop callbacks; client status confirmation settles within budget without timeout-driven polling fallback.
- **Replayable offline:** yes, via `bot/scripts/async-ledger-authority-prototype.ts` and disposable SQLite ledger fixture with concurrent writer and WAL sync simulation.
