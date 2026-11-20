# Native read execution

The public and peer listeners admit requests without opening the canonical ledger. Native GET
routes have one storage-free classification in `bot/src/native-read-routes.ts`. Finite product
reads go to a pool of private read executors; command routes remain with the canonical owner;
event streams and reads that require live coordinator state use their declared owner path.
Pause status uses a read executor because its gate, stopped runs and last peer
observation are retained in the ledger. This keeps the screen responsive even when
an Inbox command occupies the canonical owner's loop. The executor uses a single
read transaction and the same configured peer names; only the owner refreshes peers.
The exact human-conversation read also runs in a read executor. It takes live
thread membership and authorship from one ledger snapshot and can answer while
the owner is still warming the general Inbox index. The request keeps the same
content admission and cursor checks.
The owner keeps each event stream's live subscription and cursor. For each bounded replay
page it asks the local gateway to run the retained event projection in a read executor,
then forwards the executor's complete SSE frames. The gateway's private page entrance is
available only on its root-owned Unix socket, not the peer listener. A slow historical
projection therefore occupies one read slot, leaving the second available for interactive
reads; the owner can still admit commands. A reader failure closes the stream so the
consumer reconnects from its last received cursor. The page keeps the existing 200-event
boundary and has no response byte cap, since a retained message can exceed the ordinary
JSON event read's 2 MiB cap. Slow page logs report duration, event count, bytes and storage
work without recording content.

Session search keeps its public POST and peer federation on the canonical owner. The owner
starts its meaning search, which ranks in yielding steps, and immediately calls the private
`/internal/session-search` entrance on the root-owned local socket. Word, historical routing,
archive and meaning work overlap. At the meaning merge point the executor awaits the result
through `/internal/session-search-meaning` on the private owner socket, using that search's
opaque identity. The owner retains the promise through both reads or fallback and removes it
when the search finishes. Only the owner touches the meaning index. Neither private entrance
is available to peer or agent listeners. The composed read-only `SessionOwner` resolves word, routing, archive and
meaning hits, reads the peer catalogue and mutuals, and builds and bounds the returned session
views in a read executor. Prepared word and historical routing searches still use their sealed
subprocesses. Search uses the archive lane: it may occupy only one of the two readers, and
interactive app reads pass its backlog, keeping capacity for the Sessions panel and other reads.
That one archive reader is shared with the owed-replies check and whole-transcript reads, so
concurrent searches queue behind them and the pool's response limit counts that wait. A search
that spends its budget queueing falls back onto the owner, which is the block this moved off it,
so the fallback separates `queued` from a broken or absent executor and `session_search_slow`
carries `executor_wait_ms`. Giving search its own lane would let it and an archive read hold both
readers at once and take away the free reader his interactive reads rely on; the measurement
decides whether that trade is needed rather than assuming it.

An unchanged imported source resolves without writing. Sources that need creation or a metadata
update return as exact pending source descriptors, in discovery order, without a partial answer.
The owner replays that pass's source resolutions in order, preserving meaning's
native-session-first lookup, and asks the executor once more with each exact resolution's
materialization receipt. The second projection can therefore use two different retained
descriptors of one source without requesting the intermediate write again. The normal steady
state has no pending sources and no owner ledger assembly. If the executor is unavailable, refuses, times out or
still needs materialization after that second read, the owner runs the existing local assembly
and logs `session_search_executor_fallback` with a content-free reason. No query, message or
vector is logged. `session_search_slow` retains its existing phase fields and adds
`executor_ms` (awaited gateway/read time, including queueing and both reads), `owner_ms`
(request time outside executor waits, including rare writes), `meaning_embed_ms` and
`meaning_rank_ms`. Meaning overlaps executor waits and retains its own phase timings; these
elapsed values are not owner CPU measurements. A failed or unavailable meaning phase keeps
its existing word-only degradation. Failure to fetch that private result refuses the executor
read and uses the same owner-held promise in the local fallback.

The owed-replies Stop check retains its command authority on the canonical owner.
For an Inbox session only, the unfiled-input projection uses the same private
gateway and read pool as retained stream pages. It runs in one physically
read-only ledger transaction; its in-memory thread and entry indexes belong to
that executor. The private entrance is unavailable on peer and agent network
listeners. After awaiting it, the owner resolves the caller's current running
turn again before assembling reply obligations or recording offers/reminders.
Request cancellation, reader refusal and deadline failure do not trigger an
owner-thread fallback or become an empty filing list. Non-Inbox checks need no
executor hop. The retained-history projection occupies the pool's archive lane,
leaving independent interactive read capacity available. See the
[November 13 failure record](../incidents/2026-11-13-owed-check-rebuilt-inbox-history-on-owner.md).
An unknown GET has no execution owner and is refused. The former Inbox topics and questions
paths normalize to their prepared presentation paths before execution.

Each read executor has its own Unix socket, SQLite connection opened physically read-only and
with `query_only`, and its own event loop. It cannot initialize schema or a session execution
host. It reuses `SessionOwner`'s GET validation and response projection through `handleRead`;
the supplied runtime facade contains only read capabilities. The prepared readers retain their
storage and response budgets. Provider history uses its existing history-page worker and
provider capabilities. Every history read is logged with where its time went: the history-page worker's own time and phases (stored-window load, Codex item listing and page count, timestamp read and whether it came from a runner, window build and save, provider page), the round trip to that worker, and the executor's remaining time; Captures and Lab reads are logged on every read with their storage work and size (2026-11-20 nightly review). Exact files and account profiles are read in the executor. The
canonical owner supplies only current sign-in ephemera through its private, memory-only
endpoint; a requested fresh account check enters the owner's explicit refresh command before
the executor assembles the account view. If that live state is unavailable, Accounts reports
unavailable instead of inventing a sign-in state. Peer account and file reads use the existing
peer API, with the same target identity and timeout semantics. Both the owner and this executor
keep other machines' last account answers in one shared store (`peer-account-answers.ts`). The
owner's sign-in ephemera carry when a sign-in action it carried to each machine last finished
(`peerAuthActedAtMs`), and an answer read before that is never served as current, so a
thnkr.ing reading taken after a sign-in starts or ends always reflects it (2026-11-04: a
30-second-old answer could otherwise say a just-started Mac sign-in was not waiting).

The composed foreground release fixture requires the Accounts response to contain exactly
Claude, Codex and Antigravity by provider identity, independent of ordering. Its scratch
owner supplies a null Antigravity account alongside the other empty sign-in state. The
October 12 candidate failed before activation because this fixture still asserted two
providers after Antigravity was added; the identity assertion preserves missing, duplicate
and unexpected-provider detection without hiding a changed response behind a count.

The read executor does not own command custody, provider dispatch, background reconciliation,
or ledger writes. Its Inbox read expects the canonical owner to have created the Inbox at
startup. Its transcription-status read can inspect a completed speech spool result but only
the canonical owner commits or removes it. The canonical owner remains the sole writer and
the source of truth for commands and live status. A blocked owner can still make true live
status or fresh sign-in checks unavailable; it cannot hold an independent prepared, provider
history, or file read's event loop. A blocked read executor occupies only its own pool slot;
the supervisor keeps another executor available and retires a timed-out one.

Session search also reads retained historical routing evidence. That search now runs in the
existing sealed search process with a physically read-only canonical connection and a ten-second
process deadline; its ranked results return to the owner for session attribution. The prepared
word index keeps its own independent read in that process. If historical evidence is unavailable,
the owner returns the other search sources with incomplete coverage. The restart-time Inbox entry
index stays in owner memory because thread commands use it, but its warm-up reads at most sixteen
rows and stops processing a step after twelve milliseconds before yielding to other owner work.
An individual SQLite call can exceed that target under storage contention, so installed lag
records remain the acceptance check.
The entry index selects at most sixteen sequence keys through the existing
session/kind covering index before hydrating those exact events through the full
Inbox visibility predicate. Sorting therefore carries keys, not message content.
Its cursor advances over inspected candidates even when none is visible, and
advances only through processed messages when the step deadline interrupts a
page. Synchronous catch-up also uses these bounded pages; the owed-replies path
performs that catch-up in a read executor as described above.
Search answers carry bounded evidence previews and a bounded encoded body; selecting a result
uses the exact context read for full text. Slow searches log elapsed time for prepared words,
historical routing, meaning, archive search and retention, plus final answer size. These phases
identify expensive search work without recording the query or message text.
The archive search begins alongside the independent word and routing reads. Thinkering's compact
proof checks the selected source version, branch and matched event without building its full
history projection; opening the conversation still prepares that history. A peer serving the
older source contract uses the prepared history proof until it is upgraded. Search updates an
already imported session only when its retained source or labels actually changed.

An Inbox topic command taking at least 250 milliseconds logs its action, known topic ID and
time spent resolving the caller, retaining its source and executing the command. A slow topic
mutation, whether issued by the Inbox agent or through a human topic control, also logs who
acted and time spent retaining the action, computing its change, recording that change,
writing the receipt and finishing the transaction; a merge names its source and destination
topic IDs. These records contain no topic text. The
October 12 four-second topic-command transaction predates these fields, so its exact action
cannot be recovered from that lag record alone.

Failed and slow read completions, plus a one-percent ordinary sample, include the route template,
status, duration, measured storage work and gateway admission ID without path or query data.
Counters retain all completions, elapsed time and sampled-out logs. `/internal/ready` reports
those counters, logger health and child PID so the supervisor can reject an unrelated socket.
Shutdown closes the listener and the history client.

The route classification is the executable manifest. Its `source` identifies prepared,
canonical, provider, filesystem, account, archive, or control reads. Archive attribution may
occupy only one reader and cannot consume the interactive queue; `domain` identifies the read
executor, live owner, or stream owner. `assertNativeReadRouteCoverage` fails when a registered
GET exception or prepared route lacks a classification. His device's Inbox topic list never takes
the direct ledger fallback: under this budget that full-ledger scan could only return
`READ_BUDGET_EXCEEDED` (162 refused Threads reads on Nov 12, 21:15-21:17 UTC), so the route
answers `presentation_indexing` with a one-second retry until the prepared list is ready, and the
device keeps its rows meanwhile. Agents' `sessions topics list` keeps the ledger fallback.
