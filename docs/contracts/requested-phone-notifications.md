# Requested phone delivery

The owner classifies the retained words of a human Inbox input as `result`,
`scheduled`, or `null` at admission. Ordinary requests to notify, ping, alert, or
let Tejas know when work finishes select `result`; “remind me” selects
`scheduled`. The mark is derived only from his words. A quoted note, an agent's
text, a negated request, and a routine request for explanation do not arm delivery.

A `result` input arms its Inbox topic. The owner retains the exact human input
that armed it. The first agent answer in that topic consumes every pending arm
and emits one requested notification whose `postId` names that answer. The push
body is the agent's posted words, carried as the event's `question`; it cannot
be fabricated from Tejas's request. A later answer is quiet. A later marked
human input inserts a new arm, so a later exchange can request another push.
The arm and notification event commit in one ledger transaction. An answer
filed by a local or Mac worker uses the same path. A router response counts only
when its turn did not dispatch work from that asking input; the router's post or
result must supply the actual message ID and words. An acknowledgement of work
in progress leaves the arm for the dispatched answer.
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

The old per-input session promises, session watcher, peer replay, expiry,
backfill, and service posts are retired. Their historical ledger rows remain
inert, including any pending rows. They no longer create notifications or
Timeline entries. This means an earlier marked request with no new arm does
not silently ring later; Tejas can ask again in that thread or an agent can use
`--notify` when it answers. The retired watcher had recorded sleeping-peer gaps
and account holds, but could also treat an unrelated run finish as fulfillment;
the replacement fires only from an agent message in the topic.

For `scheduled`, Concierge still uses its durable scheduled wake and
thnkr.ing's requested-notification capability with a stable key. A time reminder
does not consume a thread result arm.
