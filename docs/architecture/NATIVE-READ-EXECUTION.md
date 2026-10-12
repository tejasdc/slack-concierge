# Native read execution

The public and peer listeners admit requests without opening the canonical ledger. Native GET
routes have one storage-free classification in `bot/src/native-read-routes.ts`. Finite product
reads go to a pool of private read executors; command routes remain with the canonical owner;
event streams and reads that require live coordinator state use their declared owner path.
An unknown GET has no execution owner and is refused. The former Inbox topics and questions
paths normalize to their prepared presentation paths before execution.

Each read executor has its own Unix socket, SQLite connection opened physically read-only and
with `query_only`, and its own event loop. It cannot initialize schema or a session execution
host. It reuses `SessionOwner`'s GET validation and response projection through `handleRead`;
the supplied runtime facade contains only read capabilities. The prepared readers retain their
storage and response budgets. Provider history uses its existing history-page worker and
provider capabilities. Exact files and account profiles are read in the executor. The
canonical owner supplies only current sign-in ephemera through its private, memory-only
endpoint; a requested fresh account check enters the owner's explicit refresh command before
the executor assembles the account view. If that live state is unavailable, Accounts reports
unavailable instead of inventing a sign-in state. Peer account and file reads use the existing
peer API, with the same target identity and timeout semantics.

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
GET exception or prepared route lacks a classification. The budget for a cold direct Inbox
topic-list fallback is unchanged: its full-ledger scan can exceed the prepared read contract
and then returns `READ_BUDGET_EXCEEDED`. Making that fallback independently bounded requires a
new declared projection and growth fixture, rather than lifting the existing budget.
