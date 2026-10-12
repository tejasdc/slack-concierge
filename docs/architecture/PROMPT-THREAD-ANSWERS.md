# Prompt answers to human thread replies

When Tejas writes in an Inbox thread addressed to its working agent, the Inbox owner retains his
words and creates one request under that exact thread. Every such human reply has a prompt-answer
obligation. This deliberately includes messages without a question mark: punctuation and prose
classification cannot be the enforcement boundary. The recipient can keep working on the original
task while answering the new message.

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
and keeps the work request open. An ordinary progress partial does not satisfy the answer clock.
The request owner checks this signal, not the reply's prose. The CLI and owner both reject the flag
outside a nonempty partial reply to a human thread request. For a peer reply, the signal travels
with the retained reply event and is checked again by the origin.

At two minutes without that signal, the recipient receives one service reminder through the same
live-input channel. At three minutes, the origin records one overdue event, posts a service notice
in the thread, and delivers one exact request notice to the Inbox router. The router checks current
replies before acting, since a late answer may race its notice. A late answer is still posted to the
same thread. The existing fifteen-minute work-stall policy remains separate and resumes after a
prompt answer. An unavailable agent or sleeping peer cannot promise a semantic answer by a wall
clock; three minutes is the upper bound before the visible overdue state and router escalation.

The origin owns the due time and answer signal. A peer recipient owns its own reminder timer from
the instant it accepts the request. Stable reminder input identities and retained reply event IDs
make retries and restarts idempotent. No timer closes, cancels or resends the underlying work.

For live acceptance, a marked agent test input may reply inside an Inbox thread through the same
forwarding path. Its stored and displayed author remains agent, and its test overdue does not
claim Tejas asked the question or wake the Inbox router. This lets the check prove delivery to a
busy recipient and the returned thread post without impersonating him.
