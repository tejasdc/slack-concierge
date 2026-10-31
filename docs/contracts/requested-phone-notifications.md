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
An interim reply, including one marked as answering a direct question, remains quiet
unless the agent explicitly uses `--notify`. It does not consume a result arm for
work still in progress. A later final answer or explicit notification can consume it.
If an answer also asks for Tejas's decision, its topic question remains a
decision; the requested phone event uses the `response` outcome required by
thnkr.ing's one-shot requested-result path.

An agent may explicitly request one push for its own message with `sessions
post --notify` or `sessions reply --notify`. The owner requires a new message
with words, names that message in the event, and emits
`requestedNotification:true`. This also consumes an open topic arm, so the
same answer never creates a second requested push. A partial reply can use the
flag; a bodyless final cannot. These commands are available on both local and
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

### No automatic reminders

On 2026-10-30 Concierge briefly reminded him of every question waiting on him
(one and four hours after asking, then a morning list). He removed it the same
evening: "It should only happen to things that I specifically say, hey, remind
me of this … sometimes the agent will be waiting and I don't care about the
feature that much." An agent waiting on him is therefore never a reason to
notify again. A repeat belongs only to a notification he asked for, and only
while he has not opened it; whether he opened one is known only to thnkr.ing,
which owns that repeat.
