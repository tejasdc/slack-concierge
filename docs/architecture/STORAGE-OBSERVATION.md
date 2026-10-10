# Storage work attribution

## Startup transaction ownership

`state.ts` creates the base ledger schema in one immediate transaction and applies
legacy column/index upgrades in a second immediate transaction. Multi-statement
`db.exec` alone does not group SQLite commits: without these boundaries, a fresh
ledger pays a durable commit for each schema mutation. Nested migration transactions
remain savepoints, including when the deployment migrator already owns the writer.
Read executors skip both batches. No journal or synchronous setting is weakened.

The legacy batch ends before `initializeSessionOwnerSchema`, which switches foreign
keys before entering its own transaction for table rebuilds. Wrapping that call in
the new batch would make SQLite ignore its foreign-key setting. Search initialization
also retains its existing transaction owner.

On October 10, candidate `48b5b4208f0ade861458d47ab59adcd634e6b4d9` failed its
45-second topic projection lifecycle deadline. The retained deployment journal shows
owner imports consuming 36,836 ms and 41,065 ms on two preparations; the latter
started its worker at 41,785 ms. The earlier attempt projected creation and rename,
then reached the restart checkpoint too late to wait for the existing ten-second lease.
The confirmed startup defect is per-statement schema commits; their contribution to
those import intervals was not separately timed. Batching removes that amplification
without extending deadlines, changing scratch isolation, or skipping lifecycle work.
This repair was committed without tests or reviews under the incident's explicit
policy; the external supervisor and detached controller own subsequent validation
and activation evidence.

### Presentation worker startup

The presentation worker installs its base schema, compatibility upgrades and all
five prepared-store schemas in one immediate transaction on `presentation.db`.
Its busy timeout and WAL selection precede that transaction. Constructor-local
transactions remain savepoints; any failure rolls back the entire schema batch.
The canonical ledger connection remains physically readonly, and lease acquisition,
page processing and ready checkpoints retain their existing boundaries. Neither
SQLite durability settings nor lifecycle deadlines change.

Candidate `17db53ff96cad321132414617d30cae5f040a1db` reached owner-loaded at
2,669 ms, started the worker at 2,704 ms, then exhausted the 20-second first-checkpoint
wait at 22,715 ms. The retained journal error was `Projection did not reach canonical
head 1; worker=running` with empty worker stderr. SIGKILL came from fixture cleanup
after the timeout, not a preceding worker crash. The worker still performed its
schema mutations as individual autocommits, including the five projection constructors.
That confirmed write amplification is removed by the shared transaction rather than
by extending the wait or relaxing durability. Nearby owner journal records also show
low-CPU storage stalls, but the failed child discarded stdout and retained no schema
or syscall timings: attribution of its full wait to schema commits remains an inference.

The worker emits bounded, content-free `presentation_worker_schema` records at
`starting` and `ready`, with its PID and completion elapsed milliseconds. These
separate schema startup from the existing lease/projection health observations in
the application journal; they do not claim that a prepared generation is ready.
The lifecycle fixture currently discards worker stdout, so those records are not
part of its retained failure stderr. This correction was committed without running
tests or reviews; integration and activation proof remain with the external supervisor
and detached controller.

## Write results and observation

Ledger writes pass through `ledgerWriteResults` before observation. Its mutation result counts
only directly changed rows, using SQLite `changes()` synchronously on the same connection.
Bun's raw `.run().changes` also counts trigger writes: presentation journaling made one claimed
turn report three changes, so the queue committed it as running but returned no claim. The
adapter preserves journal triggers, transaction ownership and insert identity while making
existing exact-one lease checks valid. Standalone writers that open the canonical ledger,
including service notices, project registration and deployment controls, use the same adapter;
the release check refuses every new writable `bun:sqlite` constructor unless it is directly
wrapped by `ledgerWriteResults` or matches one registered non-ledger/isolated-fixture
constructor expression in its exact file. It recognizes default, named (including renamed), and
namespace constructor imports and checks the candidate application
before sealing; the preactivation application check also verifies a distinct control-source
commit. The registry is in `bot/scripts/ledger-constructor-check.ts`. The check is static:
it does not prove the runtime value of an exception's destination variable, so review any
change to an exception's path provenance with its registration.
Telemetry stays separate from this write-result contract. See the October 8 dispatch incident.
The presentation release gate runs `dispatch-claim-fixture.ts` against an isolated canonical
ledger with the real journal triggers: a raw Bun update demonstrates the inflated count,
then the shipping queue coordinator must hand one claimed turn to a recording runner exactly
once and find no second claim. No provider starts.

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

The accepting loop additionally enables `storage-interval.ts`. Each loop probe consumes one
bounded interval of the ledger connection's synchronous storage occupancy, including background calls, preparation,
iterator advancement/finalization and transaction commit/rollback. Nested statements are counted
but their duration is not added twice to occupancy. Transaction duration includes its callback's
synchronous work; it is not a measurement of SQLite CPU alone. Other processes do not enable
this collector. There are no result-size walks outside the existing request scope.
Other SQLite connections (including meaning, capture and project databases) are not covered;
low recorded occupancy does not exclude a wait on one of those connections.

`owner_event_loop_lag.storage` reports calls, transaction count, occupied milliseconds,
observation failures and one slowest call of at least 25 ms. That call has a SQL fingerprint
(or null for a transaction), duration and at most eight bounded caller frames. It contains no
SQL, parameters or results. The interval resets even when the tick is fast. Caller detail is
retained in the local journal only; the hosted collector retains its existing allowlisted lag
fields. Compare occupancy with lag and process CPU, then use the exact installed bundle/caller
to locate the operation. A high occupancy does not distinguish disk contention from expensive
query execution by itself; the outside process/I/O evidence supplies that distinction.

This closes the October 8 attribution gap where 37 seconds of low-CPU blocking occurred with no slow
completed requests. Request timers begin after dispatch and cannot measure waiting before a
handler enters the loop. A read-only diagnostic copy also consumed live disk resources; see
the incident record rather than interpreting "read-only" as "no performance effect".

The release build runs `bot/scripts/storage-observation-check.ts`; it uses only its own in-memory
database. It checks overlapping async scopes, query errors, byte semantics, transaction behavior,
iterator finalization and sink failure, and reports large-result observation overhead. It never
imports the application ledger or configures a production state path. Instrumentation is not a
performance gate by itself: readers and releases must enforce their separate cost contracts.

Routine owner memory readings also export the observation-loss counter, with RSS, heap,
external and array-buffer sizes. They do not walk the heap when it is already large. The
external host observer owns process/swap/pressure evidence during a blocked event loop.
# Interactive read refusal

## Execution isolation

The root request socket and authenticated peer listener belong to `foreground-gateway-worker`,
not the canonical application's event loop. `foreground-boundary-check.ts` walks its import
graph and refuses application storage, synchronous calls and direct console output. The shared
bounded logger owns its separate sink-backpressure check. Startup socket cleanup is asynchronous
and refuses a live listener; the gateway never takes a socket from another process.

`native-read-routes.ts` assigns each registered GET to a readonly executor, genuinely live owner
dependency or event stream. Two persistent read executors provide independent capacity when one
reader blocks. A finite response owns its slot through body completion; event streams have a
separate domain. Historical attribution (`/work-thread`) searches provider transcripts and is
classified as archival work. At most one reader can serve that class, and interactive reads
pass queued archives. Each class has its own 64-request admission budget: an archive flood
cannot consume the interactive queue or both executors. Health exposes class occupancy,
queue size and oldest waiting age. This reuses the two readers instead of adding another
process: installed evidence showed both slots scanning transcripts while a history read waited
about three seconds for admission. The queue retains at most 128 requests in total, and admission plus response share
the existing 20-second read deadline. A departing caller cancels its queued admission or drops
its response; already executing work retains its slot until it finishes. Only executor deadline
expiry retires that readonly executor, so its still-running synchronous call cannot capture the
next request and ordinary navigation does not repeatedly destroy warm readers. A command is forwarded
once to the canonical backend and is never killed or replayed when its response is lost.

The gateway generates `x-concierge-admission-id`. Delay records name the bounded route label,
admission wait, header wait and occupied readers. A slow canonical dependency is distinct from
read-capacity exhaustion. No request body, query string or credential belongs in those fields.
The supervisor ping still executes in the canonical process and includes read capacity; a live
gateway alone cannot make a blocked owner healthy. The gateway does not manufacture a response
when the canonical ping hangs: the outside supervisor retains its own unanswered-ping deadline
and recovery decision. Canonical request observations retain that
same admission identity. Read workers count every completion, error, slow read and elapsed time;
they log failures, reads of at least two seconds, and one in 100 ordinary completions. Their
current-process counters and bounded logger counters appear in the ping's reader health records.

Only the canonical startup creates the Inbox, runs migrations, starts background coordinators
or owns mutations. Read workers use physically readonly canonical connections. Account view
assembly happens there; live sign-in ephemera and an explicit fresh check cross private typed
ports to the credential owner, with unavailable state reported rather than invented. Thinkering's
independent authenticated admission continues to use the existing durable human-command ingress
([custody contract](HUMAN-COMMAND-INTAKE.md)); it is not another command queue.

The gateway and readers are declared application artifacts, resolved inside the same sealed
release. They end with the canonical process; Linux also enforces parent death in the kernel.
The release fixture blocks a private synthetic executor and checks the other reader continues,
then the composed acceptance exercises actual product routes and custody. It never pauses a
production process. Shared disk failure or exhausted execution capacity can still delay all
work; execution isolation does not manufacture durable storage availability.

The candidate-owned `presentation-release-check.ts` also runs the foreground import guard,
bounded-output source guard and composed 35-second stall/custody fixture. Earlier installed
builders already call this entrance before sealing, so the first upgraded release is checked.
Independent lifecycle children have separate scratch state and run alongside growth checks
inside the existing 90-second release envelope; each has bounded process-group cleanup.

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

Canonical requests record a normalized start and completion under one admission identity,
including actual encoded JSON response bytes. A blocked or crashed request therefore leaves a
start even when no completion can be logged. Concurrent calls to the same route retain separate
in-flight identities. Streams retain separate lifetime/transport observations.

The native communication and external-command handlers also record SQLite failures, including
their durability wait, through the bounded error sink. These records contain the operation,
SQLite code, transient classification and five bounded code frames, never submitted text or a full URL. Busy/locked
failures return 503 without retrying effects inside the handler. This closes the October 10
caller-visible `sessions post` lock error that previously returned 400 without a journal entry.
# Bounded owner collections

Saved messages, followed messages, waiting saved work, and the Lab's agent sessions and requests are separate indexed pages. Each page has a cursor and explicit coverage; the browser must offer continuation rather than treating the first page as the whole collection. Lab request membership follows the current project space of either participating session. A session move enqueues bounded reclassification slices in the presentation worker; the owner reads only the prepared request IDs and a fixed number of exact records. These reads have release fixtures at 100, 1,000, and 10,000 source rows and registered storage and response budgets. See `owner-collection-pages.ts`, `prepared-lab-requests.ts`, and the presentation reader registry.
# History changes and Lab display values

The legacy history-delta reader examines at most 200 new message versions, 200 non-message turn changes and 200 message actions after the client's cursor. It checks only the message IDs in that client's held page through indexed seeks. A larger burst asks for a fresh latest page; it never unions every historical message version. The build runs `history-delta-growth-fixtures.ts` at 100, 1,000 and 10,000 retained events and checks query plans. The selected history page still needs bounded previews and exact on-demand detail before the legacy exception can be retired.

The Lab's request list is assembled from bounded display values prepared outside the owner request path. The worker parses retained request and final-answer JSON, stores a fixed-size preview, and updates it on request or final-event changes. The owner reads up to 20 prepared values and compact session cards; it does not parse full retained request bodies. The Lab growth fixture includes an 8 MB request and exercises the same request assembler used by the route under the registered storage and response budgets.
