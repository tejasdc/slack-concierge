# Prepared topic reads

The presentation worker reads the canonical ledger through a read-only handle and owns
the rebuildable topic tables in its existing presentation database. `prepared-topic-values.ts`
builds the current topic, question, reading, work and reply-target values. Question attention
predicates are shared with the canonical mutation owner in `topic-attention-rules.ts`.

`PreparedTopics` owns storage. Rebuild a new generation in finite topic pages; apply each
changed topic with one batch context; update changed roots and sorting attention; activate
only after all source changes through the advertised head are covered. The caller must run
updates and the checkpoint in one prepared-database transaction. It must not import the
canonical mutable owner into the worker.

Interactive reads use indexed keysets, at most twenty rows, and explicit source coverage.
Lists retain exact counts and expose a detail reference when their value needs a preview.
Large individual values are retained as SHA-256-addressed, sixteen-KiB UTF-8 chunks.
Clients must verify the concatenated digest before displaying a complete value. A newer
generation invalidates old list cursors; source lag is indexing, never an empty complete list.
The change feed carries both sides of each update and a null after-value for deletion.
It retains seven days of revisions and explicitly resets an older cursor. Garbage collection
walks finite batches, removes superseded generations and unreferenced chunks, and never
deletes canonical records. A removed detail reference requires refreshing its owning item.

Each changed topic streams question/request rows through item callbacks instead of building
one full detail object. Historical reading items use the existing bounded message preview
and exact message detail reference; one eight-MB answer referenced by a thousand questions
does not become a thousand eight-MB copies. The remaining arrays contain topic roots and
currently actionable ownership facts, not historical reading bodies. The worker still visits
that topic's item metadata when its dependencies change; this is not a claim of constant
background CPU per topic. Reverse dependency indexes keep unrelated token events out of it.

The overview returns exact per-filter question totals plus one selected-filter page, request
count and a request page. Additional pages are explicit. Requests may also be paged by their
source input for cards beside a visible conversation entry. Global question pages retain
topic groups (without a duplicate flat question array) and exact filter counts. The current
Inbox owns catalogue and global-question visibility. Older topics remain directly readable,
with work and reply routing derived from the current Inbox, matching the canonical owner.
Inbox attention still includes actionable questions from older topics, as the owner does.
Inbox attention uses those prepared facts and indexed
maximum generation; incomplete coverage returns unknown attention, never false.

Whole-topic detail is metadata only (`collections: 'paged'`), suitable for an explicit Manage
action needing complete roots; it does not eagerly copy all requests/questions. Large item,
reply-target and reading detail references are fetched only on explicit expansion.
Topic search reads bounded substring postings (including single-character queries), with an
explicit continuation. Its order is indexed search order, not the Open list's priority order.
Management entries use the shared sentence formatter on selected scalar source fields;
their interactive display never parses a raw declaration containing all its questions.

This source work is not an activated route. Integration owns worker invocation, source
writer coverage, generation activation, client continuation and route contracts. A worker
must rebuild when `isReady(generation)` is false, call `writeEvent` for each management event,
drain pending topic dependencies before checkpointing, and run `collectPage` on idle cycles.

Checks: `CONCIERGE_TEST_AUTHORIZATION=responsive-system-b1eed622 bun test
tests/prepared-topic-parity.test.ts` uses the mandatory isolated-state preload. The fixture
compares actual canonical and prepared detail/summary values, including a long reading,
then exercises streaming preparation of a thousand historical reading references to one
eight-MB answer (about two MB total database result bytes, not eight GB of copied text).
`bun run scripts/topic-growth-fixtures.ts` checks indexed deep pagination at 100, 1,000 and
10,000 topics with near-four-KiB summaries/questions/targets under actual read budgets,
including management displays and nonempty attention pages. It checks explicit stale
coverage, deletion changes and generation resets. The parity fixture also exercises Inbox
cutover, expired change cursors and interrupted rebuild cleanup. These are
local fixture results, not live product acceptance.

The existing presentation release gate also runs `topic-projection-fixture.ts`: canonical
topic creation and rename must advance a separate worker's prepared checkpoint, then a
mutation made while that worker is stopped must appear after its real restart and lease
recovery. It checks nonempty management history and the revision digest of every history
item. Finalize the item digest only after questions, requests **and history** have been
written; finalizing before history made every real topic mutation throw and prevented
the shared projection checkpoint from advancing (Oct 8, 2026). Static reader growth
fixtures alone did not exercise this source-to-projection boundary.
