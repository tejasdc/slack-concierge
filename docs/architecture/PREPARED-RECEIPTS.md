# Prepared receipts

The owner ledger remains the authority for input, execution and request state. The
presentation worker reads one changed input and its exact related rows, then writes a
bounded receipt for list and delta reads. Full retained request text, result text and
return events remain behind the selected operation's exact detail read. A list receipt
contains stable identities, state, acknowledgment, routing, settlement, a bounded
preview, hold/retry explanation and an exact detail reference. The worker must not
rebuild all open receipts when one changes.

`session-receipt-state.ts` and `session-receipt-status.ts` are shared, storage-neutral
policies used by the canonical owner and the worker. The worker's source adapter in
`prepared-receipt-core.ts` resolves facts through exact keyed reads. The receipt's
`statusCoverage` is complete only after those facts are read; no missing fact is
silently represented as a clear hold. `nextRefreshAtMs` identifies the one backoff
explanation that changes merely as time passes, so a worker can refresh that input at
its due time without scanning the open set.

The provider's live retry map remains the only retry scheduler. Each set/clear also
publishes a typed observation by turn. At owner startup, a new incarnation replaces
the previous one and deletes its observations in one transaction. A worker only reads
an observation whose incarnation matches the current owner. This prevents a killed
owner's retry reason from surviving a restart as if the provider were still retrying.
Outage offers are durable canonical rows; the change journal must cover their
set/choice transitions and the retry observation rows. The worker's checkpoint and
prepared rows commit together, so a crash replays changes without claiming that an
unwritten explanation is current.

The worker now writes receipts into a disposable generation in finite pages. Its
checkpoint and the receipt change row commit in the same prepared-database
transaction. A reader holds one generation and a fixed change head: unrelated
ledger growth cannot expand a window or a delta. The owner still supplies the
exact selected operation through its existing detail route. The browser keeps
only the bounded preview in its receipt list; Retry loads the exact operation
before it resubmits a message whose preview was truncated.

The scratch `receipt-projection-fixture.ts` exercises retry set, restart
invalidation, clear, queued hold, provenance and oversized retained text.
`presentation-growth-fixtures.ts` drives the actual window and change readers
through the runtime storage budget against small and large unrelated histories.
Neither fixture opens production state. Activation still requires an installed
owner and a browser migration observed end to end on Tejas's surface.
