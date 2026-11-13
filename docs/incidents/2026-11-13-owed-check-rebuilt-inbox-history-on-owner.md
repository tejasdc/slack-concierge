---
failure: An agent checking whether it could finish froze Concierge while rebuilding the Inbox's retained message index.
date: 2026-11-13
fix_commits: []
cause_status: confirmed
---

# A Stop check rebuilt Inbox history on the interactive owner

## What was seen

The 24-hour journal window ending around 2026-11-13 08:20 UTC contains eight
`owner_task_blocked` records labelled `routed POST /session-communication/owed`,
totalling 88,796 ms. The longest was 43,122 ms. At 08:13:03 UTC one block lasted
14,254 ms, with 11,246 ms of owner-thread CPU and 6.81 GB of read characters but
only 45 MB of physical reads. Page-cache hits still consumed the owner's thread.

## Cause

The matching `owner_event_loop_lag` record supplies the exact synchronous stack:
`owed → unfiledReceivedInputs → unfiledInboxRoots → entryIndex → extendEntryIndex`.
The extension's runtime-composed Inbox-row statement had fingerprint
`1d7a82f66ea108c4` and took 9,555 ms. The entire callback made 81,254 observed
storage calls and occupied storage for 13,521 ms.

The current router's filing guard includes captures stranded on former Inbox
routers. It reads the same entry index as the sorting pile. A Stop arriving while
the startup warm-up was yielding called `entryIndex()`, which synchronously
completed the remaining history with an unlimited read. The 08:13 block ended in
the same tick as `inbox_entry_index_warmed` (9,446 rows, 1,598 steps, 47,245 ms
overall); the 07:55 block shows the same sequence. The earlier guard preventing
background upkeep from finishing a partial warm-up did not cover Stop checks.

The run lookup was a candidate in the repair request, but the retained stack
establishes the Inbox projection as this incident's expensive statement.
Expanding only side-effect-free SQL declarations from the installed sealed
bundle produced the exact 4,632-character statement and matching fingerprint.
The embedded Bun 1.4.2 SQLite engine was 3.53.2. Its schema-only plan used the
event primary-key range, then tested Inbox membership and full eligibility;
the live ledger held 1,840,812 events across 11 Inbox sessions. A returned-row
limit therefore did not bound the events inspected or payloads read.

## Fix

The canonical owner retains run validation, local and peer reply obligations,
offers and reminder writes. Only an Inbox session's unfiled-input projection
runs through the existing root-owned local gateway and physically read-only
executor pool. The owner awaits that result, then resolves the current run again
before returning obligations or recording reminders. A cancelled request or a
failed reader cannot fall back to the synchronous projection or invent an empty
filing list. Non-Inbox checks retain their direct path.

The private projection is a sibling of the retained event-stream page. It adds
no worker, service, persistent cache, timer or externally exposed capability.
The existing pool owns admission, execution deadlines and failed-reader retirement.

Entry-index extension first selects a bounded page of event sequence keys for
Inbox sessions and the existing Inbox message kinds. That covering-index read
sorts keys only. The full, unchanged Inbox eligibility projection then hydrates
only those exact keys through primary-key lookups. The cursor advances over
all inspected candidates, including candidates excluded by visibility rules;
if the processing deadline interrupts a page, it advances only through the
last processed message. Empty filtered pages cannot stop catch-up early or
make it repeat the same candidates. The existing startup batch and yield budget
remain the boundary; no schema migration or new index is needed.

A tempting direct session/kind predicate on the full projection was rejected:
although it used the intended index, its sort included expensive message
projection work before returning the first page. On retained production data
it took 2.50 seconds versus 0.03 seconds for the original first page. The
key-only candidate page and its exact-key hydration each took under 0.01 seconds
for that initial 16-candidate probe, with matching selected event identities.
Those small reads establish the access-path correction, not total cold-start
or installed Stop latency. The bounded two-read shape avoids making its work
depend on every unrelated session's retained event payloads.
Four guarded candidate/hydration pages produced 43 eligible event sequences,
exactly matching the original projection's prefix (candidate/eligible counts
16/8, 16/9, 16/12, 16/14). A one-candidate filtered-empty page also established
that the scan cursor can advance without omitting a visible event.

## Acceptance scenario

- **Seed:** retained Inbox history across current and former routers, including
  unfiled human captures and marked agent reports; a partial or cold entry index.
- **Action:** the current router's ordinary owed-replies Stop check while another
  owner request is admitted. Also check a non-Inbox run with an exact open request.
- **Expected:** filing obligations retain their identities and previews; local,
  peer and outside reply obligations and reminder custody retain their behavior.
  Inbox projection runs in a read executor, and its duration cannot block the
  canonical owner's event loop. A run changing during the read does not acquire
  another run's result or reminder writes. Read failure is explicit.
- **Replayable offline:** yes for query plans, projection and async fencing;
  installed acceptance also requires real retained data and a few-hour journal
  window with actual owed-check traffic, zero related owner blocks, and no new
  projection failures. A quiet window without calls is incomplete evidence.

## Evidence boundary

### First installed route check caught a transport recursion

The first installed release's private projection succeeded: the two cold read
executors completed in 7,768 and 9,576 ms, a warm projection in 36 ms, and a
concurrent non-Inbox owner request in 4 ms. These were reader and independent
owner evidence, not proof of the complete Inbox route. The actual Inbox router
then called its installed client with its own live source and received
`503 UNFILED_READ_UNAVAILABLE` in 53 and 45 ms, with no corresponding reader log.

The routed-request handler was a named function expression called `fetch`.
Its new unqualified network call therefore invoked that handler recursively with
a URL string, returning `Invalid URL` before any reader request. The existing
agents-list hop had the same binding error. An independent Sol investigation
expanded the exact handler with inert dependencies: unchanged source returned
503 with zero network calls; changing only its handler name returned 200 with
one network call. The installed bundle confirmed the same recursive binding.

The correction gives the handler its own role name, leaving `fetch` to resolve
to the network transport. The existing foreground-boundary release check now
rejects an unqualified self-call inside a named `fetch` handler in this module.
This is a source-level refusal for the proven construct; installed acceptance
must still exercise the actual Inbox router request and correlate the worker's
completion record. No reminder or offer effect is replayed by these checks.

### Limits of the observations

The original blocks and their stacks are retained production evidence. A
schema-only query plan proves the access path, not production latency. An
installed health check or one fast non-Inbox call cannot establish Inbox
performance. Keep the repair request open until deployment, live projection
checks and the requested observation window have been inspected.
