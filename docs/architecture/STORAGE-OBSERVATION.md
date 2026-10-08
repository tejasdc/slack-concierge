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
# Interactive read refusal

Every owner GET route must match `presentation-reader-contracts.ts` or an exact named route in
`owner-get-policy.ts`; an unregistered route returns `READER_CONTRACT_REQUIRED` before invoking
its handler. The exceptions are existing control/exact-object entrances and explicitly named
legacy interactive reads. Each has a response cap, and the legacy entries are migration debt,
not a template for another page. `/sessions` is the unbounded whole catalogue and must be
removed after its peer consumer moves to prepared pages. `/sessions/:id` still embeds legacy
receipts; it cannot be treated as a cheap exact-object read. The exception table does not claim
those reads have bounded CPU cost or a growth fixture. New interactive reads require a prepared
contract and fixture; unknown old-style paths cannot become an accidental bypass.

A registered presentation route's database scope refuses
collection reads without a final SQL limit, iterators, writes, excess calls, returned rows or
returned value bytes. The encoded response has a separate byte budget. Refusal is a visible
503, never a silent truncation or full-history fallback. These guards bound materialization and
expose misuse; they do not prove rows visited by SQLite, so release growth fixtures and query
plans remain required. The registry's limits belong to the owner and are shared by consumers.

Each request now records a normalized start and completion under one random request identity,
including actual encoded JSON response bytes. A blocked or crashed request therefore leaves a
start even when no completion can be logged. Concurrent calls to the same route retain separate
in-flight identities. Streams retain separate lifetime/transport observations.
# Bounded owner collections

Saved messages, followed messages, waiting saved work, and the Lab's agent sessions and requests are separate indexed pages. Each page has a cursor and explicit coverage; the browser must offer continuation rather than treating the first page as the whole collection. Lab request membership follows the current project space of either participating session. A session move enqueues bounded reclassification slices in the presentation worker; the owner reads only the prepared request IDs and a fixed number of exact records. These reads have release fixtures at 100, 1,000, and 10,000 source rows and registered storage and response budgets. See `owner-collection-pages.ts`, `prepared-lab-requests.ts`, and the presentation reader registry.
