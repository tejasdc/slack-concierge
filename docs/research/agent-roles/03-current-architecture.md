# How Tejas's agent system works today

Written for a non-code-reading engineer. Sources: slack-concierge's `AGENTS.md`,
`docs/architecture/SESSION-OWNER.md`, `docs/contracts/session-owner-v1.md`,
`docs/contracts/native-inbox.md`, `docs/plans/2026-09-23-request-reply-protocol.md`,
`docs/plans/2026-09-23-attention-that-ends.md`, `docs/architecture/PROVIDER-SESSIONS.md`,
`docs/runbooks/ROUTER-ACTIONS.md`, and slack-inbox's `AGENTS.md`. Slack itself is
deprecated as of 2026-09-15 (Tejas stopped using it); "Slack" below only appears
where the code still carries its history.

## The parts

**Concierge** is the backend that owns everything: one database ("the ledger") that
records every session, every message ever sent or received, every request one agent
makes of another, and every notice to Tejas. It is the single source of truth. It runs
the actual AI provider processes (Claude, Codex/GPT), queues their work one at a time
per session, and decides what counts as "done," "answered," or "needs Tejas." Nothing
else is allowed to keep its own separate queue or its own separate record of what
happened — that rule is enforced in code (there is one ledger, one FIFO per session,
one execution owner).

**Thinkering** (the app, shown at thnkr.ing) is the window Tejas actually looks at. It
authenticates him, shows him sessions, threads, and the Inbox, and lets him type,
reply, and tap buttons. It also hosts a few private capabilities Concierge calls into
(file/browser access, calendar, notes) but it does not own any session state itself —
it is a "consumer," not a second brain.

**The Inbox** is one specific, always-on session (a Claude Opus process with a very
large context window, running from the `slack-inbox` project folder) that Tejas treats
as his single point of contact. Every capture he sends — voice note, photo, typed
message, bug report — lands here first. The Inbox's job is *routing and conversation
management only*: read the capture, decide what he means, place it in the right
"topic" (a persistent subject/thread), and either answer it directly or dispatch it to
a worker session. It is explicitly told "routing is the job; doing the work is not" —
if he asks a factual question about his life (a plant, a book), that goes to whichever
project session owns that part of his life, not answered by the Inbox itself. This
routing discipline is instruction-only, not code-enforced.

**Worker sessions** are ordinary Claude Code or Codex sessions, one per project folder
(e.g. `thinkering`, `slack-concierge`, `life-logistics`, a per-device messaging agent
on the Mac). They do the actual work: write code, investigate, produce answers. They
have no special knowledge of "threads" or "topics" — those only exist in the Inbox.
A worker only knows the request it was handed and must reply to it through an explicit
command.

**Peers / the Mac** — a second Concierge instance can run on Tejas's Mac, each with its
own separate ledger, connected over Tailscale to the main box (remote-box). Requests
can cross this boundary (`sessions ask --peer`), and each side reports facts back to
the other; the *requester's* machine always decides how to interpret those facts.

## The objects Concierge tracks

- **Session** — one durable AI conversation (`concierge:<id>`), with a provider, a
  project, a title, and a full history. The Inbox is one session; each worker is
  another.
- **Input** — one accepted thing sent into a session: a human message, an agent
  request, or a system-generated result. Everything is an input; nothing is admitted
  without going through this record first.
- **Request / reply** — the formal hand-off between two sessions. A request is created
  with `sessions ask`, and can only be closed by an explicit reply command
  (`sessions reply` with `--partial` or a final `completed`/`failed`/`needs_decision`).
  This is enforced in code as of the September 23, 2026 "request reply protocol":
  the old behavior of inferring an answer from a worker's closing prose or silence
  was removed after it silently closed 72 real requests wrong in a week.
- **Threads, posts, topics** — only inside the Inbox. A *thread* is a chain of Inbox
  messages that all concern the same exchange (rooted at the capture, reply, or post
  that started it). A *post* (`sessions post --thread <id>`) is the Inbox deliberately
  answering a thread — it is the only way an answer appears in a thread; nothing is
  scraped from a turn's ordinary output. A *topic* is a longer-lived subject that owns
  one or more thread roots, with a title, summary, open requests, and open questions —
  Tejas now sees "Threads" grouped by topic, not by raw capture.
- **Questions / outcomes / attention** — a *question* is the only thing in the Inbox
  allowed to wait on Tejas (`decision`, blocking) or ask him to read something
  (`reading`, non-blocking). Every turn a worker or the Inbox runs must declare an
  *outcome* (`done`, `response`, `needs_you`, or `failed`) through a command,
  `sessions outcome`; only `needs_you`/`response` raise attention, and only a question
  record — never a turn marker by itself — is allowed to sit in front of Tejas
  unresolved. This is enforced in code (the September 23, 2026 "attention that ends"
  change): an undeclared or unfiled item is held, visibly, until something with
  authority (the router or Tejas) files or ends it — nothing expires on a timer.
- **Notices** — system-published events with no agent turn behind them (a broken
  integration, a failed deploy, keys rotated). The owner now automatically gives each
  one its own thread the moment it exists, because nothing else ever would.

## (a) A capture he sends

He records/types/photographs something (from phone, watch, Action Button, browser, or
Mac). Concierge's trusted local intake (`POST /sessions/v1/inbox`) accepts it, retains
the original bytes/text under a stable capture ID, and atomically queues it as a human
input into the one active Inbox session. This is a code-enforced boundary: nothing but
this trusted producer path can put a message into the Inbox as a "human" input, and the
capture's original wording/bytes are retained unchanged for the Inbox to read (a
generated summary is never a substitute).

## (b) The Inbox dispatching a worker

The Inbox agent wakes, reads the full capture, and (per its written instructions, not
code) decides intent: save a note, answer a question itself, ask ChatGPT, or route it
as work. Before doing anything else it must place the capture in a topic (create one or
attach it to an existing one). If it decides work is needed, it searches for the
session that already owns that surface (`sessions search`/`sessions context`) and either
continues that exact session or creates a new one in the right project with a specific
model. It then sends the work with `sessions ask <address> --thread <message-id> ...`.
The `--thread` is mandatory and code-enforced: the owner refuses an Inbox ask with no
thread, or one naming an unplaced or foreign message, so a dispatch can never lose track
of which conversation it belongs to.

## (c) The worker's reply returning

The worker session does its work and must close the request with an explicit reply
command (`sessions reply`, final, with a work disposition — `completed`, `failed`, or
`needs_decision`). This is code-enforced: a turn ending without that command does not
close the request; instead a Stop hook intercepts the agent as it tries to end its turn
and sends it back once with the exact command it owes. If it still doesn't reply, the
request stays open and the Inbox is told, once, that it's "stalled." When a real final
reply is recorded, the owner delivers it back to the Inbox as one `return:<eventId>`
input, threaded under the same root the original request came from. The Inbox agent
must then explicitly post that answer into the thread with `sessions post --thread` —
code now refuses to let the Inbox end its turn on a request/return thread without
posting first, and if it forgets, the owner itself relays the closing text into the
thread as a fallback so an answer can never simply vanish.

## (d) His follow-up in a thread — does it reach the worker directly?

**No. It cannot reach the worker session directly, ever, by design.** Threads exist
only inside the Inbox's own ledger-backed history — a worker session has no concept of
"this Inbox thread." When Tejas types a reply inside an Inbox thread, that reply is
recorded as a new human input to the *Inbox session itself* (carrying `replyToMessage`
pointing at the message he's answering). That wakes the Inbox agent, not the worker.
The Inbox agent then decides what to do: answer it itself with a post, or forward the
substance of his reply to the worker as a **new** request (`sessions ask ... --after-request
<original-id>`) if it's a change to the work. Only the Inbox can place a message into an
existing thread at all (`sessions thread`) — this is a hard rule in the wire contract:
"Only the Inbox accepts posts, because only its history is built from the ledger. Every
other session shows its provider transcript, which a post never enters." So every one of
his in-thread follow-ups is mediated by the Inbox agent's judgment; there is no code path
that lets his message steer directly into a worker's live run from a thread reply.

## (e) How he's notified

A turn's declared outcome drives it: `needs_you` (he must decide something) sends a
phone notification every time it's raised and shows on the thread as a blocking
question; `response` (something worth reading, nothing blocking) puts it in his "To
read" list without a push each time; `done` notifies him only if the turn is answering
his own message and doesn't mark `--quiet-because`. Declaring the wrong outcome, or not
declaring one and only leaving the legacy end-of-turn text marker, is possible (older
sessions still support the plain-text marker as a fallback), but the *counting and
surfacing* of what's outstanding — the Threads list, the Needs-you filter, the Questions
tab, the Inbox's own unread badge — is all computed by Concierge from the single
question/attention record, not from what any surface chooses to render. That
computation is code; which outcome an agent picks, and whether it writes a real
question with real context instead of an empty shell, is instruction/discipline, and the
Inbox's own written history is full of times it got that wrong (duplicated
notifications, misfiled questions, silent two-hour gaps) that later became explicit
code-level refusals (e.g., you cannot end `needs_you`/`response` with nothing readable
in the thread; a duplicate `needs_you` question is refused rather than re-notifying).

## Code-enforced vs. instruction-only, at a glance

**Enforced by code (Concierge, cannot be talked around by an agent):**
- One ledger, one FIFO per session, one execution owner — no second queue anywhere.
- A request closes only via `sessions reply`'s explicit final disposition, or Concierge's
  own fact of execution failure/cancel — never by reading a turn's prose or silence.
- The Stop hook (same script, both Claude and Codex) blocks an agent from ending a turn
  while it still owes a reply, once, inside that turn.
- Only the Inbox session can `post` into a thread; only the Inbox can place a capture
  into an existing thread; a post outside the Inbox's own ledger history is refused.
- An Inbox `sessions ask` must name a real, already-placed thread, or is refused.
- A turn opened by a worker's return/request cannot declare its outcome (`sessions
  outcome`) without having posted into that thread first.
- A `reading` question needs something concrete to read, or filing/declaring/closing it
  is refused (`NOTHING_TO_READ`).
- Questions/attention end only via one of a fixed set of explicit signals (answered,
  read, superseded, withdrawn, declined, deferred, expired-by-closure) — never a timer.
- Pushed git history can never be rewritten (multiple independent enforcement layers).

**Written in instructions only (an agent could, in principle, violate these; they rely
on the model reading and following its `AGENTS.md`/per-run instructions):**
- The Inbox's whole routing philosophy: which session "owns" a surface, when to create
  a fresh worker vs. resume one, which project a task belongs to, when to escalate to a
  stronger model, when a question is really a change request in disguise.
- "Routing is the job, doing the work is not" — the Inbox answering a personal question
  itself instead of routing it is a documented, repeated real mistake, not something
  code blocks.
- Writing a *good* question (full brief, why, answerable) vs. an empty shell — code only
  enforces that a question can't be marked "ready" without minimum fields, not that its
  content is actually useful.
- Choosing the right notification outcome (`response` vs `needs_you` vs `done`) for a
  given situation — code enforces the mechanics of each, not which one an agent should
  pick.
