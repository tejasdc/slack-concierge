# Asynchronous ledger command authority

Status: implementation work in an isolated branch; **not an activated service change**.

## Requirement and measured failure

Tejas asked for request flow to stay responsive while the ledger is slow, with exact accepted-input identity, replay semantics, progress visibility, and successful-sync receipts intact. The current Linux owner already sends WAL `fdatasync` to a separate thread. That removes the disk sync syscall from its event loop, but the owner still performs synchronous business SQL and transactions before the durability barrier. A 2026-11-07 04:32:34 UTC labelled receipt spent 2,325 ms in a physical WAL sync with zero owner delivery delay; changing command execution cannot shorten that particular syscall. Other captured turns spent seconds in owner SQLite statements, including a separate 04:32:59 owner delivery delay. The change below targets that second class and independent reads/progress while a write waits. It does not promise a successful durable receipt before the physical disk confirms it.

The accepting process is one personal server service. The foreground gateway, read executors, application owner, sync thread, checkpoint thread, provider hosts, and release controller have different lifetimes. Only the command authority may decide a mutation; read executors cannot accept an input or certify durability. The installed release and the source branch are separate proof layers.

## Current authority and migration size

- `bot/src/state-database.ts` opens the canonical synchronous Bun SQLite connection on the owner event loop. `bot/src/routed-request-api.ts` executes mutations there and waits for `ledgerDurable()` before returning non-GET receipts.
- `bot/src/ledger-durability.ts` samples connection-local `total_changes()` after the current transaction and releases waiters only after its long-lived WAL sync descriptor reports a successful `fdatasync`. Sync-worker loss exits the accepting process rather than replacing a descriptor that might miss a writeback error.
- `bot/src/session-inputs.ts` checks stable `(scope, action_id)` and payload/origin equality in the transaction that allocates an accepted input. `bot/src/session-owner.ts` surrounds that call with queue, forwarding, Inbox, and turn decisions. Provider effects are separately fenced by the durability barrier.
- A source inventory on this branch found 100 direct DB-using files and 249 lexical `db.transaction(` sites. These counts are source scope, not runtime frequency. A per-statement worker proxy cannot preserve synchronous transaction callbacks or read-after-write decisions.

## One invariant

**One ordered command executor owns every canonical business read/decision/write transaction and the connection-local committed change target. An accepted receipt or external effect may leave only after that command has committed and a successful WAL sync on the same generation covers its target.** A command that may have committed but lost its response is recovered by its existing exact action/input identity; it is never guessed absent or resubmitted under a new identity. An observer, timer, callback, deployment command, or provider result that mutates the canonical ledger enters this same command order. A read-only projection can use another connection but cannot certify acceptance.

The executor replies with `{commandId, generation, committedTarget, result}` only after COMMIT. The parent retains the command's effect plan but does not execute it until the durability proof covers `committedTarget`. It may answer GET and liveness, and publish explicitly provisional in-memory progress, while the executor or sync thread waits. A failure after a possible commit but before that reply terminates the accepting process; the next process reopens the ledger, resolves the command by exact ID, and does not replay an ambiguous provider send. A failed sync or lost sync descriptor also terminates the process. This keeps the current successful-sync promise.

Provider progress is captured with its exact event/input identity when observed. Its existing scheduled flush remains at most one second when the executor is available, with a bounded queue and foreground receipts/effects ahead of optional progress. A held writer or disk makes durable progress visibility unbounded; the UI must show the truthful pending stage rather than assert it was persisted. Nothing may shed an accepted input. A provisional progress channel needs its own explicit visibility and recovery semantics before activation.

## Command exchange and lifetime

1. The authenticated gateway keeps the stable admission/action ID and forwards one command. A lost command result stays unconfirmed; the gateway does not synthesize a successful receipt or silently retry under another ID.
2. The long-lived command executor serializes complete named owner operations, including the reads that determine their writes and nested transactions. It returns only a postcommit target or an explicit no-commit refusal. It must never send a precommit ID as acceptance proof.
3. The WAL sync thread holds its descriptor **before** the executor switches to `synchronous=NORMAL`. It confirms a target sampled after COMMIT; a later target may require the next sync. An already running earlier sync is never represented as proof for a later commit.
4. The parent releases the exact response and then any external effect only after the target's successful sync. The command and effect identities are retained so restart can distinguish unsent, sent, and ambiguous states.
5. On worker death, missed result, sync error, or incompatible generation, the accepting process fails closed and restarts under the existing deployment/supervision owner. The candidate becomes ready only after command authority, WAL descriptor, and recovery are ready. The old release must stop before candidate activation.

Bound the command queue by count and bytes. Saturation holds a new command at the gateway with its stable admission ID and an explicit pending response; it must not accept then discard. Timers and optional progress cannot monopolize the command queue. Exact queue ordering, cancellation, and priority must be specified against the existing session and request contracts before production wiring.

## Decision case

| Path | Where it helps | Where it fails or remains unknown |
| --- | --- | --- |
| Keep the existing owner plus sync worker | Preserves current proven receipt and replay contract; no migration risk. | Synchronous business SQL can still block every owner callback and delay an already finished sync result. |
| Move one SQL statement or one write to a worker | Could remove that statement's event-loop occupancy. | Splits atomic acceptance and read/modify/write decisions across connections; cannot certify the existing connection's change target. Unsafe as the canonical repair. |
| Put all business commands and the canonical writer behind one async executor | Preserves one decision/transaction order while the parent serves independent work; gives one place to measure queue/commit/sync/delivery. | Requires migration of every mutating caller and effect boundary, replay checks, and old/new release compatibility. Required receipts still await physical sync; a single blocked writer still queues later writes. |
| Replace SQLite or loosen durable receipts | Could change physical waiting or throughput. | No captured critical-path evidence supports a different engine or weaker promise, and it changes the accepted-input contract. |

The third path meets the requested owner responsiveness without changing the durability meaning. It is selected for implementation on this branch. It is **not** a claim that the physical WAL stalls are app-caused or removable by command scheduling.

## Required implementation slices before activation

These are one candidate's dependencies, not separately activated features.

1. Build a typed command channel with a bounded queue, worker generation, postcommit target, explicit refusal and unknown-after-crash state. Keep the business connection private to the executor. Exercise private SQLite crash and reply-loss schedules.
2. Move the full accepted-input admission command first in source, then all other canonical mutations (session, Inbox, requests/replies, runner, peer, timers, provider callbacks, deployment commands) to the same executor. No owner-side canonical write may remain. Make the build refuse a newly introduced owner write/import after cutover.
3. Keep business decisions inside commands. Split external provider/network/file effects from transactions into retained effect intents. Verify exact input/action identity, nested transaction semantics, and no duplicate effect on retry.
4. Adapt the existing WAL sync barrier to executor-owned postcommit targets. Prove an earlier in-flight sync cannot release a later commit. Preserve the long-lived descriptor and fail-closed behavior on lost writeback proof.
5. Keep reads and truthful provisional progress independent of the executor. Prove no optional flush makes an accepted receipt wait behind a maintenance scan. Measure gateway admission, writer queue/statement, commit, sync, owner delivery, and provider acknowledgement separately.
6. Prove crash before COMMIT, crash after COMMIT before reply, sync failure, restart replay, concurrent commands, progress under a held writer, release drain, and old/new artifact compatibility on a disposable database. Run required release checks, install only the complete candidate through the normal controller, then exercise one real routed request and observe one natural slow operation before claiming latency improvement.

## Evidence and stop rule

`bun run bot/scripts/async-ledger-authority-prototype.ts` uses a newly owned `/tmp` SQLite database, a writer worker and a WAL sync worker. On 2026-11-07 05:00 UTC it passed controlled cases for death before COMMIT with rollback, an intentionally held WAL sync while parent liveness remained available, ordered concurrent commit targets, conflicting retry, death after COMMIT before reply, exact-ID recovery in a new accepting lifetime, and sync-worker death without receipt release. Its result is **prototype evidence only**: it does not exercise a production owner command, power loss, deployment transition, or a real routed request. It cannot establish that all 100 DB-using modules have moved.

The branch must remain uninstalled until every mutation enters one command authority and the checks above pass. If the 10 AM New York restoration deadline arrives first, preserve this branch and the exact remaining implementation list; keep the original request-flow incident open. A measured physical-sync wait remains a separate obligation with the host investigator. The async authority can eliminate owner-loop occupancy and post-sync callback delay; it cannot promise a durable receipt sooner than the disk or a currently blocked single writer permits.
