# Prepared session catalogue

The canonical SQLite ledger owns sessions, inputs, turns and effects. A separate presentation
worker maintains a compact session card for each canonical session in `presentation.db`.
Interactive catalogue reads use that database; they do not construct full session views or
enumerate turn and receipt history. The exact selected session remains available through its
existing detail route.

The worker builds a new generation in finite pages from a read-only canonical connection.
It replays the canonical change journal, then flips the visible generation and checkpoint in
one presentation transaction. While that work is incomplete, readers keep the prior generation
and report its applied sequence. A new generation invalidates old cursors with a typed reset.
`PreparedSessionCards` is the worker's independent card projection; its `apply` receives canonical
session and turn changes plus explicit session IDs from the Inbox attention projection. The
same transaction must call `checkpoint` with the last applied journal sequence. The worker must
not infer Inbox attention from a partial row: an unavailable exact projection produces `null`
and `attention_catching_up`, so attention-filtered reads never claim a complete answer.

`GET /sessions/v1/presentation/sessions/window` requires a space and returns at most 40 cards,
96 KiB of card JSON, a continuation cursor, a change watermark and coverage. A selected exact
view uses the existing `/sessions/:id/view` route. `GET /sessions/v1/presentation/sessions/changes`
pages immutable changed-card records, with both prior and new values, deletion tombstones,
card source revisions and a compact cursor. Page one pins a change watermark in a short read
transaction. Later catalogue pages read current rows under the same keyset, and the client
merges by card identity and source revision while draining changes from page one's watermark.
A card that moves across the keyset boundary is supplied by that change feed; an unrelated
update never forces pagination to restart. A generation change, expired change horizon or
invalid cursor produces a typed reset. No browser checkpoint advances on a transport receipt.

Each card also carries the last declared turn outcome's identity and time, so the notification
reader can select and order a bounded page without reconstructing the session. The prepared
tables index `(generation, space, sort time, session)` and filtered attention.
Canonical turn probes use narrow per-session latest, active, queued, started and exact provider
turn indexes. The release fixture `bot/scripts/session-card-growth-fixtures.ts` grows unrelated
sessions and prior turns tenfold, checks the indexed plans and bounded pages, and changes a card
and its attention membership between catalogue pages. The general presentation reader gate
also enforces route-specific row, result-byte and query budgets. Large canonical exports use a
separate explicit operation; this catalogue route is never a full export.

The card projection must preserve the owner view's pure title and space rules; the label helper
is shared with the existing owner. Runtime provider capabilities and selected-session obligations
are deliberately resolved only for the exact detail requested. Any new field copied into a card
requires adding its canonical writer to the change journal and extending the growth fixture.

## Enforced release boundary

`presentation-reader-contracts.ts` registers each interactive prepared route, its growth
dimension, sources, row and response-byte limits, and executable fixture. An unregistered
prepared GET is refused. The owner measures database calls, returned rows and value bytes
and refuses collection queries without an outer limit or readers that exceed their budget.
These measurements are not a count of SQLite pages scanned; access-path assertions in
the growth fixtures and loaded timing measurements cover that distinct risk.

`bot/scripts/presentation-release-check.ts` is part of the build and deployment candidate
seal. Missing fixtures fail it. It also traverses the presentation worker's local import
graph and refuses application writers or lifecycle initialization. A successful deployment
retains its `presentation-check.json` evidence beside the sealed release.

The catalogue fixture runs the actual prepared readers under the same storage budgets,
checks bounded wire sizes and indexed deep-page access, and exercises movement between
spaces, attention changes and generation reset. Change readers explicitly select the
space-and-sequence index: without that requirement SQLite can choose the general sequence
index and walk unrelated changes before satisfying a small page.

## Topic and question readers

The same worker prepares topic summaries, question counts, paged requests and questions,
message resolution, and management-event display text. Interactive topic routes use the
read-only presentation connection and the registered reader budgets. Each collection page
contains at most twenty items; large exact text is retrieved only through explicit,
digest-addressed parts. Missing prepared values report indexing rather than returning a
false empty result. Topic timelines combine prepared message and management displays,
without parsing retained canonical event bodies on the request thread.

`topic-growth-fixtures.ts` exercises each registered topic reader at 100, 1,000 and
10,000 topics under its storage budget. Canonical writes and action validation remain
with the existing owner; a prepared preview never grants permission for an action.
