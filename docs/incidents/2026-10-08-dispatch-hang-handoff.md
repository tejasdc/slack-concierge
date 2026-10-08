# 2026-10-08 — Dispatch is silently broken. Handoff report.

## Receiving investigation: confirmed cause

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

## Recovery evidence

The normal deployment owner installed `b0a2e31` successfully at approximately 19:19 UTC.
Marked outside-agent requests exercised two existing verification sessions: request
`6569ce49-6828-49dd-b00c-80d6022a11b1` to Claude (turn 5644) and
`91d939ce-32e7-4612-935b-b6c3a5cfb2a5` to Codex (turn 5645). Both were admitted,
acknowledged by the provider, completed, and returned the requested explicit final replies
through the owner. The Codex daemon was not restarted. All previously silent trace points
fired; those temporary logs can now be removed in favor of existing lifecycle events.

The incident watchdog also had a reachable false-interruption path: native fork, ChatGPT,
direct-child and pre-host preparation work may be active without an execution-host record.
Its age uses original enqueue time. The sweep now excludes the runtime's active-turn registry;
the false claims from this incident never entered that registry and remain detectable.

Post-repair queue inspection found only three future scheduled turns and four old archived
turns. Of today's 34 interrupted turns, 33 have no admission intent, provider start or
execution record; one has provider admission and must not be replayed. The Inbox owner was
given a source-preserving recovery request (`89536875-70b9-46d0-b62b-d896e383a4ce`) for its
15 retained interrupted captures, to distinguish real requests from diagnostic probes and
route only unhandled user work. That request later completed; see the acceptance evidence below.

### Final acceptance and retained-request recovery

The follow-up `0dfd959` installed successfully at 19:24 UTC. Six existing execution hosts were
adopted across the coordinator restart with the same host/provider PIDs. A new marked request
`9b3d776e-7d81-49e8-a5f6-7c78012c7bdf` then completed with `DISPATCH_FINAL_OK`. The Thinkering
session-view routes report both original verification sessions as completed. A post-install
query found zero aged running turns without provider admission or a matching execution record.

The Inbox's recovery request completed: 12 original human captures had never been routed;
they are now retained in six topics and sent to the corresponding owners. All six primary
recipient turns crossed provider admission; some had already completed when checked. This
proves restored routing, not completion of every underlying feature request. The original
interrupted turns remain immutable. Two diagnostic probes and one obsolete agent incident
message were excluded. Future schedules were left at their chosen times.

An explicit custody follow-up (`21e61618-7827-493e-9d41-ff9f4a5bea39`) also completed. Both
update screenshots were forwarded separately; the other five grouped secondary captures
contain text only, and their exact retained captures were additionally forwarded to the same
owners as informational supplements under the existing topics. No new tasks were created.

The report's hot Codex process is a separate unresolved resource observation: it still uses
approximately one CPU core, but completed a post-repair native turn without a daemon restart.
No evidence links that load to the dispatch failure. All nine alert delivery rows were delivered.

At 19:46 UTC, a separate Codex updater process was found running despite the lifecycle
runbook's intended disabled policy. Tejas's interactive CLI update had intentionally staged
0.162.0; staging a release was normal and did not restart the loaded 0.161.0 server. The
updater, however, could check that mismatch outside Concierge's admission gate. Its exact
`pid-update-loop` PID 2868223 and distinct process group were checked before sending TERM
to that PID only. It exited. The managed App Server retained PID 2870125 and its original
start time, its `model/list` request returned seven models, and Concierge's Codex turn
5657/session 3757 still had a live execution. No daemon restart was performed then.
That check was incomplete: normal Concierge startup at 19:47:41 UTC created a *second*
updater, PID 4016711, because `daemon start` ensures one by default even for an already
running App Server. Its scheduled check requested shutdown of PID 2870125 at 19:52:42,
then forced it at 19:53:42 after the 60-second grace. Turn 5657 ended in error. The
replacement launch failed readiness, and a new 0.162.0 listener appeared outside the
managed-daemon path; it was not restarted during this containment. The second updater
was then stopped by exact PID without stopping that listener. Codex's pinned 0.162.0
source documents a native persistent `updater.autoUpdateEnabled: false` preference;
it was applied to the machine-owned settings while retaining remote control. A subsequent
`daemon start` returned `alreadyRunning` without spawning an updater or replacing the
current listener. Future managed activation still needs explicit admission hold,
idle proof, restart, probe and reopening. The original CPU/memory load remains unexplained;
the updater failure is proven separately from that resource observation.

The remaining Grafana worker error recurred at the next startup, 19:29:08 UTC. The only firing,
delivered alert awaiting investigation was the historical `WorkspaceSkillsSyncStale` receipt
on `C0C03E75160`; that channel no longer exists in the channel registry. Startup tried
`admitOperationalTurn`, whose missing-channel guard necessarily throws. The current alert
owner's destination is `native:inbox`. Investigation now ignores receipts belonging to a
different destination. Historical state remains intact; the existing `accept` path still
retargets a fresh firing to the current destination. No retired Slack channel is recreated.

### Later release gate and installed revision

The first attempt to install the retained-alert fix (`8ca2c71`) failed during the scratch-only
presentation release gate: its topic-projection child reached the existing 45-second kill with
empty output. The deployment owner restored the healthy `040e824` runtime. That failed child's
scratch state was removed, so its last phase and the projection worker's status cannot be recovered.

A standalone topic lifecycle check and the full presentation gate both passed in a fresh isolated
checkout with the original deadlines. The fixture had a confirmed reporting defect: cleanup
registered a worker-exit listener after work had completed, so an already-exited worker could
leave cleanup waiting forever and hide its original error until the outer kill. This could explain
the empty-output timeout but is not proven to be the cause of that particular failure. The fixture
now owns worker completion from spawn, reports the last phase and exit status, and distinguishes
its deadline kill from another child failure; its deadlines are unchanged. The updated topic and
native-owner lifecycle checks both passed after integration with the later main revision.

The normal deployment owner then passed the presentation gate and activated `fd767c0` at
approximately 19:42 UTC. The service startup and probe recorded PID 3986917 with that exact
runtime revision, so the alert guard from `8ca2c71` was installed. The next release,
`1c8ad5e`, also passed the presentation gate, including the new native-owner lifecycle check,
and started at 19:44 UTC. No `grafana_alert_worker_failed` event appeared in the service journal
from the `fd767c0` startup through 19:44 UTC. This confirms installation and the observed clean
startup interval, not every future alert firing or the earlier release timeout's cause.

### Whole-recovery review and corrections

The Inbox coordinated an independent review in session 4570 across ledger writes,
turn survival, release fixtures and the adjacent changes. Its first review found
additional concrete defects; the receiving agent retained delivery ownership and
corrected them through the normal deployment path:

- All identified standalone writable ledger entrances now use the direct-write-count
  adapter, including provider-free notices. The existing release lint rejects bypasses.
  An isolated reproduction demonstrated the previous half-save. A read-only production
  audit found 90 provider-free inputs with all 90 acceptance events and no new key-change
  inputs in the affected window; no missing notice was established or reissued.
- Same-owner recovery now shares the dead-owner no-effect check: unattempted work returns
  to its existing FIFO, an unattempted explicit Stop cancels, and potentially admitted
  effects are never replayed. Both runtime compositions protect active work and run the
  periodic sweep. Thirteen isolated assertions and both runtime bundles passed. No
  production ghost was injected; Mac installation was not inspected in this recovery.
- The release fixture owns its process group and settles its original 45-second deadline
  independently of inherited output pipes. A forced-hang exercise started the real native
  worker, reported the timeout phase, and left neither owned child nor worker alive.
  Both final-source lifecycle checks passed. Bun's inflated raw count is now diagnostic,
  not a release requirement; correct direct counts and real dispatch remain assertions.
- The existing repair owner removed unmanaged Codex startup fallback and changed transient
  busy-ledger communication errors to retryable responses, preserving reply custody.

The Codex interruption did not lose the source-search work: turn 5659 was already queued
before 5657 failed and intentionally suppressed an extra automatic continuation. It resumed
the same durable provider thread at 19:54:04; its first retained assistant message explicitly
continued the correction. Empty `agent_text` on a running turn was not evidence of no progress.
No replay or additional continuation was created. A separate marked request
`765a88c8-c38f-4130-adde-e8979dc5a737` was admitted and acknowledged at 20:03:46 and returned
an explicit completed answer containing `CODEX_POST_UPDATE_OK`. This proves functional
dispatch and reply, not literal-only or no-tools compliance.

The archive-search failure was separate: a bounded history page no longer carried the source
metadata that the meaning-search consumer expected. Session 3757 owned the single accepted
repair; a competing uncommitted approach was paused. Search now requires validated pinned
source metadata plus proof that the matched event belongs to that exact retained source.
Unprovable hits become named omissions rather than crashing the search. The source host and
consumer were independently reviewed; the normal owner installed Concierge `46a0e17` at
20:14:52 UTC. The previously failing `Delivery test progress notes` query returned HTTP 200
in 0.755 seconds, including an archived meaning match. Search still reports incomplete
historical coverage; this result is not proof that every archive source was indexed.

The outside recovery CLI remains intentionally separate from the shared service. Updating
the CLI release is not itself a dispatch failure. Codex's native updater preference is the
minimal persistent containment for unscheduled daemon replacement; no second updater,
restart controller, provider fallback chain or replay mechanism was introduced.

At 20:19 UTC the focused independent correction review accepted the installed server
corrections. Both formerly failing search queries returned HTTP 200 (0.755 and 0.60 seconds).
The active Thinkering release `2ed81cc` includes the source-host correction `571b5fc`.
The server had zero updater loops, zero aged running turns without admission/execution,
and no new Grafana worker failures since activation; a resolved alert was delivered at
20:17:03. These are observed checks, not an assertion that every historical request is done.

The same review found a live Mac updater and no native opt-out setting there. The receiving
agent verified updater PID 27186's exact command and sent TERM only to that PID; managed
daemon 28324 retained its original 15:15:28 start time. Normal-installation enforcement of
the native preference is being added for both hosts; the server preference already survives
ordinary service starts. Separately, the current server listener remains unmanaged. The
repair owner confirmed account activation cannot manage it, but replacing it during active
work is unsafe; no such replacement has occurred. The existing owner is evaluating whether
the established generic admission drain can safely cover the one-time maintenance operation.

Archive discovery's fresh response still reports a stopped reader and 26 unindexed sources.
The stopped-reader flag is runtime state, not merely the old 19:46:11 index timestamp.
Search returns retained results with incomplete coverage. Source owner 3757 received this
remaining investigation under request `19c16c30-6eae-46d0-8c79-f608957d0ab0`; no blind restart
or competing source implementation was performed.

## Original handoff (historical, superseded by the investigation above)

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
