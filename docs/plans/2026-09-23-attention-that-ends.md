# Attention that ends: what waits on Tejas, where, and how it leaves

Status: approved scope from the Inbox router's request `a2a88e65` (Tejas, 2026-09-23: "is this
my job… to look at all the open questions… Should I keep reminding you every single time?"),
built in the same change as this document. Composes with the
[request reply protocol](2026-09-23-request-reply-protocol.md), which owns how a request between
agents closes; this document owns what reaches him.

## The problem, in his words and in the data

He opened Threads and found questions he had answered, announcements he could not answer, and
questions filed under the wrong subject. On 2026-09-23 the Inbox session carried 31 open attention
entries; the Threads list showed 25 of them across 13 threads, and 6 more sat in a thread that was
already closed ("Switching which account my agents use"), invisible in the list but still counted
on the Inbox itself. 11 of the 31 are "read this" announcements from finished work, some a day
old. Two of the 31 ask about the Mac capture bar and were filed under "Signing my other accounts
in", because the router's turn that asked them had been started by his message in that thread.

Two mechanisms produce one list, and they disagree:

1. **Turn markers.** Every turn ends with `[[outcome-k7q4:needs_you|response]] …`. The owner
   files it as a *need* on the session, under the thread root of the input that started the turn
   (`outcomeInputFor`). A need leaves only when he replies *in that thread*, when a later turn on
   the same root declares, or when his "mark seen" generation passes it. In the Inbox, the router
   answers many threads from one turn, so the need often lands in the wrong thread; the topic list
   ignores his "mark seen" generation, so clearing one on the session did nothing in Threads.
2. **Question records** (`inbox_questions`), declared with `topics questions`, with explicit states
   and a brief. These are right by construction — a topic, a decision, a why — and are the minority.

The Threads list merges both: ready questions plus every need on the topic's roots that no
question recovered. A `response` need is "something to read", but the owner counts it as waiting
on him, so the app filters it out client-side and the owner and the app disagree about the count.

## The rule

**In the Inbox, the only thing that can wait on him is a question record, in the topic it is
about. Every question has a kind, an owner who can retire it, and one of a fixed set of ends,
each moved by an explicit signal. Nothing is deleted; every end is recorded with its reason.**

Two kinds:

- **decision** — he must answer before work can move (`needs_you`). Blocking by default.
- **reading** — an agent has something for him to read; nothing waits on him (`response`). It is
  done when he reads it, not when he answers.

A turn marker in the Inbox never files itself. When the run declared a question in a topic
(`topics questions <topicId>`, kind `decision` or `reading`), that record is the attention and the
marker adds nothing. When it did not, the entry is held **unfiled**, in no thread, listed under
Being sorted as "Waiting for the router to file" with the thread its turn started from as a
suggestion; the router files it (`topics file <topicId> --need <id>`, or `from` in a full
declaration) and so can he, one tap. Guessing the thread from the input that started the turn is
exactly what misfiled the Mac capture bar questions, so nothing guesses (Sol, finding 1).
**A service notice is the one exception, and the owner files it itself.** A notice the service
publishes with no provider turn (`publishProviderFreeNotice`: a retry breaker tripping, a deploy
failing, keys rotated) has no turn to derive anything from and no router turn that will ever see
it, so held unfiled it would wait forever — the Codex App Server notice of 2026-09-25 did, and its
notification opened on "not in a thread yet" (Tejas: "Where is this message? Why is it not in the
thread?"). `fileServiceNotices` gives each one a thread the moment it exists: the open thread
already titled by the notice's first sentence, else a new one so titled, with a reading item whose
text is the notice itself (`readsFor` reads a service notice as its own answer). It runs right after
an in-process publish, at startup for notices another process wrote, and when a message is resolved
to its thread, so a tap can never arrive before the thread. Nothing here guesses: the notice is its
own thread root, and its title is its own words. The notice is that thread's conversation — its
author is the service with `communication: 'notice'`, so thnkr.ing shows it and he can reply to it,
and a reply there wakes the router like any other (three notice threads opened on nothing with no
reply, 2026-09-25: "something that has no conversation, and I'm not even able to respond to it").
**A notice whose condition clears says so and closes**: when the breaker that announced it is
cleared by a success (`clearRetryBreaker` → `resolveRetryNotices`), the owner posts "… is running
again as of …" into the thread as a service post (`postedBy: 'service'`) and closes it, which ends
the reading item; at startup the same runs for any retry notice whose breaker no longer exists, so
a clear that happened while nothing recorded it still settles. Its words are his: a moment is
written in his time zone (`noticeTime`: "September 24 at 11:03 PM ET"), never an ISO stamp, and a
notice names no file path. Outside
the Inbox nothing changes: a worker session is one conversation and its needs stay session-level.

### Ends, and the signal that moves each

| End | Kind | Signal | Who produces it |
| --- | --- | --- | --- |
| **answered** | decision | `topics answer` maps his reply; his reply in the thread names the question (review) or replies to its source | him, then the router |
| **read** | reading | his Read on the item (the app's `question` action `read`), the router's `acknowledge --item` naming it, or his "mark seen" on the Inbox up to that generation. Opening the thread is a reading position, never an end (Sol, finding 3) | him |
| **superseded** | both | a newer question replaces it (`replaces`, or `question settle --state superseded --replacement`); an *unfiled* entry on a thread is replaced by the next marker on that same thread, as before | the asking agent |
| **withdrawn** | both | `question settle --state withdrawn -- reason`; his own Withdraw in the app | the asking agent, or him |
| **declined**, **deferred** | decision | as today | the router (declined), him (deferred) |
| **expired** | both | the topic closes (`topics close`, or his Close): every open question in it; a topic request closes: only the questions whose owner names that request; the worker that asked sends its final reply with `completed` or `failed`: only the questions it declared for that request (`needs_decision` keeps them) | the router or the worker, through commands the reply protocol already defines |

`expired` never happens on a clock. A question that no one settles stays open, visibly, until a
real event ends it; "it has been a day" is not an event.

### Owner

Every question names who can retire it: `owner.sessionId` is the session whose turn declared it
(the router for Inbox turns, the worker for a question it declared against its own dispatch). A
worker may settle only its own questions; the router may settle any; he may withdraw, defer or
answer any. The owner is shown on the question so he can tell whose job it is.

### One count

The Inbox session's own attention (`attention.open`, `needsAttention`) is derived from open
questions: decision questions that are ready and awaiting him, and reading questions not yet
read. The session's `needs` list is no longer the source for the Inbox. `needsYou.count` on a
topic counts decisions only; reading items travel in the same list with `kind:'reading'` and a
separate `toRead` count. The Threads row, the Needs you filter, the Questions tab and the Inbox
card therefore agree, because they read one record.

### A result lands in its topic, and an unrelayed one is visible

A worker's final reply returns to the Inbox as a `return:<eventId>` input threaded under the root
of the request it answers (already true: `inboxThreadRoot`). The router relays it with
`sessions post --thread`. A topic whose newest return on any root is newer than the newest router
post on that root reports `work.kind:'result_waiting'` ("An agent's answer came back and has not
been relayed to you"), so he can see the router owes him a relay without reading logs. It is the
router's job, shown, not his. Only finals that arrived after this rule shipped count: before it the
router answered returns in its own turn text and rarely posted, so the dry run showed 15 of 21 open
threads owing a relay for history nobody will revisit.

## Today's backlog

A one-time migration (`topics_migration` version 2, guarded like version 1) turns every open
Inbox need that no question recovered into a question of the matching kind, `origin:'marker'`,
in the topic of its thread root, keeping the need's text, time, generation and event id. Needs on
roots that no topic holds stay unfiled (the sorting pile) until the router or he files them. Questions created in a **closed** topic are expired at once with the reason "Thread was
closed on <date>: <closure reason>". The Inbox session's `needs` is then rewritten to only the
unplaced ones. Nothing is deleted: the original `needs_you` events remain, each migrated question
records `recoveredFrom:'turn marker'`, and each expiry is a `topic_question` event with its reason,
shown in the thread's Timeline and the question's history.

Of the 31 today (measured by running the migration on a copy of the live state first): 23 become
questions in open threads (12 decisions, 11 readings), 7 become questions expired with the closed
thread's reason ("Switching which account my agents use"), 1 was already covered by a version-1
question, and the 2 real questions stay as they are. A question filed from a marker is
answerable by construction, so it is ready with only its decision text; the first dry run put all
12 decisions under "Agent checking" because the general readiness rule wanted a why and an
answerable, which a marker never carries.
For the backlog only, placement is inferred from the thread each turn started in — the only
evidence there is for old entries — and every such question says so on its face, so a misfiled
one can be ended as no longer needed and asked again in the right thread (there is no move for
a question; the two Mac capture bar decisions under "Signing my other accounts in" are the known
case, and the router owns settling them). What he then sees: decisions each in a thread with Reply, Set aside and No longer
needed; reading items under To read with a Read button, gone the moment he presses it.

## What he sees

- **Threads** rows count decisions only. A thread with something to read shows "To read · …" or
  "2 to read" until he presses Read on each.
- **Needs you** filter lists threads with decisions, oldest first, as today.
- **A thread's Questions tab** shows decisions with Reply, Withdraw and Defer, and a "To read"
  section with Read. Every question names who asked it.
- **History** in the Questions tab shows every ended question with its end and reason, including
  the ones migration expired.
- A thread whose result came back unrelayed says so in its row.

## Review and limits

GPT-6 Sol reviewed this design read-only before implementation (findings and resolutions appended
below). Out of scope: any clock-based expiry; changing the marker grammar; questions outside the
Inbox; automatic relay of a worker's result to him without the router.

### Sol's findings and what changed

GPT-6 Sol (read-only, `tmp/reviews/sol-attention.run.log`, session `01a0cca5`) returned REVISE
with seven findings. Each was adopted; the sections above describe the design as built.

1. **Do not guess a marker's topic.** The first draft filed a marker under the topic of the input
   the turn answered — the same inference that put two Mac capture bar questions under "Signing my
   other accounts in". Now a marker the run did not declare as a question is held **unfiled**, in
   no thread, visible to him and to the router, until `topics file` or his File gives it one. The
   backlog migration is the one place placement is inferred, and each such question says so.
2. **Every producer through one record.** Filed questions end only by their own explicit
   signals; the Inbox's session-level `attention.open` is derived from them plus the unfiled
   entries, and "mark seen" ends reading items only. His reply in a thread still retires an
   *unfiled* entry there (it is his message, in that exact thread, to the turn that asked), never a
   filed question. The unhandled-return path from the reply protocol still raises attention on the
   requester session; in the Inbox that lands unfiled, where it reads as the router's job.
3. **Opening a thread is not reading.** The thread `read` action stays a reading position. A
   reading item ends only by its own Read, an `acknowledge --item` naming it, or "mark seen".
4. **Expire only exactly linked items.** A topic close ends each open question with the closure's
   reason (the agent-side refusal to close with open questions is gone, since it left questions
   open in closed threads); a request close ends only questions whose owner names that request; a
   worker's `completed`/`failed` final ends only the questions it declared for that request, and a
   `needs_decision` final keeps them.
5. **Relay is a signal, not a guess.** `result_waiting` compares the newest *final* return with
   the newest router *post* on the same root, from an incremental per-root index; partial and
   stalled returns are not results and never trigger it. The prompt tells the router which return
   is unrelayed. A router that answers in turn text without posting is, by the Conversation rule,
   not answering him, so the state is correct to show.
6. **Migration joins by identity.** Version 2 skips every entry a version-1 question already
   covers (`legacyNeedEventId`), keeps the entry's generation and event id on the question so the
   client's generation and id filters still hold, records prior "mark seen" as `read` on reading
   items only, and leaves unplaced roots unfiled for the router.
7. **One owner-computed predicate.** The owner returns exact decision and reading lists and their
   counts (`needsYou`, `toRead`, `questions.open`, `waiting` per question); the client displays
   them and computes nothing.

Sol's alternative — a separate typed attention record rather than kinds on the question store —
was weighed and not taken: the question store already carries topic, owner, sources, revision,
exposure and answer bookkeeping, and a second store with the same fields would be the two-lists
problem again with a better name.
