# Why the system keeps getting slow

TL;DR: The cache exists, but the server rejects the browser’s request for changes and the browser silently downloads everything instead. More broadly, features can still make a small action reread or reconstruct an ever-growing history, and that work can block unrelated conversations. I recommend replacing that read-and-update architecture while preserving the existing records and execution ownership; another index is relief, not the proposed resolution.

September 25, 2026. **Investigation and proposal only. No application, deployment, instruction or skill change is authorized by this document.** Prepared by GPT-6 Astra at Tejas’s explicit request, using historical evidence gathered with GPT-6 Sol and retrospectives from both relevant feature authors. The authors’ accounts are evidence, not independent verification of each other.

## What happened to the cache?

Tejas’s question is the starting point:

> “What happened to the caching system that we introduced? What happened to the browser storage that we're using? What the hell is going on here?”

The earlier explanation that the page “never sends its cursor” was wrong. The author has retracted it. The browser does save the Inbox’s work records and a bookmark describing what it already holds. When something changes, it tries to fetch only the changes. The failure is between the browser and Concierge:

1. **Concierge issues a growing bookmark.** It includes the identities of every work record whose outcome can still change. This was designed to avoid missing a reply that changes elsewhere without an event in the requesting conversation.
2. **Thinkering’s server independently limits that bookmark to 1,024 characters.** The owner’s current bookmark is 1,348 characters, containing 193 still-changeable records. The two sides do not share an enforceable contract.
3. **Thinkering rejects the browser’s incremental request before Concierge sees it.** The author’s retained server evidence contains 515 matching validation refusals in its three-hour window. The device report shows refusals, but conceals the useful reason behind a generic error.
4. **The browser treats any non-cancellation failure of the incremental request as a reason to fetch the whole list.** It does not distinguish a deliberately expired bookmark from an implementation defect. The latest measured full response contains 7,367 work records and is about 23 MB. The earlier incident snapshot had 7,225 records; the Inbox continued growing during the investigation.
5. **Live activity triggers the cycle again.** This is not a fixed two-minute polling timer. The browser refreshes its catalogue after non-message events, and active views refresh dirty data. The original “every couple of minutes” description was a rough average. The author’s later three-hour sample had 85 full Inbox reads, with a median gap of 24 seconds and long quiet gaps. Some reads can come from other callers; the owner log cannot assign all 85 to the browser.

Browser storage made the saved information available. It did not make the update protocol correct, stop a full-read fallback, or reduce the server’s cost of answering that fallback. Storing the entire replacement again also preserves a growing object, not a bounded working set.

**These are work/status records containing retained request and result text, not simply the visible conversation messages.** Calling them “the whole Inbox history” blurred two different reads. The app also fetches conversation pages, but those have different costs and routes.

There is a second route around the browser cache. **The server’s notification reader reconstructs an Inbox thread by requesting every work record and walking history pages until it finds the relevant conversation.** The notification sender now uses that reader to put a preview inside the notification; the phone’s notification panel also refreshes through it. That can give the phone a better first frame while adding expensive preparation on the server. Browser storage cannot protect work performed there. The code confirms this path; the retained request logs do not measure its share of today’s total load.

The contract defect also has a direct predecessor. On September 20, an earlier intermediary rule accepted only numeric bookmarks even though the owner issued encoded ones. That caused the same silent fallback. The repair allowed encoded characters but imposed today’s 1,024-character ceiling. This was a recurring interface failure, not an absence of caching knowledge.

## The architecture as it exists

On the phone or computer, Thinkering has shared in-memory caches, a browser database for saved snapshots, and a live connection carrying changes. These are meaningful improvements over each component fetching independently. The saved snapshots are disposable copies; original messages, captures, attachments and execution records remain under their existing owners.

On the server, Thinkering authenticates and forwards many reads to Concierge and also performs work such as preparing notifications. Concierge owns accepted inputs, requests, session identity and execution. It stores structured records alongside retained event payloads and reads provider transcripts for conversation history. Some presentation facts are assembled afresh by joining those sources when a page asks for them.

That last step is where several costs multiply. A list asks for hundreds of session views; each view may perform additional lookups. A page asks for dozens of messages; each message’s attribution may search and parse many events. A notification wants one thread; its reader starts with the entire Inbox work list. An unrelated event can invalidate a whole catalogue.

Concierge uses synchronous database reads and performs substantial processing on one JavaScript event loop. It is **not literally limited to one outstanding request**: asynchronous network waits can overlap. But while a synchronous scan or a large parse runs, other requests on that loop cannot make progress. One mutation owner is valuable for correctness; putting all expensive reading on its execution thread is a separate design choice. Bun documents its SQLite interface as synchronous. [Bun SQLite documentation](https://bun.sh/docs/runtime/sqlite)

The common failure is **work amplification without an enforced boundary**:

> Work per small action grows with retained history, then gets multiplied by the number of displayed records, the number of refresh events, or both.

One human is not a tiny workload when many agents stream events, history is retained indefinitely, and several devices and notification services consume it.

The history-index recurrence is especially instructive. September’s first index narrowed a message lookup from the whole event ledger to that session’s events. It removed a large immediate cost, but the lookup could still parse the session’s events again for each requested message. As a conversation grew, that remaining multiplication became expensive. Today’s more specific message index narrows it again. A durable guarantee must describe the work per requested message, not merely say that an index exists.

## How often this has happened

This is a reconstructed timeline, not a claim to have found every slow moment ever reported. Dates below follow the source records, often UTC. Some evidence comes from contemporaneous incident reports or commits rather than recovered original speech. Exact source identities, limitations and measurements are in the [evidence companion](2026-09-25-latency-retrospective-evidence.md).

| When | What was slow | What the evidence showed | What changed, and what remained possible |
|---|---|---|---|
| September 14 | Local refresh work during an empty resync | The existing skill records twelve repository refreshes for one empty resync. Transport activity was invalidating unchanged content. | Content and transport notifications were separated. This did not establish a cost contract for new session reads. |
| September 16 | Installed Safari app hung around active conversations with attachments | The contemporaneous report recorded 48 distinct attachment fetches in 16 seconds, none completing. Recreated message objects led to remounts, cancellation and refetching. | Shared resource ownership, stable conversions, narrower subscriptions and source checks were added. These protect browser structure, not server query cost or cross-server cursor compatibility. |
| September 16–17 | Long-lived app window exhausted memory | Warm-up retained full histories for recent sessions; reconnect reread them. The cited fourteen-minute window had 98 history requests and 28 full reloads. | Cache retention became a working set. No product-wide memory-growth guard is established by the evidence. |
| September 17 | Opening a conversation took 20–30 seconds | Phone focus shifts repeatedly cancelled reads. Separately, a 200-message owner page took about ten seconds because per-message lookups repeatedly parsed an unindexed 52,514-event table. | Visibility replaced focus as the cancellation condition. An index reduced each of two measured projections from roughly 4.4 seconds to about 70 milliseconds. The exact dependency was documented, but future read amplification was still permitted. |
| September 17 | Inbox unread and reply state refreshed slowly | A refresh read 1,997 events, 15.8 MB and roughly 32 seconds, although only 196 events mattered. A separate refresh read all 290 work records. | Filtered, continued reads and exact attribution were introduced. Full reads remained available as an easy default. |
| September 18 | Searching sessions took 12–20 seconds | Search constructed hundreds of full session views, grouped event data through embedded payload fields and checked archives serially. | Search-specific narrowing, an expression index and concurrent independent archive checks. No general read-growth requirement followed. |
| September 18 | Inbox reads grew with daily use | 444 work records already meant 2.7 MB. Tejas explicitly asked agents to update instructions or skills because the app was doing inefficient operations. | Incremental work-record reads and saved bookmarks were introduced. The stateful-design skill gained a rule about reading changes instead of collections. That rule already existed before today. |
| September 20 | Incremental Inbox reads silently became full reads | An intermediary rejected the owner’s encoded bookmark as non-numeric. | Validation was changed, but the replacement imposed a length cap the owner did not share. The fallback still concealed incompatibility. |
| September 22 | Notification taps still took seconds after a purported fix | Several causes: stale saved destination, delayed catch-up, a native-to-page handoff race lasting about 13 seconds, and a separate 2.8-second read of 2,124 work records / 9.6 MB blocking other owner work. | Destination handling, foreground refresh and narrow metadata callers were improved; settled records were reused and request/loop timing added. Tejas’s second report disproved the first fix’s sufficiency. |
| September 22 | Threads list work grew | Wider-than-needed event lookups and repeated construction of lookup structures. | More specific indexes and reuse within a read. Again a path repair, not a constraint on all future readers. |
| September 24 | Notification navigation showed a large loading card | The design exposed intermediate loading states. That report did not establish the backend cause. | A quiet thread frame replaced the large card. The author confirms this made the wait calmer, not shorter. |
| September 24–25 | Notification panel showed the question before its thread | The panel initially had only the question, then fetched and reconstructed the thread. | A small preview now travels in the notification. This improves first paint while preserving an expensive server preparation path. |
| September 25 | Thread opening queued behind unrelated work | Continuing old conversations added 651 unindexed lookups over 10,787 input records to each catalogue read: 3.87 seconds of extra work. The catalogue was read 25 times in seven minutes. A long conversation also repeated event parsing per message. | Two indexes were added by the incident owner. Its later report says they are installed; post-change catalogue logs are around 0.3 seconds. The full long-conversation open was not remeasured after installation. The catalogue refresh pattern, growing bookmark and full-read fallback remained. |

Adjacent delays must stay distinct. An August drain incident stopped admission while waiting on a nested agent; its incident report proposed several remedies without establishing they shipped. A later startup change moved archive indexing out of the pre-listening path after 13–18-second restarts. Neither is evidence of the same SQL defect.

Provider response time is another category. A September investigation initially blamed roughly 20-second Claude acknowledgement on launching and resuming. Reading Claude’s own transcript later showed that 18 of the 25 slowest turns were received within 1–2.3 seconds; much of the following 15–95 seconds was model work before first output. The warm-process proposal was withdrawn. A database redesign cannot remove that thinking time; the interface must accurately distinguish receipt, work and output.

## Why the agents did not learn enough

The continuation author’s retrospective says:

> “I checked correctness and never thought about the cost of the list path.”

It specified the behavior, delegated implementation, then reviewed whether the action was correct. Both the new per-row lookup and the catalogue’s loop over all sessions were visible in the printed diff. The author checked peer identity, model choice and repeat-action correctness, but did not inspect indexes or refresh frequency. Its recollection is that it treated the new field as cheap metadata and assumed the catalogue was read on page load. Those recollections are labelled separately from transcript evidence.

The Threads author says:

> “The new line made the wait calmer and no shorter.”

That session treated the loading-card request as design work and did not investigate the duration. Later it diagnosed two expensive reads, but inferred that the browser did not send its bookmark because the owner never received one. It had not checked the intermediary. It now explicitly calls that an unverified claim presented as fact.

Several structural reasons connect these mistakes:

- **Feature classification hid performance impact.** A “Continue” button changed a hot catalogue reader. A notification presentation improvement reused a costly thread reconstruction path. The product category did not describe the execution cost.
- **Correctness review had no cost model.** The review asked whether the right answer appeared, without asking how many records were read or how frequently the enclosing path ran.
- **Ownership checks stopped too early.** Browser source checks require reads to pass through shared owners. They do not ensure the owner requests a bounded amount of data or that server-side consumers use the same reader.
- **The cheap path was optional and the expensive path was forgiving.** A cursor failure could return the correct result by doing vastly more work. Correctness concealed a failed performance contract.
- **Lessons described patterns, but did not remove the hazardous primitives.** The September 18 skill already said not to refetch growing collections. The API still permits “give me everything,” and its safe cursor requires having the whole set first.
- **Telemetry recorded symptoms without closing the operational loop.** Logs existed, but the incident author reports no alert on these slow-read or loop-lag signals. The retrospective found no demonstrated release gate for this class of regression.
- **Current delivery policy deliberately excludes agent-run tests.** The author reports treating that as excluding timing and query-plan checks too. That is not permission to bypass the policy, and the policy does not excuse missing the visible loop in code. It does mean any proposed automated performance gate needs an explicit policy decision from Tejas.

The lesson is not that agents need a larger reminder at the start of every conversation. They need a small, legible set of permitted read shapes, with guarantees enforced where those reads are built and used.

## What the available logs prove—and do not

I read retained owner slow-request and event-loop records from September 22 at 05:47 UTC through September 25 at 18:02 UTC. That snapshot contains **55,128 lag records and 10,915 slow-request records**. These are threshold-triggered observations, not 66,043 independent user incidents. A single period of contention can generate many records; they do not establish the percentage of all requests that were slow.

The largest accumulated logged durations included provider-account reads, full Inbox reads, long-conversation history and catalogue reads. Provider-account requests can wait asynchronously on the Mac; summing their durations does not measure CPU consumption or time the owner was blocked. The measurements support separating queue delay, synchronous work and dependency wait.

The logger often reports no response byte count and no caller identity. Its list of in-flight requests can be empty when a blocking request completes just before the lag timer runs. Consequently, it cannot by itself establish “the browser did not send a cursor,” “this route consumed all that CPU,” or “every wait was caused by that query.” The investigation must retain those distinctions.

## The proposal: replace how the product reads and stays current

The objective is a responsive personal system with growing retained history, several concurrent agents and multiple devices. Required properties are exact conversation identity, attachment custody, trustworthy status, working notification links, durable accepted actions, bounded interactive work and useful behavior when offline. There is no evidence here requiring a public multi-tenant platform.

I recommend **replacing the read and synchronization layer as one coherent delivery**, while retaining the current authority for accepting and executing work. This is more than adding indexes or patching the cursor ceiling. It is smaller and more reversible than rebuilding provider execution, attachments, account dispatch and every native surface.

Consider opening one thread with twelve recent messages while another agent updates an unrelated conversation:

1. **The device immediately draws the saved page for that exact thread**, if available, along with its freshness state. It does not wait for the global catalogue or clear readable content during refresh.
2. **It requests that thread’s current page or changes**, not all Inbox records. Cold devices request a bounded page; they do not first download the universe to qualify for incremental updates.
3. **Concierge answers from prepared, indexed presentation records.** Those records retain exact links to the authoritative inputs, messages and attachments. They are maintained when relevant facts change instead of reconstructed from all prior events for each reader.
4. **The same committed change advances a durable revision.** A device’s bookmark is a compact revision and collection identity, not a list of everything still open. Every visible status change, including a reply recorded elsewhere, must advance the relevant presentation record and its revision. Merely replacing today’s token with a timestamp would lose updates; this change is inseparable from the writer-side contract.
5. **The live connection names the changed entity.** The device merges that entity or requests its changes. An unrelated update does no work on the open thread. Deletions, moves and corrections have explicit updates too.
6. **Notifications use the same thread reader.** They can carry a small preview, but preparing it no longer means rebuilding the Inbox. The preview’s source and freshness remain explicit.
7. **Expensive archive/transcript processing runs outside the interactive event loop.** It may build or repair derived records, but cannot occupy the same execution thread that accepts a message or answers a small thread read.

This introduces rebuildable presentation state and a complete change contract; it does not create a second owner of conversations. For owner-controlled changes, update authoritative facts, their presentation records and revision together. For externally observed provider changes, the existing observer imports exact identities into that same owner boundary. Old imported material needs an explicit completeness watermark. Until ready, show known saved material and honest updating state; do not silently run a full archive reconstruction on an interactive read.

The change must preserve the original retained bytes and execution identities. Rebuilding presentation records is reversible; resending an accepted input is not an acceptable migration method. A bounded backfill, consistency comparison, compatible release transition and rollback to the retained authoritative records belong to this single delivery, not a separate future cleanup promise.

This local-replica direction is established practice, not a reason to imitate another company’s scale. Linear publicly describes its product as using a dedicated realtime sync engine and explains that the API evolved with it. That supports evaluating synchronization as an owned subsystem; the linked page is a talk summary, not evidence that any particular implementation would fit this system. [Linear’s engineering account](https://linear.app/now/scaling-the-linear-sync-engine)

## Ranked structural protections

The ranks reflect the demonstrated failure modes and the objective above, not measured development return on investment. Costs below are engineering judgments; I have not estimated person-days or benchmarked a replacement.

| Priority | Structural protection | What becomes automatic or refused | Evidence and cost |
|---|---|---|---|
| 1 | **Purpose-specific, bounded reads with prepared presentation records** | Thread, session-summary and work-status readers cannot request all bodies by accident. Interactive callers have no full-ledger primitive; exports and explicit recovery use a separate path. Render-only assembly cannot query storage per row. | Addresses catalogue, message attribution and notification reconstruction together. Medium/high implementation cost; requires complete write coverage and rebuild logic. |
| 2 | **One end-to-end change contract, including browser persistence** | A compact owner-issued bookmark is accepted unchanged across intermediaries. Saved data and its bookmark commit together. Missing/expired history produces an explicit bounded reset; arbitrary errors do not become full downloads. | Directly addresses the repeated cursor failures. Medium/high cost because status can change through multiple existing owners and observations. |
| 3 | **An approved release check for read cost and growth** | A feature is rejected before activation when one-item work scales with unrelated history, when warm opening becomes full synchronization, or when the candidate violates agreed interaction budgets. | Would target both September indexing incidents and the cursor failure. Requires Tejas to change the present no-tests policy for this narrow purpose; recurring execution/fixture upkeep. |
| 4 | **Separate interactive work from expensive reconstruction** | Background parsing, indexing and archive search cannot run synchronously inside the interactive owner. Use a read worker/process within the owner’s deployment, with bounded work and committed-snapshot semantics. | Contains the shared-loop blast radius. Medium cost: worker failure, cancellation, queue bounds and database snapshot lifetime must be owned. Moving the same waste elsewhere does not replace priorities 1–2. |
| 5 | **Indexed access paths tied to the reader, not remembered separately** | Each interactive reader declares its selection and order, dependency indexes and expected work. Frequently joined identities become structured indexed fields; retained payloads remain intact. Batched reads replace hidden lookups in list rendering. | Prevents missing access paths; indexes add write/storage cost. “Index every column” and “reject every scan” are both wrong—small intentional scans can be appropriate. |
| 6 | **One cache behavior for browser, native and server readers** | Shared reader contracts cover snapshot, delta, reset, cancellation and freshness; immutable bodies are fetched by exact identity. Browser caches retain only their working set and update individual records rather than cloning whole collections. | Existing browser checks are useful but did not cover notification preparation. Medium integration cost and explicit eviction policy. |
| 7 | **Operational detection linked to a responsible agent** | Repeated fallback, interactive lag and latency regression produce one correlated incident, rather than thousands of unexamined warnings. The next feature author sees the affected reader’s current cost and last incident. | Existing signals reduce setup cost. Alert thresholds and aggregation need tuning; no alert per request. No automatic repair or rollback is implied. |

For priority 3, the proposed checks measure more than elapsed time. Hold the requested page and the number of changes constant while increasing unrelated history. Count queries, rows visited where supported, bytes transferred, repeated full reads and retained browser memory. That distinguishes an indexed page from a superficially fast full scan on an empty fixture. Cover a warm device, a cold device, a restart, an expired bookmark, a large unsettled set, an unchanged event, a status change without a message, and a notification opening an old thread. Correctness must be checked too: dropping old records to meet a speed target is not a pass.

Query-plan inspection can help, but SQLite warns that its explanatory output format changes. Do not create a fragile release gate that compares an entire printed plan string. Use a pinned engine, narrow plan expectations and behavioral work/growth assertions; re-evaluate those expectations on engine upgrades. A query that uses an index can still return or parse too much. [SQLite query-plan documentation](https://www.sqlite.org/eqp.html)

A starting discussion target is cached content painted within 100 ms, healthy warm thread opening within 500 ms at the 95th percentile, and bounded local owner reads within 100 ms at the 95th percentile. These are **proposed targets, not measured capability or existing commitments**. Cold device startup, large user-requested artifacts, offline recovery and model work need separate targets. Measure response time from the user’s action as well as within the server; a fast query behind a long queue is still a slow product. Web responsiveness guidance treats 200 ms or less as good interaction-to-next-paint performance, but that metric does not itself measure arrival of fresh remote data. [Interaction responsiveness guidance](https://web.dev/articles/optimize-inp)

The existing deployment owner should run an approved candidate check against isolated representative state without provider invocation or external effects. Production observations then detect conditions the fixture missed. An automatic rollback is a separate decision: after a data migration it may be unsafe, so “roll back on latency” cannot be assumed. A release that is merely healthy must not be advertised as meeting the interaction budget.

For alerting, the proposed destination is one native Inbox incident after sustained degradation, with one named owner agent receiving the correlated evidence. Tejas sees the affected interaction and whether he needs to decide; a separate service recovery update closes that incident when supported. The exact duration and thresholds belong in the proposal’s acceptance contract. Do not launch a fresh repair agent for each warning.

## Should we throw everything away?

There is no reason to preserve the current read design just because work went into it. There is a reason to preserve the authoritative records and boundaries: they encode custody, identity, accepted work and uncertain effects that a replacement must still honor. A rewrite would have to re-create those guarantees and migrate their history before it could be considered equivalent.

| Option | Where it wins | What it does not solve / cost |
|---|---|---|
| Keep the architecture; repair the two indexes and cursor validation | Fastest incident relief; least change risk. The measured index improvements are real. | Leaves unbounded defaults, repeated catalogue construction, growing bootstrap cost, notification reconstruction and another path to the same failure. Does not meet the stated prevention objective. |
| **Replace the read and synchronization layer; preserve execution and custody** | Directly removes the repeated mechanisms. Provides a small contract future features use. Rebuildable derived state makes reversal cheaper than migrating execution. | Substantial work on every visible-state writer, reader and reset path. Incorrect projection maintenance could show stale status; completeness and consistency are acceptance requirements. **Recommended against the objective above.** |
| Adopt an established synchronization system for the local replica | Could supply mature persistence, revisions and subscription behavior instead of maintaining those mechanisms ourselves. | Must fit the authoritative owner, provider transcripts, server notifications, offline semantics and mobile lifecycle. Does not automatically fix expensive source queries or read-time reconstruction. No candidate has been evaluated here, so no product is ranked or recommended. |
| Replace the whole app/owner, possibly the database too | Can simplify boundaries without compatibility constraints in the new implementation. Justified if a complete dependency map shows the read boundary cannot be extracted economically. | Highest migration and regression risk: provider queues, request returns, attachments, history identities, notifications and devices all need equivalent behavior. A new database still permits missing indexes, repeated scans and excessive payloads. No evidence yet shows replacing these other parts is necessary. |
| Freeze feature work and operate as-is | No migration risk or new development cost. | Preserves the demonstrated delays and growing read cost. Does not meet the request. |

SQLite is not exonerated from careful design, but its presence is not the demonstrated architectural defect. The current data sizes are not evidence that a personal application requires a database server. SQLite supports concurrent readers with a single writer in its write-ahead-log mode, which this application already enables. Its own guidance distinguishes workloads needing many concurrent writers from suitable application-server uses. Moving readers off the owner’s execution thread can exploit existing capabilities; it still requires short snapshots and checkpoint care. [SQLite concurrency](https://www.sqlite.org/wal.html), [SQLite deployment guidance](https://www.sqlite.org/whentouse.html)

Likewise, stored JSON is not inherently wrong. Original payloads are valuable provenance. Repeatedly discovering frequently queried identities inside every payload is the wrong read path. Structured identity columns or maintained presentation records make those facts addressable; expression indexes are useful when the exact expression is part of the access contract. [SQLite expression indexes](https://www.sqlite.org/expridx.html)

## What skills and instructions are missing?

Some of the relevant teaching is already present. The stateful-design skill has said since September 18 that reads should cost what changed, not how much history exists. Its local-first guidance separates content changes from transport activity. The React guidance covers deduplication and narrow subscriptions; global instructions add data-layer separation and stable identity. The observability skill asks who detects degradation and what evidence is available.

The missing secondary layer is **one short, repository-specific map from a new product feature to its enforced read contract**. It should show the feature author: which entity is changing; which owner records it; which presentation record and revision change with it; which shared reader the browser and notification service use; which access path and cost assertion protect it; and which signal detects regression. That map should be derived from the same registered readers and schemas used by the program, not maintained as a parallel spreadsheet.

A proposed addition to the general stateful-design guidance should teach the gaps demonstrated here: page-size limits do not prove bounded computation; a cache does not prove incremental refresh; cold opening must not require all history; an arbitrary error must not select a more expensive algorithm; and the single mutation owner need not be the execution thread for every read. Keep database-specific query-plan details in a reference, not another enormous always-loaded prompt.

Existing instructions also need one explicit decision about performance verification. “Never ship another slow feature” and “agents must not run any verification commands” cannot be treated as though an automatic release guard already reconciles them. The proposal is a narrowly owned, automated cost/correctness check in the established release path—not a return to hours of general review loops. Tejas must approve that change first.

No skills or standing instructions were edited in this investigation. Their proposed improvements are secondary to changing the primitives that currently allow the failure.

## What can—and cannot—prevent future latency

No credible design can promise that every future feature, network, device, model and dependency will respond instantly. What can be promised within a stated operating envelope is that a small interactive read does not grow with unrelated retained history, background work cannot monopolize its execution thread, and known performance regressions are refused or surfaced.

| Remaining latency class | Proposed protection | Cost or limit |
|---|---|---|
| Database and data-model growth | Indexed, bounded readers; maintained projections; growth checks | More write work and derived storage; migration/backfill correctness |
| Repeated refresh and synchronization | Compact revisions, entity updates, bounded resets, one shared contract | Complete change tracking; handling gaps, deletions and restarts |
| Browser rendering and memory | Stable identities, narrow subscriptions, visible-page rendering and bounded retained caches | More lifecycle discipline; long-session coverage remains necessary |
| Owner contention | Separate expensive reconstruction, bounded admission and foreground priority | More scheduling/failure handling; overload still requires an honest waiting state |
| Network loss or slow mobile link | Immediate saved content, explicit freshness, incremental transfer, safe resumption | Unseen remote information cannot be shown while disconnected |
| Cold startup or release restart | Small first view, persistent derived data, imports outside the critical path | Cold devices still download a page; process startup and authentication have nonzero cost |
| Native app/notification handoff | Exact destination carried through readiness; shared bounded thread reader | Device lifecycle can suspend execution; first paint and fresh content are separate |
| Provider thinking and usage holds | Accurate receipt/work/output states; keep conversation navigation independent | No local cache eliminates remote model time or a provider allowance hold |
| Large attachments and transcripts | Fetch by exact identity, stream or load on demand, prepare heavy parsing separately | Large content still has transfer and processing cost |
| Host/peer failures | Dependency-specific timing, useful saved state, one owned incident with recovery evidence | Absolute availability needs additional infrastructure and an explicit service objective |

The acceptance statement should be understandable: **“Opening this thread reads this thread’s page and its changes. Another conversation growing, or an archive being processed, cannot turn that into a full Inbox reconstruction.”** That is narrower than “never any latency,” and strong enough to rule out the repeated failures documented here.

## Decision requested

Approve or reject the proposed replacement of the read and synchronization layer, including its isolated heavy-work boundary and a narrowly scoped automated performance/correctness release check. It would be delivered as one complete change with all browser, notification and server consumers using the same contract. Provider execution, accepted-work ownership and original retained records would be preserved.

If approved, the responsible Concierge and Thinkering owners should turn this architecture into one concrete implementation design and acceptance contract, including complete writer coverage and migration/rollback details, before code begins. This retrospective is not that implementation authorization. If Tejas instead prefers a whole-system replacement, the next decision document must inventory what is being replaced and how history, custody and active work survive. Replacing the code must preserve those guarantees too.
