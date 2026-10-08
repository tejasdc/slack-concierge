# 2026-10-08 — Ghost running turns held the system; nearly restarted Codex for the wrong reason

## What Tejas saw

Starting around 11:38 EDT (~1h after a scheduled Concierge restart at 10:51 EDT) nothing moved
for him: the Inbox agent appeared to be "running" for an hour and a half; incoming transcripts
were not being filed; his last Codex message in the "Why my system keeps getting slow: deep
retrospective" session was the "monitoring installed but rollout not finished" line, then
silence; service steering notices had no visible effect; a new Concierge update was shown as
"waiting." His framing: "It thinks the agents are working but the agents are not working."

## What was actually happening

Five turns were held `running` in the ledger with no process doing the work:

| Turn | Session | Model | Age at discovery |
|------|---------|-------|------------------|
| 5612 | 3172 (Inbox) | Claude Opus 1M | ~1h 05m |
| 5615 | 4543 (Repair agent) | Claude Opus 5.5 | ~1h |
| 5608 | 4361 (Lab capacity planner) | GPT-6 Luna | ~4h |
| 5562 | 4026 (Gerald's Adidas drop watch) | Claude Sonnet 5 | ~6h |
| 5579 | 3757 (Why my system keeps getting slow) | GPT-6 Astra | ~1h 40m (Codex itself observed completion at 11:27 EDT; the ledger never recorded it) |

Behind these five, 20 turns were queued (8 Inbox transcripts, 8 steer-ins to "Why my system
keeps getting slow", plus smaller queues on three others). None of them had `dispatch_hold` or
`dispatch_failure_class`; they were blocked solely by the per-session FIFO rule, which refuses
to dispatch a new turn while that session already has one running.

The current Concierge coordinator (instance `8bdfd2c3`, PID 3403068, started 10:51 EDT) had
emitted zero `execution_adopted`, zero `execution_host_attached`, zero `claude_code_turn_started`
events across its entire 1h 55m lifetime. The `executions` table showed zero rows under its
`coordinator_instance_id`. Turn 5579 had an executions row, but still pointed to the previous
coordinator (`c3eca5b2`), and `claimAdoptableExecutions` had not transferred ownership.

The deployment runner was correctly holding the next release open per `execution-survival.ts`,
which only releases the update hold once a kind of run has been proven alive-at-takeover and
then finished for this coordinator — and the ghosts could not be "proven alive" because they
had no process.

## Who introduced the gap

The "updates without waiting / execution hosts" feature chain merged Oct 7 evening into Oct 8
early morning:

- `4772d73` — Claude runs on the server live in their own execution host
- `2d2c53e` (Oct 7 17:21 EDT) — merge of execution hosts and Codex adoption
- `bbba9f2` (Oct 7 17:24 EDT) — "Updates without waiting: proof means a run survived alive"
- `764348a` (Oct 7) — compatibility checked between real releases
- `bef5931` (Oct 8 03:06 EDT) — Codex side: hooks follow the turn

The design wires two recovery paths and expects them to cover every case between them:

1. `claimAdoptableExecutions` (startup): adopts turns through the `executions` table JOIN.
2. `reconcileRecoverableTurns` (startup): catches orphans by filtering turns whose owner process
   is *not* alive.

The gap: a turn whose current owner **is** this living coordinator, but which has no `executions`
row (because dispatch stalled before `retainExecutionIntent`) falls through both. Before this
release, Claude ran in-process; any orphan always had a dead owner, so the second path alone was
sufficient. The release changed the invariant; neither path was extended to match.

## Why this is the first time it happened

Three conditions had to coincide:

1. The execution-host feature was live (it has been for less than 24 hours).
2. A dispatch inside the current coordinator stalled before writing an executions row (silent
   failure path — no error logs, no traceable failure class).
3. The stall happened while the current coordinator was still alive, so the dead-owner reconciliation
   could not catch it.

Before this release, condition (2) could still happen (dispatch could silently fail), but the
restart-driven dead-owner reconciliation would catch it on the very next restart. After this
release, the restart is designed to leave a stalled turn in place and expect its execution host
to carry it, which does not exist.

## Near-miss: nearly restarting the Codex app server for the wrong reason

I observed the Codex app-server at ~105% CPU and 4.4 GB RSS for ~6 hours and attributed the
Claude dispatch stall to it. Tejas pushed back: "How do we know the codex server is actually
causing the holdup here? I mean there's like plenty of CPU left or is it not?"

He was right. The machine has 12 cores; one core pinned is not a system block. The actual block
was the per-session FIFO on each of the five ghost sessions. The Codex daemon was in fact
responsive throughout — subscribing to new threads, observing lifecycle changes, importing
provider history. Its 100% CPU is a separate anomaly to investigate later.

Restarting the Codex daemon from an SSH shell would have made things worse per
`docs/runbooks/CODEX-APP-SERVER.md`: the daemon inherits the shell's 1024 file-descriptor
limit and exhausts it on observer subscriptions. The sanctioned path is explicit maintenance
through the credential-activation route, which closes provider admission, proves every Codex
turn idle, restarts once (so it inherits `concierge-bot.service`'s LimitNOFILE), probes
`model/list`, reconnects, and reopens admission.

**Lessons from the near-miss:**

- **One core at 100% is not proof of blocking on a many-core box.** Check load average, actual
  responsiveness of the suspected component, and whether the dispatch path even depends on it,
  before proposing a restart.
- **Correlation of a long-running CPU anomaly with a user-visible stall does not establish
  causation.** The actual stall must be traced to its exact mechanism (here: a FIFO on a ghost
  turn in each affected session), not inferred from "something is hot."
- **Runbooks exist for a reason.** `docs/runbooks/CODEX-APP-SERVER.md` is explicit that an
  SSH-shell restart will break the daemon. Read it before proposing an action against it.

## Recovery performed

A one-shot settlement SQL (equivalent to `interruptOrphanedTurn` for each ghost) marked the
five turns `interrupted`, cleared their steering message queues, and moved the five sessions
back to `idle`. The 20 queued turns began dispatching within seconds. The deployment runner
is now free to install the next release.

## The invariant fix (same change set)

`reconcileRecoverableTurns` (`bot/src/turn-recovery.ts`) now also catches turns that satisfy
all of:

- `turns.status = 'running'`
- `turns.owner_instance_id = <this coordinator>`
- no row in `executions` with matching `turn_id` and `dispatch_attempt`
- `started_at` older than `GHOST_TURN_INTERRUPT_AGE_MS` (default 120s)

For each such turn, it calls `interruptOrphanedTurn(turnId, thisInstanceId, reason)`, exactly
as it would for a dead-owner orphan. The sweep runs at startup (after `claimAdoptableExecutions`
and before the existing dead-owner pass) and on a watchdog cadence (every 60 s) throughout the
coordinator's lifetime.

This closes the gap without changing the FIFO rule, which is a separately-flagged design
question (see below).

## Open design question — tracked, not fixed here

Tejas asked: *"Why do you even have the per-session FIFO error? A session after a running turn
cannot dispatch another turn until it settles. That doesn't seem like the right thing. I mean,
how does steering work? If a session has to wait for its running turn, I don't understand.
Steering works today, right?"*

He's right that steering demonstrates work *can* reach a running turn. The current FIFO rule
treats a *new* turn as something that must wait for the running one to end — but if that session
is in a stuck or confused state (as here), queued work sits forever instead of either steering in
or starting a sibling. This is a real design question, not a bug introduced today. Tracked for a
later discussion.

## Follow-ups

- [ ] Investigate Codex app server at ~100% of one core for 6+ hours (independent anomaly;
      Concierge was unaffected but this is worth tracing).
- [ ] Trace the specific dispatch path that silently stalled without writing an executions row
      or logging a dispatch error. The invariant fix catches the symptom; the root cause of
      the silent stall is still unknown.
- [ ] Open discussion on per-session FIFO vs. steering coherence (above).

## Timeline (UTC)

- `14:51:24` — Concierge restarted into release `3c6f46ba` (coordinator `8bdfd2c3`).
- `14:57:25` → `15:01:26` — turns 5612 and 5615 inserted and marked `running` by the current
  coordinator; no executions rows ever appeared.
- `15:22:33` — new release committed and queued for deploy; deploy begins draining.
- `15:27:54` — Codex observed turn 5579 completed; ledger did not update.
- `15:38:26` — first 15-minute update-wait notices steered to the four Claude ghosts; nothing
  received them.
- `16:23:26` — 60-minute update-wait notices steered; same.
- ~`16:40` EDT — Tejas reported the app broken.
- `16:xx` — settlement SQL executed; queue began draining within seconds.
