# Request reply protocol: how an answer always comes back

Status: approved scope from the Inbox router's request `6f8451df` (Tejas, 2026-09-23), built in
the same change as this document. Supersedes the "retained text" and "unanswered" inferences
described in older revisions of the session-owner docs.

## The problem

When one session hands work to another (the Inbox to a worker, a worker to another worker, on
this machine or across to the Mac), the answer has to come back, and nobody should have to
wonder whether it will. Until now the owner decided some requests by reading prose: when a
worker's turn ended without a reply command, the owner took the turn's closing text as the
answer (`undetermined`) or its silence as `unanswered`, and closed the request. Between
September 16 and 23, 2026 that closed 72 requests (63 as `undetermined` or `unanswered`, 9
informational ones as answered), 36 of them after the worker had said with `--partial` that it was
not finished. On September 23 it closed an Inbox request to the Mac on
"Final reply will follow", and six minutes later threw away the worker's real final answer
while telling the Mac it had arrived.

Tejas, 2026-09-23: "Why can't the agent say this is his final reply? Why can't the agent use a
CLI to respond and have parameters? Do you know about functions and determinism?" and "How do you
guarantee a late final answer always comes back? … if you turn ends without a final answer, and
you say we're going to keep waiting on that agent. How long will you wait? What's the protocol
there?"

## The rule

A request is decided only by explicit signals, never by reading text. Every wait either has
something that will end it or is reported, once, to the requester. Nothing is guessed.

## Grounding: which established work this follows

Tejas, 2026-09-23: "Is this grounded in protocol science? … Do not bring back to me half big
solutions here."

**Agent conversation: the FIPA Request Interaction Protocol** ([SC00026H, standard, 2002-12-03](http://web.archive.org/web/20240213112913/http://www.fipa.org/specs/fipa00026/SC00026H.pdf);
fipa.org itself now serves an unrelated site, so the archived copy is cited). FIPA: the participant
may refuse or agree (agree is optional when the action is quick), and once agreed "the
Participant must communicate either: a failure …, an inform-done …, or an inform-result"; the
initiator may cancel at any point through the cancel meta-protocol, which the participant answers.

| FIPA act | Here | Notes |
| --- | --- | --- |
| request | `sessions ask` | the request is recorded before anything else happens |
| agree | `sessions reply --partial` | optional, as in FIPA; also carries progress |
| refuse | final `--work-disposition failed` with the reason | one closing act instead of two |
| failure | final `failed`, or the owner's execution-failure close | the owner may close on a *fact* (the execution ended in error), never on prose |
| inform-done / inform-result | final `completed` (work) / the informational answer | |
| — | final `needs_decision` | **departure**: FIPA has no act for "a person, not the requester, must choose" |
| cancel meta-protocol | `sessions cancel`; the worker is told to stop | **departure**: the worker is informed but does not answer the cancel; the owner already knows the outcome |
| reply-by (FIPA ACL message parameter) | not used | **departure**: agents have no meaningful deadlines; instead the owner watches liveness (is anything going to wake the worker?) and reminds once, then reports |

**Delivery between ledgers: transactional outbox, at-least-once, idempotent receipt**
([transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html):
store the message in the same transaction as the state change, relay it separately; the relay
may duplicate, so "a message consumer must be idempotent … tracking the IDs of the messages that
it has already processed"). Every result is an event row written with the request's outcome
(the outbox); `return:<eventId>` and peer event IDs make delivery idempotent; a peer reply is
resent until the other ledger acknowledges that exact event ID (per-message acknowledgement, as
in broker publisher confirms). Nothing here is exactly-once transport; exactly-once *effect* comes
from idempotent receipt.

**Durable workflow** (the `stateful-shapes` catalogue, shape 3 and guideline 13): the request is
a workflow with one open obligation; each transition is a recorded event, and the old status
field was not allowed to be decided by reading text.

## States and the signal that moves each

| State | Entered by (explicit signal) | Who produces it |
| --- | --- | --- |
| **accepted** | `sessions ask` receipt; the request is in the ledger before anything else happens | requester's command, owner |
| **queued offline** | the peer machine did not answer at ask time; the body is kept and delivered when it does | owner |
| **delivered** | the worker's provider recorded picking up the input | owner, from the provider's own record |
| **working** | the worker's run is live, or the worker sent `sessions reply --partial` | worker's run / worker's command |
| **reminded** | the request became *stranded* (below) for the first time; the owner wakes the worker once | owner |
| **stalled** | stranded again after the reminder; the requester is told | owner |
| **closed: answered / decision needed / failed** | the worker's final reply (`--work-disposition completed / needs_decision / failed`; an informational final is answered) | worker's command |
| **closed: canceled** | `sessions cancel` | requester's command |
| **closed: failed (execution)** | the worker's execution ended in error or was cancelled; the target no longer exists; the peer does not hold the request | owner, from execution facts |

`reminded` and `stalled` are still open. A final reply from the worker closes the request from
any open state, and returns. The only recipients whose turn *is* their reply are those that have
no reply command at all: ChatGPT and consultation-only sessions, for a turn dedicated to the one
request.

## Stranded: what "waiting on the agent" means, and how long

An open request is **live** while something in the system will wake its worker:

- the worker session is running, or has queued input; or
- the worker is itself waiting on another open, not-stalled request it sent (on either machine).

When none of these hold, and the worker's turn has ended, the request is **stranded**: nothing
would ever produce its answer. The owner checks this at the moment it can change — when the
worker's execution ends, and when a request the worker sent closes — so there is no polling
timer for it.

1. **First stranding → one reminder to the worker.** A service input into the worker session:
   "Request X from Y is still open. Send your final reply now with its disposition, or a
   `--partial` saying exactly what you are waiting on." The worker runs and must answer by command.
2. **Stranded again → stalled notice to the requester.** A notice event returns to the requester:
   the worker, its last partial if any, and that nothing tracked will wake it. The request stays
   open; a late final still lands and returns. Nothing further happens automatically: the
   requester (for the Inbox, Tejas through it) decides to wait, ask again or cancel.

So "how long" is: as long as something real is keeping the worker busy or waiting; the moment
nothing is, one reminder; if that does not produce a final, the requester is told. Every wait
ends in a final answer, a failure, a cancel or a stalled notice.

Cases:

- **Turn ends without a final reply** → stranded → reminder → final, or stalled notice.
- **Worker says `--partial` and is waiting on another agent** → live while that request is open;
  that request follows this same protocol and ends in a final, failure or stalled notice that
  returns to the worker and wakes it. Two workers waiting on each other are reported by the due-time notice (below).
- **Worker says `--partial` and waits on something untracked** (a deploy, a human it did not
  ask) → stranded → reminder → if still no final, stalled notice naming its last partial.
- **Worker process dies** → the owner's turn recovery ends the turn in error → the request closes
  `failed` with the execution fact, and returns. A turn whose outcome is uncertain (parked) is
  not guessed: the 30-minute due-time notice tells the requester the worker needs recovery.
- **Worker's machine is offline** → queued offline, or the peer is unreachable; the request
  stays open; the 30-minute due-time notice tells the requester which machine is offline.
  Replies the worker made are kept on its machine and forwarded when it is back.
- **Worker waits on its usage allowance** → its input is queued with a known reset instant (the
  existing usage-hold path, which also notifies Tejas directly); live, not stranded.

The existing once-per-request 30-minute due-time notice remains the backstop for everything that
looks live but is not progressing (a parked turn, an unreachable peer). It informs; it never
closes.

## Guarantee that the answer reaches the requester

- **Recorded before delivered.** A final reply, a stalled notice, a failure: each is an event row
  in the requester's ledger, written in the same transaction as the request's outcome.
- **Exactly one return per event.** Each event becomes one `return:<eventId>` input in the
  requester session's durable queue. The ID makes a retry the same input, never a second copy.
- **Requester busy** → the return joins its running turn's own input queue or waits in its FIFO.
  **Conversation full** → the existing in-place compaction recovery. **Paused or archived** → held
  on purpose and delivered on resume.
- **Restarts and deploys** → every undelivered event is rescanned at start; a peer reply still
  pending is resent every minute until the origin acknowledges that exact event.
- **Across machines** → the worker's machine forwards each reply; the origin answers per event
  `recorded`, `duplicate` or `refused`. Only `recorded`/`duplicate` marks it forwarded. The origin
  also pulls the worker's replies whenever it observes the request, so a missed push is recovered.
- **When delivery fails, someone is told.** A return still undelivered after ten minutes logs
  `session_return_undelivered`; a return whose requester turn died logs
  `session_return_unhandled` and raises Needs attention on the requester session in Thinkering,
  so Tejas sees it without anyone reading logs.

## Requests already closed by the old guess

- They stay closed as history (their `undetermined`/`unanswered` returns already went out), but
  the guess no longer blocks the truth: a worker's later explicit final supersedes the inferred
  one (`superseded_by_event_id`) and returns as its own event.
- Late answers already thrown away: on the same machine the worker got an error and nothing was
  kept, so they cannot be recovered. Across machines the worker's machine kept them; on its first
  start this release rereads the peer's replies for inferred closures from the last 14 days and
  records what is missing, which returns it.
- Open requests from before this release keep the old due-time behaviour: reminders apply only
  to requests asked after the release, so a deploy does not wake a dozen old sessions at once.

## What Tejas sees

- Handing work off: nothing changes; the Inbox tells him it is with the worker.
- Worker's partial: the Inbox receives it and can relay progress.
- Worker ends a turn without answering: nothing reaches him; the worker gets one reminder.
- Worker still silent: the Inbox gets a stalled notice naming the worker and what it last said,
  and asks him whether to wait, re-ask or drop it.
- Final answer: always returns to the Inbox, including from the Mac and after the old guess.
- A result the system could not deliver: Needs attention on the session that should have got it.

## How agents learn it and how they are held to it

Tejas, 2026-09-23: "how are you instructing them? How are we helping them learn those protocol?
… Are we just assuming that pro agents are gonna do a good job here?"

**One source.** The protocol as agents read it is `REQUEST_PROTOCOL` in
[`bot/src/request-protocol.ts`](../../bot/src/request-protocol.ts). It is rendered, not copied,
into every session's per-turn instructions and into `router-actions.sh sessions --help`. Each
delivered request and each reminder name the exact command for that request and point at it.
The project instructions and this document point at that file; the global instructions do not
restate it. Before this change the rule sat in five places with drifting wording (per-turn text
in three paragraphs, two request preambles, the command help).

**Enforced, not trusted.** Every agent obligation has a system check and a defined outcome:

| Obligation | Check | When it is not met |
| --- | --- | --- |
| Close every request you receive with a final | the owner sees the worker's turn end with the request open and nothing that will wake it | one reminder with the exact command; then a stalled notice to the requester (request stays open) |
| A work final says how it ended | the owner refuses a work final without `--work-disposition` | the command fails with the reason; the agent re-sends it; the request stays open meanwhile |
| Only the worker answers, only for that request | the owner checks the exact recipient session and request ID | refused |
| Say when you are waiting | *not required*: liveness is computed from facts (running, queued, waiting on a request it sent), so a worker that says nothing is still judged correctly | — |
| Stop after a cancel | the worker is told; its later reply is refused and recorded as refused | — |
| Requester: do not poll, do not re-ask | results arrive as service inputs exactly once; a retried ask with the same action ID is the same request | a re-ask with a new action ID is a new, separate request |
| Machines: hand the reply over | the origin acknowledges each exact event | the worker's machine resends every minute; recovery reads the peer's record at start |

**Measured before the change** (requests asked 2026-09-16 to the release, both machines, from
the ledger): 804 requests. 629 (78%) closed by the worker's own final reply command, 457 of them
work finals with a disposition. 72 (9%) were closed by the owner reading text or silence; in 36
of those the worker had already sent a partial, 31 of those turns ended with text that read like
an answer but no final command, and 8 ended by promising a later reply. 52 work finals carried no
disposition and closed as `undetermined`. 12 closed through a sibling's reply, 38 failed, 17 were
canceled, 34 are still open. Transcripts on both machines show 14 workers who tried to reply after
their request was already closed; 6 of those closes were the owner's guess, so 6 real answers were
refused on this machine, plus the one discarded across machines on September 23.

## Review and limits

GPT-6 Astra investigated the incident read-only (three defects: inference before the partial
check, late replies discarded, transport success taken as receipt). GPT-6 Sol reviewed this design
read-only and returned REVISE; its findings were resolved as follows.

- **Strict per-event acknowledgement.** A peer reply counts as forwarded only when the origin
  answers with that exact event ID and `recorded` or `duplicate`. Any other answer leaves it
  pending and resent every minute, so an origin that has not been updated yet is retried, not
  trusted.
- **Stalled as a dependency change.** A request that stalls no longer keeps its requester live,
  and the stalled notice is itself a return, which wakes the requester. Two workers waiting on
  each other are both idle and not running, so the 30-minute due-time notice reports each of them;
  there is no cycle detector beyond that.
- **Recovery retries.** Discarded-reply recovery for a peer repeats on the minute retry timer
  until every read from that peer succeeds in this process. A reply with files is fetched whole
  (`GET …/requests/:id/replies/:eventId`) before its event ID is recorded, on ordinary pulls and on
  recovery, so the later push can never be a files-less duplicate (Sol's second review). A peer
  not yet updated lacks that route: ordinary pulls then leave the reply to its push; historical
  recovery records the words and logs that the files were not recovered. Inferred closures older
  than 14 days are not scanned.
- **Needs attention is retried** until it is recorded; the log line is written once.
- **Kept as is: a running turn is not reported as stalled.** A run under a live owner is
  supervised by that owner (a dead process ends the turn in error, which fails the request).
  Reporting healthy long runs as stalls is what earlier made the notice untrustworthy.
- **Kept as is: sibling answers settle when the shared turn ends**, not when the reply is
  recorded. That delays, never loses, and is outside this change.
- **The Mac updates on demand.** Until its Concierge is updated, requests *to* the Mac stay open
  after a turn ends (this machine no longer guesses) but get no reminder, only the due-time
  notice; requests between Mac sessions keep the old behaviour. The update is run from the Mac.
- **An offline origin cannot tell anyone.** If the requester's own machine is off, nothing on it
  runs; replies wait on the worker's machine and are forwarded when it returns.

## Out of scope

Automatic retries of a worker's work, automatic cancellation of stalled requests, and any time
limit that closes a request. A stalled request stays open until someone with authority decides.
