# Requested phone delivery

The owner classifies the retained words of a human Inbox input as `result`,
`scheduled`, or `null` at admission. Ordinary requests to notify, ping, alert, or
let Tejas know when work finishes select `result`; “remind me” selects
`scheduled`. The mark is derived only from his words. A quoted note, an agent's
text, a negated request, and a routine request for explanation do not arm delivery.
"If you still need my help, send me a notification" uses the blocking-question
notification if help is needed; it does not arm the topic's next result.

A `result` input arms its Inbox topic. The owner retains the exact human input
that armed it. The first final agent answer in that topic consumes every pending arm
and emits one requested notification whose `postId` names that answer. The push
body is the agent's posted words, carried as the event's `question`; it cannot
be fabricated from Tejas's request. A later answer is quiet. A later marked
human input inserts a new arm, so a later exchange can request another push.
The arm and notification event commit in one ledger transaction. An answer
filed by a local or Mac worker uses the same path. A router response counts only
when its turn did not dispatch work from that asking input; the router's post or
result must supply the actual message ID and words. An acknowledgement of work
in progress leaves the arm for the dispatched answer.
An interim reply, including one marked as answering a direct question, remains quiet,
and `--notify` cannot change that. It does not consume a result arm for work still in
progress. A later final answer can consume it.
If an answer also asks for Tejas's decision, its topic question remains a
decision; the requested phone event uses the `response` outcome required by
thnkr.ing's one-shot requested-result path.

An agent may explicitly request one push for its own message with `sessions
post --notify` or `sessions reply --notify`. The owner requires a new message
with words, names that message in the event, and emits
`requestedNotification:true`. This also consumes an open topic arm, so the
same answer never creates a second requested push. On a reply the flag is honored
only for a final `completed` reply carrying `--checked` (a finished result checked live);
on a partial, failed or unchecked reply it is dropped with a receipt notice and the reply
is recorded as written. Tejas, 2026-11-02, after the think-aloud agent sent 14
partial-update alerts in two hours: "Why can't it wait until everything is deployed and
tested and then let me know?" A bodyless final cannot use it. These commands are available on both local and
peer sessions. The resulting push uses the answer's own words and the normal
thnkr.ing attention notifier. There is no direct push call from Concierge.

A ready decision question that blocks on Tejas, a `needs_you` turn outcome, and
a final `needs_decision` reply now produce a push by default. The owner retains
the blocking attention event with its exact Inbox thread or session, question,
agent identity and task title. A question declared in a topic emits that event
when it first becomes ready; a later turn outcome for that same run and thread
does not emit another. A reply already produces the thread's single attention
event. When the same posted message has already used `--notify` or consumed a
human notification arm, the blocking question remains visible without another
push. The notifier still suppresses a push while Tejas is viewing that exact
thread and keeps its normal per-thread slot and device delivery record.
Routine progress and completed work do not acquire this default.

The question's first line is the notice's first line, and it is the agent's own one-line
`--summary`: every final reply already requires one, and a `needs_you` outcome now requires
it too (at most 200 characters, saying what he must decide and the result it depends on). The
owner places it before the agent's text and his words, on the Inbox filing (since 2026-11-04),
the requester's returned decision, the recorded question and a Mac worker's need. A thread
question already has its own `decision` line. Before this, on 2026-11-02 a booking agent's
decision opened with an unrelated email paragraph, and the class result and his choice sat
past what the Lock Screen showed ([failure record](../incidents/2026-11-02-decision-notice-buried-the-result.md)).

### A thread worker waiting on him

An agent working on an Inbox thread that declares `needs_you` at the end of a turn reaches him through
that thread: the owner posts the question as the agent's words and files it exactly as a
`needs_decision` reply (a blocking decision with the thread's notification). thnkr.ing leaves a turn the
Inbox started to the Inbox, so before this the declaration reached no device; on 2026-11-02 the Uber
Eats agent's request for a photo was lost that way after its "could not finish" reply filed only a
reading item. The thread is the one his originating message belongs to (the turn's provenance); a
session he started himself keeps its own notification. A reply and an outcome from the same agent run
are one ask and ring once; a later run's ask keeps its own question. A Mac worker retains its declared
outcome with the exact peer request and forwards it through the existing durable reply channel, even
when a final reply already closed the request. The server checks that request's Inbox origin and thread,
then posts and files the decision there. The same event ID makes a repeated send harmless; an offline
Mac keeps the event pending and retries later until the server acknowledges it.

If a server worker's turn traces to Inbox work but the exact request has no usable
thread address, the server creates a separate Inbox thread titled for the asking agent and puts
the agent's exact question there. Its decision belongs to that agent, so a reply in the thread
can still reach the agent. The question and its blocking notification are committed with the
turn outcome; a filing error is rolled back before this fallback runs. A worker without an Inbox
origin keeps its own session attention and does not create an Inbox copy. Agent-authored Inbox
requests retain their agent provenance; they are never presented as Tejas's words. This fallback avoids
guessing from the last thread that happened to send work to the same agent.
If the request record itself is missing, the accepted worker input's direct source and exact source run
can establish the Inbox origin; the server still creates a new thread rather than borrowing an older one.
The same verified source chain carries Inbox origin through an intermediary server agent whose onward
request has no Inbox thread address.

### Concierge's own notices never ring

Two notices Concierge writes about its own bookkeeping reached his phone on 2026-11-04 and gave
him nothing to act on (Tejas: "notifications that were nothing I could actually act on"):
the thread line "Your request is still open. Concierge has tried twice to restart its work"
(three pushes) and "A result reached this conversation, but the agent stopped…" for a result
nobody read (one push, from the repair agent's session). The first is now posted in the
thread without a notification; the second is recorded as something to read (`response`), so
it stays in Needs attention without ringing. Only a question only he can answer or a finished,
checked answer rings.

### A question tied to the to-do it asks for

A question that asks him to sign in, give a secret or do something on his device names the to-do
that step is on his list as: `--todo <id>` on `sessions outcome needs_you` and on a
`needs_decision` (or question-carrying failed) reply, or `--todo none` when no to-do for that step
exists; the Inbox router's own topic questions carry the same `"todo"` field. Concierge refuses the ask without it. Before accepting, the routed request API reads that
to-do from thnkr.ing's to-dos over its local capability socket (over SSH from the Mac); a to-do he
already marked done or dropped refuses the question, so it never rings him, and the refusal tells
the agent he has done it. When thnkr.ing cannot be read, the question is accepted, never lost. The
question records the to-do; on the owner's reading cadence a to-do he ticks off (or drops) settles
its open question as answered and tells the asking agent to carry on. A Mac agent's question is refused the same way (its Concierge reads the to-do over SSH), but its to-do does not yet travel with the question to the server, so it does not close by itself; a needs_you from a session he started directly lives in Needs attention, not a thread question, and also does not close by itself. Matching is by exact to-do
id, never by wording. Source: 2026-11-04, the Diwali agent asked him at 2:58 PM for a Spotify
invite he had marked done at 10:20 PM the night before
([record](../incidents/2026-11-04-asked-for-a-step-already-done.md)).

### No automatic reminders

On 2026-10-30 Concierge briefly reminded him of every question waiting on him
(one and four hours after asking, then a morning list). He removed it the same
evening: "It should only happen to things that I specifically say, hey, remind
me of this … sometimes the agent will be waiting and I don't care about the
feature that much." An agent waiting on him is therefore never a reason to
notify again. A repeat belongs only to a notification he asked for, and only
while he has not opened it; whether he opened one is known only to thnkr.ing,
which owns that repeat.
