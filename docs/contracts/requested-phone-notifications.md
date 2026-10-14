# Requested phone delivery

The owner classifies an Inbox input's retained human words at admission as `result`,
`scheduled`, or `null`. “Send a notification”, “notify me”, “ping me”, “alert me”,
"let me know when", an account or sign-in dependency, and close variants select
`result`; “remind me” selects `scheduled`. Negated requests and machine diagnostics
in a bug report do not make a phone request. An ordinary request for an
explanation (“let me know how”) remains quiet, as does a saved quotation filed
as a note. The mark belongs to the exact asking input, including a later reply in the
same thread, and cannot be added by an agent's text. New receipts retain even a
`null` classification, so later phrase-rule changes cannot reinterpret them;
older receipts without a stored mark keep their original classifier.

For every `result` Inbox input, admission creates one durable promise keyed by that
input. Its default condition is the next agent answer filed into that thread for
the same input. Admission writes a visible service entry after the human message.
The filed answer's existing requested-result event pushes once; the promise settles
in that same ledger transaction, with a visible fulfilled entry and no second push.
An Inbox router turn cannot close as `done`, `failed`, or `needs_you` with an
unarranged result promise: it must dispatch work from the input, answer with
`response`, or point the promise at an existing session. A router `response`
settles the promise only when it answered without dispatching work or pointing
at a session. An acknowledgement that work has started leaves the promise
pending for the dispatched answer. Once pointed, an immediate `response` for
that same input would push early and then push again when the session ends; the
owner refuses an explicit one and treats an already finished turn's inferred
response as `done`. The router can post a status in the thread and close `done`
while the promise waits.

The router points it with `router-actions.sh sessions notify-when --thread
<human-message-id> --session concierge:N|mac:N [--on done,needs-you,hold]
--summary "<his request>"` plus its exact source and stable action ID. The thread
must be the one the live Inbox turn is handling; only a marked human input can
be pointed. The default conditions are `done,needs-you,hold`. A local target
binds to its current run or the next run after the command. A Mac target uses
the same rule against the Mac owner's retained event stream and exact input
receipt, rather than a possibly coalesced catalogue card. A failed or canceled
run also satisfies `done`, and says that it ended without finishing.

The server owner keeps one promise state: `pending`, `fired`, or `expired`.
`pending` survives owner restarts. It expires after 14 days, long enough for ordinary
multi-day work while bounding stale promises, with an entry in
the thread; no push is claimed for expiry. The first matching condition atomically
records `fired`, posts one short service entry in the asking thread, and emits
one `needs_you` response event with the asking input as `notificationInputId`.
thnkr.ing's existing attention notifier reads that receipt and sends the push
to registered devices. Concierge does not call a second push path.
Only the router's own answer, a filed agent answer, and a fired watched-session
promise carry `notificationInputId` for a requested result. Service notices have
service-authored inputs and do not become requested results through an event's
ordinary `inputId`.

For a Mac target the server stores a cursor through the Mac's durable run and
outcome events. It reads exact input receipts for account, sign-in, and usage
holds. A sleeping or unreachable Mac leaves the promise pending and adds one
visible observation-gap entry; when it returns, replay resumes from the saved
cursor and the thread records reconnection. A hold that starts and clears wholly
while the Mac is unreachable is unavailable from current receipts: the gap is
visible, and Concierge does not claim it observed that hold. The current/next
run selection for an offline Mac compares the Mac's retained event times with
the attachment time; clock disagreement at that boundary is a remaining risk.

For `scheduled`, agents continue to use Concierge's durable scheduled wake and
thnkr.ing's root-only requested-notification capability with one stable key.
That time path is separate from result promises, because a normal answer may
arrive before the requested reminder time.
