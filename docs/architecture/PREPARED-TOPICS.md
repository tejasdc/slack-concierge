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
Full topic/question values are retained as SHA-256-addressed, sixteen-KiB UTF-8 chunks.
Clients must verify the concatenated digest before displaying a complete value. A newer
generation invalidates old list cursors; source lag is indexing, never an empty complete list.
The change feed carries both sides of each update and a null after-value for deletion.

This source commit is not an activated route. Remaining integration requirements: source
writer coverage, generation lifecycle/chunk retention, incremental root facts, exact topic
search, question grouping/client continuation, and route contracts. Do not activate the
reader before these are completed in the integrated responsiveness release.

Checks: `CONCIERGE_TEST_AUTHORIZATION=responsive-system-b1eed622 bun test
tests/prepared-topic-parity.test.ts` uses the mandatory isolated-state preload. The fixture
compares actual canonical and prepared detail/summary values, including a long reading.
`bun run scripts/topic-growth-fixtures.ts` checks indexed deep pagination at 100, 1,000 and
10,000 topics, explicit stale coverage, deletion changes and generation resets. These are
local fixture results, not live product acceptance.
