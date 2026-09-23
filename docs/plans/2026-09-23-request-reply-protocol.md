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
| reply-by (FIPA ACL message parameter) | not used | **departure**: agents have no meaningful deadlines; instead the worker is held at the moment it tries to stop (the Stop hook) and the owner reports a request nothing will answer |

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

1. **At the moment the worker tries to end its turn, the Stop hook** (below) sends it back once
   with the exact command, inside the same turn, if it still owes a reply and is not waiting on a
   request of its own.
2. **Still stranded when the turn has ended → stalled notice to the requester.** A notice event returns to the requester:
   the worker, its last partial if any, and that nothing tracked will wake it. The request stays
   open; a late final still lands and returns. Nothing further happens automatically: the
   requester (for the Inbox, Tejas through it) decides to wait, ask again or cancel.

So "how long" is: as long as something real is keeping the worker busy or waiting; the moment
the worker tries to stop owing a reply, it is sent back once; if it ends the turn anyway, the
requester is told. Every wait
ends in a final answer, a failure, a cancel or a stalled notice.

Cases:

- **Worker tries to end its turn without a final reply** → the Stop hook sends it back once → final, or (turn ends anyway) stalled notice.
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
- Worker tries to end a turn without answering: nothing reaches him; the agent is sent back once with the command.
- Worker still silent: the Inbox gets a stalled notice naming the worker and what it last said,
  and asks him whether to wait, re-ask or drop it.
- Final answer: always returns to the Inbox, including from the Mac and after the old guess.
- A result the system could not deliver: Needs attention on the session that should have got it.

## How agents learn it and how they are held to it

Tejas, 2026-09-23: "how are you instructing them? How are we helping them learn those protocol?
… Are we just assuming that pro agents are gonna do a good job here?"

**Taught once, enforced where it applies.** Tejas, 2026-09-23: "is this the piece of text that is
basically passed at every single turn? … What if we add a hook? A completion hook. That sees if
the completion hook did the operation or not and reminds the agent." The agent-facing text is
now only the commands (`REQUEST_PROTOCOL` in [`bot/src/request-protocol.ts`](../../bot/src/request-protocol.ts),
530 characters, down from about 1,500). It sits in the session's per-run instructions, which
Claude receives as an addition to its system prompt once per run: they are not stored in the
conversation and do not accumulate across turns. `sessions --help` prints the same text;
requests and reminders point at it. The rules are enforced by the system at the moment they apply:

- **Every agent, Claude and Codex: the same Stop hook.** Tejas, 2026-09-23, on an earlier draft
  that left Codex on a weaker path: "Why are we creating a split brain system here? So my Codex
  agents are going to be dumb". Both providers run `Stop` hooks when the agent finishes, give the
  hook the provider's own conversation id (`session_id`) and `stop_hook_active`, and take
  `{"decision":"block","reason":…}` as "keep going with this reason"; Claude Code ends the turn
  after 8 consecutive blocks ([Claude Code hooks, Stop](https://code.claude.com/docs/en/hooks#stop);
  [Codex hooks, Stop](https://learn.chatgpt.com/docs/hooks)). One script,
  [`owed-reply-stop-hook.ts`](../../bot/scripts/owed-reply-stop-hook.ts), serves both: the owner
  finds the session whose turn is running on that conversation, and a conversation with no running
  Concierge turn owes nothing, so every other Claude or Codex use on the machine passes through.
  When the agent tries to stop while it holds a request it has not closed, and it is not waiting on
  a request of its own or on background work, the hook sends it back once with the exact command.
  When it stops again, `stop_hook_active` is the evidence the reminder reached it: the reminder is
  recorded for exactly the request IDs the hook printed, after it printed them, and the agent is let
  go. There is no second reminder turn; a request still stranded when the run ends is reported to
  its requester as stalled.
- **How each provider gets the hook.** Claude: Concierge passes it with `--settings` on every run.
  Codex runs a non-managed hook only after a person reviews and trusts its exact definition, and
  re-review is required whenever it changes; managed hooks from `requirements.toml` are "trusted by
  policy" and cannot be disabled by the user ([Codex hooks, Review and trust hooks; Managed hooks
  from requirements.toml](https://learn.chatgpt.com/docs/hooks)). The system requirements file is
  `/etc/codex/requirements.toml` on Linux and macOS ([managed configuration, Locations and
  precedence](https://learn.chatgpt.com/codex/enterprise/managed-configuration)), and Codex does
  not distribute managed scripts. So [`install-codex-stop-hook.sh`](../../scripts/install-codex-stop-hook.sh)
  writes that file and a launcher under `/etc/codex/hooks` that runs the same script from the
  Concierge checkout. On the box remote-box's `deploy.sh` runs it as root; on the Mac,
  `scripts/install-mac.sh` run once from a terminal asks for the admin password for it. The launcher
  points at the checkout, so later hook changes need no new approval.
- **The stalled notice** covers what no hook can see: a process that died mid-turn, a session on a
  machine not yet updated, an agent that ended again after being sent back.

**What each input still carries, and why.** The per-input identity header (~415 characters)
stays: it states who authored that input and under which human task, and several inputs of
different authors can join one run. A request's own first line names its exact reply command
(~380 characters). Everything standing moved out of the conversation: the Inbox's 3,802-character
routing preamble was prefixed to every Inbox input, and a 540-character attention rule was about to
be added to every placed one; both are now in the Inbox's per-run instructions.

**Measured cost** (characters; ~4 characters per token), from the current Inbox conversation
(165 MB transcript). Before: every Inbox input began with the 3,802-character routing preamble;
the transcript holds 1,019 such inputs, about 3.9 million characters (~970,000 tokens) of the same
text, of which compaction keeps only what is still in the live window. The 540-character attention
rule had not reached any conversation yet (it belongs to a release still waiting to go out) and was
moved before it did; it would have been added to every input already placed in a topic. After:
standing text per Inbox input is zero; each input keeps its ~415-character identity header, and the
Inbox's per-run instructions grow by 4,342 characters, sent once per run as instructions and not
stored in the conversation. Workers never had a per-input preamble: their per-run instructions
measured 13,234–13,385 characters (~3,300 tokens) per run, and are ~1,000 characters shorter
after. Per run is still a send: Claude receives the per-run instructions with each request of that
run, as system text (prompt-cached), not as a growing conversation. In Codex the per-run
instructions ride in each turn's context record, not as conversation messages; no duplicated copies
were found among a Codex session's conversation items.

**Enforced, not trusted.** Every agent obligation has a system check and a defined outcome:

| Obligation | Check | When it is not met |
| --- | --- | --- |
| Close every request you receive with a final | the Stop hook (Claude and Codex), when the agent tries to end its turn; the owner, when the turn has ended with nothing that will wake the worker | sent back once inside the turn with the exact command; then a stalled notice to the requester (request stays open) |
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
  recovery leaves it unrecorded and retries until the peer can hand over the whole reply. Inferred closures older
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
