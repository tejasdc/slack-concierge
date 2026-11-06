# Prepared receipts

The owner ledger remains the authority for input, execution and request state. The
presentation worker reads one changed input and its exact related rows, then writes a
bounded receipt for list and delta reads. Full retained request text, result text and
return events remain behind the selected operation's exact detail read. A list receipt
contains stable identities, state, acknowledgment, routing, settlement, a bounded
preview, hold/retry explanation and an exact detail reference. The worker must not
rebuild all open receipts when one changes.

Every compact receipt also carries `attachments`, an ordered prefix of the immutable
custody descriptors `{id,name,contentType,sha256}` for the attachment IDs retained on
that accepted input (or create's first input), plus
`attachmentsCoverage:{complete,count}`. `complete:true` means the array is exhaustive;
`complete:false` preserves the largest prefix that fits the card and the existing
`detail.operationId` names the exact receipt containing the full ordered array. This
keeps the ordinary held-file path free of per-row detail reads without putting an
unbounded child collection inside a bounded receipt window. The IDs remain in the
exact request body, and bytes plus source attribution remain behind the authenticated
attachment read. Receipts with no retained attachment IDs carry `attachments:[]` and
complete coverage with count zero. A projection-code release changes the projection
revision and rebuilds historical receipts, so already-held inputs gain the same
descriptors and coverage as newly accepted ones.

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

The receipt metadata records the digest of the installed presentation worker bundle. Because that
bundle contains the receipt policy and its dependencies, any release that changes classification or
wording makes the prior prepared receipt generation stale automatically. Receipt generations are
independent of message, topic and session-card generations: the worker rebuilds only historical
receipts in bounded pages while readers keep the last complete receipt generation. It records the
new digest only in the same transaction that activates the complete replacement. A restart during
rebuilding discards the abandoned receipt shadow and starts from the prior complete view, so it can
never present a partially migrated receipt set as current or duplicate unrelated projections.

The scratch `receipt-projection-fixture.ts` exercises retry set, restart
invalidation, clear, queued hold, provenance and oversized retained text.
`presentation-growth-fixtures.ts` drives the actual window and change readers
through the runtime storage budget against small and large unrelated histories.
Neither fixture opens production state. Activation still requires an installed
owner and a browser migration observed end to end on Tejas's surface.
