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
September 16 and 23, 2026 that closed 63 requests, 34 of them after the worker had said with
`--partial` that it was not finished. On September 23 it closed an Inbox request to the Mac on
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
  until every read from that peer succeeds in this process. Recovery reads the peer's reply
  record, which carries text and disposition but not files; a recovered historical reply arrives
  without its attachments. Inferred closures older than 14 days are not scanned.
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
