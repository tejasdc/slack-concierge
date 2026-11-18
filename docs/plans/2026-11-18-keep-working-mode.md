# Keep-working mode: an orchestrator with queued work never sits idle

## Problem (his words)

The Essos orchestrator (session:WzIsMTAxMTMsMV0, project essos-imessage-agent) was told to keep
building and "never sit idly". Twice it ended a turn with nothing in flight while its backlog
(`docs/backlog.md` in that project) still had items, because nothing wakes a session except an
incoming message, a returning request or a watch. Tejas, 2026-11-18: "how else to tell you to
never sit idly? are you an idiot to do this without any systems". He wants a system, not an
instruction, applying to every orchestrator.

## Invariant

**A session in keep-working mode always has a wake condition.** A wake condition is exactly what
`waitingOnDependency`/`workerWillWake` in `bot/src/request-liveness.ts` already treat as one: a
running or queued turn (including a queued scheduled/snoozed continuation), a sent request that
returns to it (`waitingOnLiveRequest`, including untaken answers), or a live watch. The session-level
form is `sessionWillWake`, built from the same pieces; there is no second definition of "will wake".
The mode ends only when the agent turns it off with a reason (backlog empty, or everything left
waits on Tejas), or Tejas stops / pauses / archives the session.

Why a mode flag rather than Concierge storing backlog items: the queue already has one home (the
orchestrator's project file, which Tejas reorders in his thread). A Concierge copy of the items
would be a second home that drifts. Concierge only needs to know "this session must not go idle
until it says it is done", which works with any backlog format and any project.

## Parts

1. **Mode state, per session.** `sessions keep-working on --reason "<what queue and why>"` and
   `sessions keep-working off --reason "<why it may now rest>"`, with source flags and `--action-id`,
   acting on the calling session (an optional session address lets another agent, e.g. the Inbox
   router, set it on an orchestrator). Stored in `session_keep_working_events` (append-only: reason,
   time, source input/run, actor); current state is the latest event. Idempotent by action id. The
   session view exposes `keepWorking: { since, reason } | null` and `keepWorkingLastOff`
   (`{ at, reason, by: 'owner' | 'agent' }`).
2. **End-of-turn check (Stop hook).** `/session-communication/owed` adds `keepWorking: { reason }`
   when the calling run's session is in the mode and, ignoring the current run, nothing will wake
   it. `bot/scripts/owed-reply-stop-hook.ts` blocks once (same `stop_hook_active` / background-task
   rules as owed replies) with the exact off command. Claude and Codex share this hook.
3. **Owner backstop wake.** When a turn of a keep-working session ends done or failed (not a human
   Stop; not while paused, suspended or archived) and nothing will wake the session, the owner
   queues one service continuation (`keep-working-wake:<session>:<turn>`). If the turn that ended
   was itself such a wake and still left nothing, the owner turns the mode off with the reason
   "Woke once with nothing dispatched; the queue looks blocked" (actor: owner) and queues nothing.
   The check runs on the owner that ran the turn (`observeTurnFacts` terminal event), so a Mac session
   is handled by the Mac's own owner.
4. **Teaching.** One line in the request protocol and `sessions --help`; a bullet in
   `docs/architecture/SESSION-OWNER.md`; the command in `docs/runbooks/ROUTER-ACTIONS.md`.

## Acceptance

`bot/scripts/keep-working-fixture.ts` (part of the build chain) shows: the predicate is idle for a
keep-working session with only its own run and not idle with a running or queued turn or a live
watch; the owner's Stop-hook answer carries the reminder only for a session in the mode with nothing
in flight (and not once a returning request exists); one idle ending queues exactly one wake; a
second idle ending turns the mode off with the owner as actor and queues nothing; a human Stop and a
mode that is off queue nothing; the view shows the mode and the owner's off reason.
