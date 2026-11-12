# Prompt answers to human thread replies

When Tejas writes in an Inbox thread addressed to its working agent, the Inbox owner retains his
words and creates one request under that exact thread. Every such human reply has a prompt-answer
obligation. This deliberately includes messages without a question mark: punctuation and prose
classification cannot be the enforcement boundary. The recipient can keep working on the original
task while answering the new message.

The main thread and a message reply thread are separate durable scopes. `replyToMessage` keeps
the immediate parent link that the main thread already used; `messageThreadRootId` names the
agent message whose nested conversation is open. Its absence means the main thread. The owner
accepts a nested human reply only when that root is an agent message in the same Inbox topic, the
immediate parent is the root or already belongs to its nested conversation, and the fixed
recipient is the root message's recorded author. The root's request identity is retained with the
forwarded work, so two messages from the same session but different requests remain different
conversations. These checks run again at the owner rather than trusting the browser's recipient.

Every returned answer carries the same message-thread root and replies to the exact human message
that prompted it. This applies across the server and Mac peer paths and to stopped
terminal posts. An agent may add `--also-main-thread` to a reply when the same words should also be
visible in the main conversation; the owner writes a separate attributed main-thread post whose
message-thread root is absent. The flag is refused for an ordinary main-thread request. Human
messages sent to the main composer keep the existing default: the owner of the item replied under,
otherwise the one agent still at work, otherwise the Inbox router when ownership is absent or
ambiguous.

Previously the forwarded request explicitly entered the recipient's queue, so a long running
agent did not see it until its turn ended. Partial replies already posted in the thread, but their
only durable meaning was progress. The ordinary overdue check ran after fifteen minutes and
postponed itself while the recipient was healthy, so it could not detect an unanswered question
during active work. The new answer clock belongs to the human thread request, not the work-stall
clock.

The request enters the recipient's live run through the ordinary agent-input channel. If that run
ends between acceptance and delivery, the same input enters its queue; it is not replayed after an
ambiguous provider send. A Mac recipient uses the same peer request and live-input path. When the
Mac sleeps, the origin retains the request and the answer clock still records that no answer has
arrived; the Mac receives its input when it wakes.

The recipient answers with a final request reply or a partial reply bearing `--answers-question`.
The latter posts the agent's words in Tejas's thread immediately, records an explicit answer signal,
and keeps the work request open. After that partial, a final reply may omit its body. The owner
requires the earlier answer signal for that exact request, closes the request, and records its
disposition and checked/not-checked facts as an append-only closure attached to the answer post.
The final creates no second answer post. If a final has body text, those new words are posted
verbatim with the closing facts attached. An ordinary progress partial does not satisfy the answer clock.
The prepared Inbox view resolves the closure through the retained post association and refreshes
that same answer when the closure arrives. On installation it
also refreshes answers with closures already retained before this display version, so a thread
read and its live changes expose the same facts without creating another message.
The same signal is retained on the Inbox post as `answersQuestion:true`, including the prepared
message projection. A non-stalled final carries that marker too, whether the request was directly
forwarded from a human thread reply or dispatched by the Inbox router. Progress and stalled notices
do not. Existing unmarked posts stay available for separate backfill judgment.
The request owner checks this signal, not the reply's prose. The flag is accepted on a nonempty
partial reply to any request whose replies post into an Inbox thread: a forwarded human reply, and
equally work the router dispatched for a question it recorded in that thread (`kind:'asked'`, owned
by that dispatch), whose answer view reads exactly these marked posts. The flag never refuses a
reply. On a final, on an empty reply, or on a request with no thread, the CLI and owner drop the
mark, record the reply as written, and say why in the command's output and the reply receipt's
`notice`. Before 2026-10-21 they refused it instead: 118 answers in a week were refused, 112 of them
router dispatches into his threads, and the workers re-sent them as unmarked progress, so his
recorded questions showed no answer and an urgent safety answer read as unseen for hours
(request 39914136). For a peer reply, the signal travels with the retained reply event; the
origin, which holds the thread, drops it with a log line where it does not apply.
The Mac sends the original final body and closing facts separately; the origin checks the same
earlier signal before accepting a bodyless final. Each separately accepted reply stays
visible under its own request, even when its words match another reply exactly. Only one
explicit `--also` command shares a visible answer, using that command's retained identity;
it still settles each named request. A bodyless final attaches closure facts to the exact
request's earlier answer [decision: fix-protocols-never-hide-duplicates]. The October 21 copy-matched collapses and November 4 agent-update
collapses remain in the ledger as historical actions, but both direct and prepared Inbox
readers show those accepted posts again. Timer notices remain out of the human conversation
because they are agent-facing status, not agent answers.
On the server, the installed command wrapper always uses the current release's session command
parser. A running agent can retain an older bundled parser across a deployment; using it for a
reply would reject `--answers-question` before the owner could record the answer.

At two minutes without that signal, the recipient receives one service reminder through the same
live-input channel. At three minutes, the origin records one overdue event in the request ledger.
No timer event posts in Tejas's thread or notifies him, on either the server or Mac peer path.
Older timer posts are retired from the Inbox projection with append-only collapse events; their
request and original post records remain available for diagnosis.
An ask explicitly carrying `--return-to-requester` still sends the agent requester a return.
A late answer is posted to the same thread. The existing fifteen-minute work-stall policy remains
separate and resumes after a prompt answer; its timer events also stay out of his thread.
An unavailable agent or sleeping peer cannot promise a semantic answer by a wall clock.

The origin owns the due time and answer signal. A peer recipient owns its own reminder timer from
the instant it accepts the request. Stable reminder input identities and retained reply event IDs
make retries and restarts idempotent. No timer closes, cancels or resends the underlying work.

For live acceptance, a marked agent test input may reply inside an Inbox thread through the same
forwarding path. Its stored and displayed author remains agent. Its test overdue is retained in
the request record without a thread post or Inbox router wake. This lets the check prove delivery
to a busy recipient and the returned answer without impersonating him.
