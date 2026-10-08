# Storage work attribution

The shared ledger connection is wrapped by `observedDatabase` in `state-database.ts`.
`observeStorageOperation` scopes synchronous database work through async request execution;
overlapping requests have separate counters. It does not create another connection, writer,
transaction boundary or query queue. Existing transaction and iterator ownership remain intact.

Each completed scope reports statement calls, database duration, returned rows, value bytes,
query failures and the slowest prepared-statement fingerprint. Only a truncated SHA-256 of
the statement is retained, never SQL, parameters or result text. `db_result_bytes` counts
UTF-8 strings, blobs and numeric values returned by the driver; it excludes object overhead,
column names and JSON escaping. It is neither process heap size nor response wire size.
`db_rows` means returned rows, not SQLite rows examined. Query plans and growth fixtures
remain necessary to detect scans returning few rows. Transactions themselves are not counted
as statements; statements executed inside them are. Iteration counts one call and each row
as consumed, including the time spent advancing it; early-exit finalization still belongs to
`ledgerRows`. Raw exec/run calls count time and failures but have no returned-row measurements.

Outside an observation scope, database calls retain normal behavior without result-size walks.
Prepared statement wrappers are weakly held. There is no growing query-history cache. Finished
scopes ignore later detached work; background work must establish its own explicit scope.
An observation sink failure increments `storageObservationFailures()` and never replaces a
successful command or its original failure. Callers expose this loss count in their telemetry.

The release build runs `bot/scripts/storage-observation-check.ts`; it uses only its own in-memory
database. It checks overlapping async scopes, query errors, byte semantics, transaction behavior,
iterator finalization and sink failure, and reports large-result observation overhead. It never
imports the application ledger or configures a production state path. Instrumentation is not a
performance gate by itself: readers and releases must enforce their separate cost contracts.

Routine owner memory readings also export the observation-loss counter, with RSS, heap,
external and array-buffer sizes. They do not walk the heap when it is already large. The
external host observer owns process/swap/pressure evidence during a blocked event loop.
