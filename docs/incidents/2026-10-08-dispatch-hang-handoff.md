# 2026-10-08 — Dispatch is silently broken. Handoff report.

## Receiving investigation: confirmed cause (19:20 UTC)

The claim did not reach dispatch because it returned null after committing its update.
The production `presentation_change_turns_update` trigger inserts two journal records.
Bun 1.4.2 includes those in `.run().changes`, yielding 3 for one changed turn. At
`claimNextQueuedTurn`, `claimed.changes !== 1` therefore returns null inside the transaction;
the transaction commits, and the queue breaks before any dispatch trace. No exception occurs.
An isolated in-memory reproduction with the installed Bun confirmed the inflated count;
production schema inspection confirmed the trigger. This explains the entire missing-log
sequence without a second claimant, stale bundle, or Codex daemon involvement.

The repair adds a shared ledger write-result adapter using SQLite `changes()`, which excludes
trigger and foreign-key side effects. The presentation journal is preserved. Both ordinary
ledger callers and the standalone project-mapping writer use the adapter. Live installation
and recovery evidence will be recorded below when observed. Earlier hypotheses below remain
as the original handoff, not current conclusions.

References: https://www.sqlite.org/c3ref/changes.html and
https://bun.com/reference/bun/sqlite/Changes.

This is a handoff report. The agent working the issue (Claude Opus 4.7, 1M
context) is handing off to the next engineer or agent because it could not
identify the root cause after extensive investigation and is unwilling to make
destructive changes without more context.

## One-line summary

The queue is successfully claiming turns from the ledger (`status` transitions
`queued → running`, `dispatch_attempt+=1`, `owner_instance_id` set to current
coordinator), but **no provider process is ever launched** afterwards. Every
diagnostic log placed in the dispatch path up to and including the entry of
`SessionExecutionHost.run` fails to fire, with no error logged. Turns sit in
`running` with no execution host behind them until a 120 s watchdog
(deployed as part of this incident, `sweepGhostRunningTurns` in
`bot/src/turn-recovery.ts`) interrupts them. They re-queue, the queue claims
again, same silent hang. Infinite loop. Dispatch has been broken for
roughly five hours as of this writeup.

## State before (working)

- Last successful dispatch:
  `12:21 UTC` (`08:21 EDT`), executions row `5610`, coordinator
  `c3eca5b2` (Linux process `2976843`). After that, no `claude_code_turn_started`
  and no `execution_host_attached` events have appeared from any Concierge
  coordinator on the server.
- Before 08:21 EDT the system was dispatching Claude and Codex turns normally.
  `provider_history_imported`, `execution_host_attached`, and
  `claude_code_turn_started` all fired at expected cadence.
- The "updates without waiting / execution hosts" feature chain had been
  merged on Oct 7 17:21 EDT (merge commit `2d2c53e`) and refined through
  Oct 8 early morning (`bef5931` at 03:06 EDT, etc.). Dispatch worked for
  ~6 hours after `bef5931` landed, then stopped at 08:21 EDT.

## State now (broken)

- Service: active, `concierge-bot.service` main pid at writeup is
  `3757379`, uptime ~30 min. Deployed release `0dd44d0163fd0af27188452b9c0eb24cc5583c12`
  = `releases/27dc5d0b13417d84b72f9df1e635c849c143fe2c664abec8180ac17b3832c213`.
- Queue state at writeup: 2 queued (`turn.id = 5631` in session 4026 "Gerald's Adidas drop
  watch", `turn.id = 5638` in session 4361 "Lab capacity planner"). 2 "running"
  that are ghosts (5641 Repair agent, 5642 Inbox from a debug probe). ~30
  interrupted. Also 4 very old queued turns in archived session 2870
  (blocked by `EARLIER_TURN_BLOCKS_SQL` + archived session, these can be
  ignored).
- Provider processes on the host: Codex app-server (PID 2870125,
  started 06:47 EDT, has been at ~100% of one core and ~4.4 GB RSS for ~7
  hours — anomalous but not the dispatch block, see note below) and its bridge/
  code-mode-host. **Zero `concierge-exec-*` systemd units.** No Claude child
  processes.
- Env overrides on the service (drop-in at
  `/etc/systemd/system/concierge-bot.service.d/execution-hosts-off.conf`):
  `CONCIERGE_EXECUTION_HOSTS=0`. **(Note: a human may want to remove this —
  I set it as part of the investigation and never saw it change anything.)**
  `CONCIERGE_SLACK_ENABLED` is **unset** (default Slack-enabled runtime);
  I briefly set it to 0 to try the native-only runtime and reverted.
- `deployment_drain` table in `state.db`: empty.
- Watchdog is working: `ghost_running_turn_interrupted` and
  `ghost_running_turns_swept` events fire every ~2 min, keeping the ledger
  from accumulating indefinite ghosts.

## The specific anomaly

In `bot/src/session-turn-queue.ts` the queue coordinator's `wake()` loop:

```ts
const claim = this.claimOrNull();      // succeeds: turn.status becomes 'running'
if (!claim) break;
if (this.activeTurnIds.has(claim.turn_id)) { ... onError ... continue; }
this.activeTurnIds.add(claim.turn_id);
console.log(JSON.stringify({... event:"queue_dispatch_trace" ... step:"before_run" ...}));  // never fires
let execution;
try {
  execution = this.options.run(claim);
  console.log(JSON.stringify({... step:"after_run_returned" ...}));                          // never fires
} catch (error) {
  console.log(JSON.stringify({... step:"run_threw" ...}));                                   // never fires
  execution = Promise.reject(error);
}
```

The two `console.log` calls above and the `run_threw` catch log are **in the
deployed bundle** (verified at `/var/lib/slack-concierge-deployment/current/bot/src/index.js:129573-129580`),
but **none of them fire in the running process**, even though:

- The turn transitions `queued → running` (claim call succeeds, obviously
  reached from somewhere).
- `dispatch_attempt` increments by 1 (confirms the UPDATE inside
  `claimNextQueuedTurn` ran).
- `owner_instance_id` is set to the current coordinator's UUID.
- My other `log()` calls in the same process (the watchdog's
  `ghost_running_turn_interrupted`) do fire reliably — logging infrastructure
  is NOT broken.
- `strace -p <main-pid> -e write,writev,sendmsg -f` for 20 seconds while
  a fresh capture was flowing through dispatch showed exactly zero writes
  containing `dispatch_trace`, `queue_dispatch_trace`, or `run_entry`.
- GPT-6 Astra was consulted twice and confirmed by grep that the only
  callers of `claimNextQueuedTurn` and `claimQueuedTurnWithSavedWork` are
  the two queue coordinators (`bot/src/session-runtime.ts:91` and
  `bot/src/index.ts:2475`). Tests also call them but tests cannot open
  the production DB — the test guard refuses at
  `bot/src/state-database.ts:17-18,43-53`.
- `settleClaimedTurnSetupFailure` / `onError` do not fire either, so no
  silent exception path either.

**I cannot explain how a turn's status becomes `running` through
`claimNextQueuedTurn` without the queue coordinator's `wake()` loop being
the one that called it, since the loop would then unconditionally hit the
`console.log` immediately after.** This is the single most important
puzzle piece to solve. One of these must be true:

1. Something is calling `claimNextQueuedTurn` or executing the equivalent
   SQL UPDATE outside of the two code paths grep showed.
2. The queue coordinator *is* reaching the log, but the log is being
   suppressed before it reaches journald somehow (my log *does* reach
   journald from the watchdog, so this is unlikely).
3. The bundler produced a stale or wrong version of `session-turn-queue.ts`
   that doesn't contain my `console.log` even though a text grep of
   `index.js` shows the strings are present. (Worth verifying — maybe
   two class definitions of SessionTurnQueueCoordinator in the bundle?)

## Timeline

- `~08:21 EDT` — dispatch stops working on the previous coordinator
  (`c3eca5b2`, pid `2976843`). No restart; just stops dispatching. The last
  successful execution host launch is turn `5610`.
- `10:51:24 EDT` — Concierge restart into release `3c6f46ba` (commit
  `77c4881`). New coordinator `8bdfd2c3`. Over the next ~2 h, every claimed
  turn becomes a ghost. Zero `claude_code_turn_started`.
- `~16:40 EDT` — Tejas reports "the whole app is completely broken again."
- `16:xx EDT` — Agent (Claude Opus 4.7, 1M) investigates. Initial wrong
  diagnosis: ghost turns were old orphans from pre-restart state. Settled 5
  ghosts via SQL (equivalent of `interruptOrphanedTurn`). Appeared to work,
  queue drained in SQL counts, but every claim became a new ghost.
- `16:xx EDT` — Pushed `e1e67f2` ("Catch running turns held by this
  coordinator with no execution record") — adds
  `listGhostRunningTurnsForOwner` in `state.ts`, `sweepGhostRunningTurns`
  in `turn-recovery.ts`, and a 60 s watchdog in `index.ts`. Deploy proceeded
  only after settling ghosts (deploy drain was held by them). The watchdog
  installed and started working.
- `17:38 EDT` — Pushed `365efcb` ("Trace the dispatch pipeline so we can
  see where it hangs") — added `log("info","dispatch_trace",...)` at
  entry of `SessionExecutionHost.run`, before `recordSessionEvent`, before
  `registry.run`, inside the `registry.run` callback, at `runModel` entry,
  and at `executeAgentTurn` entry. **None of these logs fired after deploy.**
- `17:40 EDT` — Added drop-in `CONCIERGE_EXECUTION_HOSTS=0` + restart to
  force old-style direct-child dispatch (which was the pre-execution-host
  path). Still no logs; dispatch still broken.
- `17:56 EDT` — Added drop-in `CONCIERGE_SLACK_ENABLED=0` + restart to
  force native-only session-runtime. Still no logs; still broken.
- `18:00 EDT` — Reverted both drop-ins back to default Slack-enabled.
- `18:08 EDT` — Attempted `git revert 2d2c53e -m 1` to undo the merge of
  the "updates without waiting / execution hosts" feature chain. Conflicts
  across many files (`bot/src/executions.ts` deleted vs modified,
  `bot/src/session-execution-host.ts` content conflicts, `bot/src/index.ts`
  content conflicts, etc.). Also tried reverting individual commits in
  reverse chronological order; conflict at `4fde0de`. Aborted both attempts.
- `18:15 EDT` — Pushed `0dd44d0` ("Trace exact queue→dispatch boundary with
  console.log") — adds `console.log(JSON.stringify(...))` **inside the
  queue coordinator itself** at `bot/src/session-turn-queue.ts:48-55`,
  before and after `this.options.run(claim)`, and in the catch. These logs
  **also do not fire.** Verified via `strace -p <main-pid> -e write`.
- `18:30 EDT` — Fresh debug capture (`external debug-queue capture`) to
  session 3172 (Inbox). The capture created turn `5642` and that turn is
  "running" one minute later with `dispatch_attempt=1`, `owner_instance_id`
  set to current coordinator — but **zero `queue_dispatch_trace` logs**
  for it. Reproducible.

## What was tried, in detail

### Operational actions

- Settled 5 ghost turns (5562, 5579, 5608, 5612, 5615) via raw SQL
  mirroring `interruptOrphanedTurn`, in two passes. First pass was before
  realizing new claims also hang. Second pass settled three more ghosts
  (5613, 5614, 5617) that the queue produced after the first pass.
- Restarted `concierge-bot` via `systemctl restart concierge-bot` twice.
- Set `CONCIERGE_EXECUTION_HOSTS=0` via systemd drop-in. Did not fix
  dispatch. Still in effect at writeup.
- Set `CONCIERGE_SLACK_ENABLED=0` to switch to the native-only runtime.
  Did not fix. Reverted.
- Started and later stopped a one-shot shell loop
  (`while true; do sqlite3 UPDATE … ; sleep 2; done`) that settled ghosts
  continuously, so the deploy runner could catch an idle moment and
  install my push. The deploy did install after that.
- Did **not** restart the Codex app-server. Runbook
  `docs/runbooks/CODEX-APP-SERVER.md` makes clear a shell-initiated
  restart would exhaust its 1024 fd limit on observer subscriptions. The
  daemon has been at ~100% CPU on one core and ~4.4 GB RSS for ~7 hours.
  **This is a separate anomaly that was NOT acted on.** Codex itself was
  responsive to subscriptions and history imports throughout the
  investigation. Do not treat it as the primary cause without new
  evidence.

### Diagnostic actions

- Deployed `365efcb` (6 `dispatch_trace` log points inside the dispatch
  path).
- Deployed `0dd44d0` (3 `queue_dispatch_trace` `console.log` calls at the
  queue→dispatch seam, bypassing `log()` wrapper).
- Verified the deployed `bot/src/index.js` bundle contains all 9 trace
  strings via `grep`.
- `strace -p <main-pid> -e write,writev,sendmsg -f -s 500` for 20 s during
  a fresh dispatch. Zero stdout writes containing any trace token.
- Verified `bun:sqlite` is in WAL mode (`PRAGMA journal_mode = WAL`),
  `busy_timeout` = 5000 ms. GPT-6 Astra's first consultation flagged
  `bot/scripts/migrate-deployment-repair.ts:58-63` as holding
  `BEGIN IMMEDIATE` across awaits (confirmed), but that script is not
  running right now and the external SQL-lock errors I was seeing came
  from my own aggressive sweeper competing with Concierge, not a hung
  transaction.
- Checked `deployment_drain` table — empty (no update draining in
  progress).
- Checked `process_instances` for stale owners — only the current
  coordinator is "alive."
- Checked `activeTurnDispatch.activeSessions` via owner API — empty.
- Checked `/tmp/concierge-turn-*-attachments-*` — none for any ghost
  turn, meaning `createTurnAttachmentRoot` was never called for them,
  meaning `executeAgentTurn` was never entered.
- Checked `provider_admission_intended_at` on every ghost — all NULL,
  meaning dispatch never reached `markTurnProviderAdmissionIntended` at
  `bot/src/turn-execution.ts:538`.
- Checked `executions` table for ghost rows — none for any ghost. One
  Codex-daemon row for an older turn (`5579`) still points at a dead
  coordinator (`c3eca5b2`), never adopted by the current one — this is
  a known gap in `claimAdoptableExecutions` for Codex rows whose
  coordinator died (deserves a separate fix but is NOT the primary
  dispatch bug).

### Code paths investigated

- `claimNextQueuedTurn` in `bot/src/state.ts:5108` — only caller in
  production is `claimQueuedTurnWithSavedWork` in `bot/src/saved-work.ts:358`,
  only called from the two queue coordinators. GPT-6 Astra confirmed.
- `SessionExecutionHost.run` in `bot/src/session-execution-host.ts:566`
  — my log is at line 567 (`run_entry`). Never fires.
- `runPersistedQueuedTurn` in `bot/src/index.ts:2454` — calls
  `sessionExecutionHost.run(claim)` for `turn_kind === "native"`.
  All ghost turns are native. The call site is intact in the bundle at
  `index.js:140810`.
- Session-runtime queue in `bot/src/session-runtime.ts:91-110` — calls
  `await host.run(claim)` on the same `SessionExecutionHost` instance.
  My log would fire here too. Doesn't.
- The queue coordinator's `wake()` in `bot/src/session-turn-queue.ts:28-66`
  — my `console.log` is at line 49 (`before_run`), between
  `activeTurnIds.add` and `execution = this.options.run(claim)`. Never
  fires.
- `currentClaimSurvivability` in `state.ts:5088` — reads
  `deployment_drain`. Empty table → returns null → no survivability
  filter applied → claim proceeds.
- `EARLIER_TURN_BLOCKS_SQL` at `state.ts:930` — queued turns in
  non-archived sessions should pass. Sessions 4026 and 4361 are `idle`.

### GPT-6 Astra consultations

Two `codex review -c 'model="gpt-6-astra"' -c 'reasoning_effort="high"'`
consultations. Neither could identify the mechanism by which a turn gets
`status=running` without `SessionExecutionHost.run` being called.
Second consultation suggested instrumenting right after `claimOrNull`,
which was done in `0dd44d0` and did not fire.

## Current hypotheses, ranked

1. **The bundler produced a wrong-version compile of some file.** The
   `bot/src/index.js` bundle has all the right strings at the right line
   numbers, but maybe there are two SessionExecutionHost class
   definitions or two SessionTurnQueueCoordinator class definitions in
   the bundle (one from a prior build, one from current), and the queue
   coordinator at startup wires itself to the old class. Low prior
   because `grep` only finds one of each, but worth confirming by
   diffing the AST.

2. **Some code path we missed is calling the equivalent SQL UPDATE
   directly, outside of `claimNextQueuedTurn`.** Grep for literal
   `UPDATE turns SET status='running'` found other call sites in
   `state.ts` and `deployment-state.ts` — the one in `acquireSessionTurn`
   at `state.ts:4966` is for Slack-user turns (not native). The one in
   `deployment-state.ts` is for `deployment_verification` turns (not
   native). Neither should match native Thinkering captures. **But the
   bug is likely something in this family — a code path that transitions
   status without calling the dispatch function.** Deserves a careful
   second pass of this grep plus looking at dynamic SQL construction
   (e.g. a shared helper that runs an UPDATE based on parameters).

3. **The queue coordinator's `wake()` is never called in the current
   runtime.** `startSessionTurnQueue` at `index.ts:2473` calls
   `sessionTurnQueue.wake()` once at startup. If that first `wake()`
   returned without claiming (because of `shouldStop()` returning true,
   or the loop breaking from `claimOrNull()` returning null at that
   instant), subsequent wake triggers (`executionChanged`,
   `stuck_work_woken`, etc.) would need to re-wake. If somehow nothing
   wakes the queue after that, no claim happens *from the queue*. But
   claims ARE happening (turns transition to running), so something
   outside the queue is doing it. Loop back to hypothesis #2.

4. **The Codex app-server's hot-loop CPU is somehow coupled to dispatch
   via a shared hook or module.** We ruled this out earlier because
   `CONCIERGE_EXECUTION_HOSTS=0` (which bypasses the hook-pin filing
   added in `bef5931`) didn't fix dispatch. But I don't fully trust
   that ruling-out; worth re-checking whether the direct-child dispatch
   path in `session-execution-host.ts:707-708` still touches the Codex
   daemon in some way.

5. **Something in the Oct 7-8 feature chain mutated the DB schema (added
   `deployment_wakes` or `deployment_drain` or similar) in a way that a
   trigger or constraint silently prevents the full dispatch flow.** I
   didn't audit all the schema migrations the feature chain introduced.
   Deserves a look.

## My pushed commits

Three commits are in `origin/main` from this session:

- `e1e67f2` **Catch running turns held by this coordinator with no execution
  record** — adds `listGhostRunningTurnsForOwner`, `sweepGhostRunningTurns`,
  120 s watchdog, 60 s cadence. **Working.** Keep.
- `365efcb` **Trace the dispatch pipeline so we can see where it hangs** —
  trace logs at 6 points in the dispatch path. **Do not fire.** Can be
  deleted/reverted once dispatch works again.
- `0dd44d0` **Trace exact queue→dispatch boundary with console.log** —
  `console.log` calls inside `SessionTurnQueueCoordinator.wake()` before
  and after `this.options.run(claim)`. **Do not fire.** Can be deleted/
  reverted once dispatch works again.

## Recommended next steps for the receiving agent

1. **First, read the entire feature chain's merge commit `2d2c53e` and
   the follow-up commits `bbba9f2`, `764348a`, `876f86f`, `fd8ceeb`,
   `bef5931`, `2080de6`, `4fde0de`.** Make sure you understand the
   execution-host architecture and the "updates without waiting"
   invariant.

2. **Confirm the deployed bundle actually contains my console.log in a
   path that's reachable.** Not just "`grep` finds the string" — but
   something like adding a `throw new Error("CANARY")` at that exact
   line, redeploying, and verifying the service either crashes or you
   see the throw propagate. If it doesn't, hypothesis #1 is confirmed
   (dead code or stale compile).

3. **Grep for every direct `UPDATE turns SET status='running'` in the
   compiled bundle `index.js`** (not just the source) — specifically
   look for ones outside `claimNextQueuedTurn` and `acquireSessionTurn`.
   The ghost production has to be routed through one of them.

4. **Check for recently-added background workers or periodic jobs that
   touch turns.** The feature chain added
   `claimAdoptableExecutions`, `recoverDeploymentWakeClaims`,
   `watchHeldExecution`, and other adoption/retry code. One of these
   may be marking turns running without going through dispatch.

5. **If none of the above pins it, do a clean rollback.** The feature
   chain revert needs file-by-file surgical restoration — too many
   interlocking commits for a plain `git revert`. Approach: identify
   all files the feature chain introduced or heavily modified, and
   `git checkout fcbd95b -- <file>` for each pre-existing file, plus
   `git rm` for each new file. Then rebuild and deploy. **This is
   destructive** — you'll lose any unrelated improvements to those
   files from the past ~24 hours. Baseline commit `fcbd95b`
   ("Agents' Concierge calls wait out a restart and resend only what
   is deduplicated") is the last commit before `4772d73` which started
   the feature chain.

6. **While you work, the watchdog from `e1e67f2` keeps ghosts from
   accumulating indefinitely.** Current cost: ~2 min of "stuck" state
   per ghost. Tolerable.

## Environment at writeup

- Service: `concierge-bot.service`, main pid 3757379, up ~30 min
- Release: `0dd44d0163fd0af27188452b9c0eb24cc5583c12`
- Drop-in override still present: `/etc/systemd/system/concierge-bot.service.d/execution-hosts-off.conf` sets `CONCIERGE_EXECUTION_HOSTS=0`. Consider removing.
- Watchdog armed: 60 s cadence, 120 s age threshold.
- No `deployment_drain` row.
- 2 queued native turns waiting; 4 archived-session queued turns waiting (ignore).
- Codex app-server at 100% CPU on one core, 4.4 GB RSS — unresolved anomaly, NOT acted on.

Good luck.
