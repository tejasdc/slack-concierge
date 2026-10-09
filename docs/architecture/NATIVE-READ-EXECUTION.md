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

The read executor does not own command custody, provider dispatch, background reconciliation,
or ledger writes. Its Inbox read expects the canonical owner to have created the Inbox at
startup. Its transcription-status read can inspect a completed speech spool result but only
the canonical owner commits or removes it. The canonical owner remains the sole writer and
the source of truth for commands and live status. A blocked owner can still make true live
status or fresh sign-in checks unavailable; it cannot hold an independent prepared, provider
history, or file read's event loop. A blocked read executor occupies only its own pool slot;
the supervisor keeps another executor available and retires a timed-out one.

Failed and slow read completions, plus a one-percent ordinary sample, include the route template,
status, duration, measured storage work and gateway admission ID without path or query data.
Counters retain all completions, elapsed time and sampled-out logs. `/internal/ready` reports
those counters, logger health and child PID so the supervisor can reject an unrelated socket.
Shutdown closes the listener and the history client.

The route classification is the executable manifest. Its `source` identifies prepared,
canonical, provider, filesystem, account, or control reads; `domain` identifies the read
executor, live owner, or stream owner. `assertNativeReadRouteCoverage` fails when a registered
GET exception or prepared route lacks a classification. The budget for a cold direct Inbox
topic-list fallback is unchanged: its full-ledger scan can exceed the prepared read contract
and then returns `READ_BUDGET_EXCEEDED`. Making that fallback independently bounded requires a
new declared projection and growth fixture, rather than lifting the existing budget.
