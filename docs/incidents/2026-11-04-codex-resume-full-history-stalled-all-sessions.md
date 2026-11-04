---
failure: Every Codex session's turn failed with "thread/resume timed out" for six minutes because one session's resume asked the shared App Server for a 218 MB conversation's whole history.
date: 2026-11-04
fix_commits: [69eb074c]
cause_status: best-explanation
---

# Codex sessions stopped starting turns from 13:54 to 14:00 ET

## What was seen

From 18:54 to 19:00 UTC, 19 Codex sessions logged `provider_turn_retry_queued` with
"Codex app-server thread/resume timed out after 30000ms" (22 at 18:54, 14 at 18:57).
Sessions 6967 (turn 21050) and 7422 (turn 21063) used all five attempts and were refused.
The shared App Server (pid 182152) stayed up and kept streaming running turns. It resumed
threads again from 18:56:34, and by 19:00:16 the waiting sessions had resubscribed.

## Cause

Best explanation; the App Server's request-level trace for the window was already pruned.

- Session 6967's thread `01a14877-af0e-7022-8b45-b7bbf2817776` has a 218 MB rollout, the
  largest on the host. Its idle copy had been released (the 2026-11-03 memory fix), so turn
  21050 had to load it cold. That resume began at 18:54:09 on Concierge's App Server
  connection (connection 860).
- Turn-path resumes in `bot/src/codex.ts` sent `thread/resume` without `excludeTurns`. The App
  Server therefore built and sent the whole turn history, although the turn only reads the
  thread id, model and permission policy from the answer.
- On connection 860, no resume answered between 18:53:52 and 18:56:34. After the thread was
  loaded, the next resumes of it still waited about 40 s each (request 282 was sent by
  18:58:41 and composed at 18:59:23). They went past the 30 s limit, and every other session's
  resume queued behind them.
- The host was under memory and disk pressure: it had been swapping since 16:33, and agent work
  read about 80 GB between 18:46 and 18:53. That slowed the cold load, but it does not explain
  the stall by itself, because disk reads were back to about 1 GB/min at 18:54.

## Fix

Turn-path resumes (fresh dispatch, legacy per-turn process and reconciliation) now send
`excludeTurns: true`. Reconciliation already reads history separately through `thread/read`.
The observers already excluded turns.

## Second fix (same day)

The first fix was not enough. The 19:13 release restart closed Concierge's App Server connection,
and the App Server unloaded threads with no listener (6967's at 19:14:08). The next resumes of
6967 and of sessions 8434, 8483 and 8503 had to cold-load again on a host with load average 90 and
30 GB of swap in use, and they timed out at 30 s. 6967 was refused on its first attempt because
its five-attempt thread budget was already spent. Codex 0.162 still loads the whole rollout for a
cold resume even with `excludeTurns`. It queues resumes per thread, across connections
(confirmed from its source by a GPT-6 Sol review). Once loaded, 6967 resumed in 82 ms.

What actually lost the work was Concierge's. At 30 s the client dropped its interest in the resume
while the App Server kept loading. The retry sent another resume, and the fifth timeout refused
the turn. Now the shared turn path waits for its resume answer for as long as the connection
lives. Stop or a disconnect ends the wait, and a `codex_resume_waiting` warning is logged every
30 s while it waits. An unanswered resume therefore never spends the retry budget or refuses a
turn.

## Acceptance scenario

- **Seed:** a Codex session whose thread has a very large history and is not loaded in the App Server.
- **Action:** a new turn is dispatched to it while other Codex sessions start turns.
- **Expected:** the turn's `thread/resume` asks for `excludeTurns: true` and waits for its answer with no deadline, Stop still ends the wait, and the turn is never refused for a slow resume.
- **Replayable offline:** partly (the request parameters are checked in `bot/tests/codex.test.ts`; the load-time effect needs a live App Server).
