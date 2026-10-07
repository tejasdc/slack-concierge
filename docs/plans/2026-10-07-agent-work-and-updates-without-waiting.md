# Agent work, waking, and updates that do not wait for agents

**Status: Being built (Tejas said go, 2026-10-07 ~20:05 UTC). Agreed between GPT-6 Astra (first draft, commit 3471a7c, on Tejas's Mac) and Claude Fable 5.1 (review and co-design, on the server), 2026-10-07.** Built so far: step 2 (c387d2c), step 3 (fcbd95b; Thinkering 093a7e8), step 4 for Claude on Linux ([execution host](../architecture/EXECUTION-HOST.md)). One deliberate simplification in step 4: adoption replays the host's journal from its first frame through the same handlers, with every projection idempotent, instead of keeping a per-execution committed cursor in the ledger (§1.3); one fewer fact to keep consistent, and replay of a long turn costs milliseconds because replayed lines are not re-parsed for narration. What changed from the first draft and why is in the changelog at the end. Working evidence is in `tmp/reviews/agent-work-architecture/` (ignored): citation verification, external-source verification, probe transcripts, the two agents' exchange.

## TL;DR

Today every running Claude agent is a child process of the Concierge service, so restarting the service to install an update would kill it mid-work. The updater therefore waits for a moment when nothing runs, which on a busy evening never comes (06:29 to 07:06 UTC on 2026-10-07, and this review's own deploy sat waiting behind this review). The attempted fix, holding new work until running work finished, made his messages wait behind whichever agent ran longest, and was reverted the same day.

The agreed design: each agent process gets its own small, independently supervised **execution host** that holds the agent's pipes and journals what it says. The Concierge service then restarts without touching running agents, and reattaches to them by identity. His messages remain retained and retry with the same identity through that brief interruption, without waiting for an agent to finish and without asking him to resend during a routine update. Existing server restarts measured about 2.5 seconds; the new adoption path and the Mac must meet their own measured acceptance checks. Resuming an old conversation tomorrow starts a fresh agent process, so it runs under the new host automatically. The first host-capable release waits once for running agents to finish before it replaces the service; after that, no update waits. Codex turns already live in their own daemon; Concierge learns to re-adopt them after a restart instead of marking them interrupted. "Watch this for a day" becomes a small durable **watch** that wakes a session once with no agent awake meanwhile. The pre-command hook shrinks to the checks that must refuse an irreversible effect before it happens; the wait-only shell classifier and the self-matching-wait refusal go.

## 0. Requirements and measured facts

Hard requirements (from the brief, unchanged):

1. His messages are the highest priority and never wait behind agent work or an update [decision: his-requests-come-first].
2. Updates install soon and reliably, without cutting off a running agent turn and without losing any input, reply or effect.
3. Do not duplicate what Claude Code or Codex already do; do not depend on their notifications alone.
4. Long-lived watches must not depend on an agent staying awake and must not hold anything else up.
5. Per-command checks stay cheap and bounded; no ever-growing pile.
6. One person, two machines, the Mac sleeps. Minimum sufficient system; name what each new part is for.

Plus Tejas's resume question, answered in §2.4.

Facts established on the real system during this review (server unless noted; Mac facts from Astra):

| Fact | Evidence |
|---|---|
| Service restart, stop → online ≈ 2.5 s; startup phases 0.7–0.8 s | journal 2026-10-07 18:08:23–25Z; three restarts in three days |
| Claude children die with the service | `concierge-bot.service` `KillMode=mixed`; `systemd-cgls` lists the running `claude --print …` processes inside the unit |
| Codex daemon is outside the service | `codex app-server proxy` runs in a login-session scope, started from an interactive shell (the documented file-descriptor hazard; not this design's to fix) |
| Mac has the same coupling | `launchd/com.tejasdc.concierge.plist`: `KeepAlive=true`, `ExitTimeOut=300`, no `AbandonProcessGroup`; native-only composition cancels active turns on stop (`session-runtime.ts:126–132`) |
| Every turn is a fresh process, resume included | `claude-code.ts:363–383`: always `--print --verbose --output-format stream-json --input-format stream-json --replay-user-messages`, plus `--resume <uuid>` |
| Steering writes into the live process's stdin | `claude-code.ts:825–857` |
| Claude wakes itself when a background job ends (print mode, stdin open) | server probe: `task_notification` at t=28 s, then a new `system/init`, a second assistant turn and a second `result`, no input from Concierge |
| A repeated `initialize` returns a task snapshot | server probe: `control_response` success at t=5.88 s followed immediately by `background_tasks_changed` listing the live task; the response carries `pid` |
| Codex 0.161.0: a turn survives losing its client; reconnect recovers it; a pending approval is reissued | Astra P1/P1A, Mac, 18:45–18:48Z |
| Codex: child completion and a yielded command's exit are retained events, not a new parent turn (65 s observation) | Astra P2/P3; pinned source `completion.rs:117` `trigger_turn: false`, `async_watcher.rs:157` |
| Thinkering's message send has no retry across an owner restart | `browser-session-client.ts:159–162` plain `request`; uploads use `acrossRestart` (`retry-policies.ts:9`: 5 attempts, 60 s); failure shows a manual Retry (`session-messages.tsx:342`); the input itself is retained locally (`session-composer.tsx:77–85`) |
| Capture ingress is separate | `agent-inbox.service` stays up through a bot restart; the bot pulls from `127.0.0.1:8081` |
| Pre-command hook false positives | refused `sleep 25 && echo probe-done` (wait-only), a read-only `pgrep … \| while read` listing (self-matching wait), and Astra's diagnostic probe on the Mac |
| Hook cost | Mac source path: median 35 ms, p95 54 ms, max 92 ms over 30 no-op runs; one `git commit --amend` policy evaluation 2.14 s (remote lookup, `history-guard.ts:58`). Compiled server bundle not measured |
| Upstream supervisor exists, closed to print mode | `claude --bg` (2.1.283) rejects `-p` before creating a session; the SDK (0.3.263) has no attach API for stream-json clients; its daemon references are the Remote Control bridge |
| Hooks are pinned per run | `provider-owner-environment.ts` realpaths the helper directory into `CONCIERGE_ROUTER_BOT_DIR`; Codex's managed hook uses the moving `current` symlink (`install-codex-stop-hook.sh:61`) |

All 21 code citations in the first draft were re-verified on current main; two paths corrected (`bot/scripts/drain-status.ts`, `bot/scripts/history-guard.ts`).

### 0.1 Keeper experiment (2026-10-07, 20:06–20:10 UTC)

A throwaway keeper (`/root/workspace/agent-scripts/keeper-probe/`, logs in `tmp/reviews/keeper-probe-*.log`) started a real Claude agent in stream-json mode, held its pipes, journaled every line and accepted coordinators over a Unix socket.

| Machine | What was done | Observed |
|---|---|---|
| Server | Keeper started with `systemd-run` from inside a Concierge turn; coordinator A sent `sleep 30; echo finished-…; date` and left after 6 s; coordinator B attached 40 s later | Agent's control group `system.slice/keeper-probe-….service`, outside `concierge-bot.service`. The command finished at 20:08:04; at 20:08:07 the agent woke itself and wrote its result into the journal with no coordinator attached. Coordinator B's follow-up ("what time did it print?") was answered correctly ("20:08:04") by the same pid. |
| Mac | Keeper as its own launchd job in `gui/<uid>` (parent launchd); coordinator A sent the same task and left; the Mac's real `com.tejasdc.concierge` was restarted with `kickstart -k` mid-task (Mac idle, nothing running); coordinator B attached afterwards | Concierge pid changed 57984 → 65751; the agent process survived and answered both coordinators. The task itself could not run: the Mac's Claude account was at its session limit until 20:40 UTC, so tool execution across a Mac restart is still to be shown (the server showed it). |

Also found: the Mac's extra Claude account home keeps its login in the Keychain, not `.credentials.json`, and has its own `settings.json`, so `sharedClaudeHome` (which requires `.credentials.json`) never selects it and the shared-settings rule does not yet cover Mac homes. Step 6 must handle Keychain-held logins.

Not yet shown: a real `concierge-bot` restart on the server with a keeper running (cgroup separation is shown; the restart was not done because the probing turn itself ran inside the service), the private-stdio Codex path, and the server's shared Codex daemon (signed out; the Mac result from Astra stands).

## 1. Architecture

### 1.1 Parts, machines, purpose

```
          his phone / Action Button / web                 Tejas's Mac (peer, sleeps)
                      |                                   same parts, native-only composition,
   Thinkering server ─┬─ capture ingress (agent-inbox)    launchd instead of systemd, own ledger
                      |  (both stay up through an update)
  ═══ server (always on) ═════════════════════════════════════════════════════════════
                      |
   Concierge coordinator — concierge-bot.service, restartable in ~3 s, THE THING WE UPDATE
     ledger (SQLite) · HTTP owner · request coordinator · saved work · usage · projections
          |                      |                              |
   execution hosts          Codex App Server daemon        durable watch worker
   (one transient unit      (its own lifetime; threads     (one per machine; owns watch
    per execution; survive   adopted by exact ids)          registrations; no model)
    the coordinator)
     ├─ claude --print … (--resume uuid)
     └─ private Codex stdio (account homes)
```

| Part | Machine | What it is for | How often it changes |
|---|---|---|---|
| Coordinator | both | everything we iterate on: ledger, owner routes, request protocol, projections, saved work, usage, deploy control | often |
| Execution host | both | custody of one provider process: launch manifest, pipes, journal, exit; nothing else | rarely; versioned protocol; a running host is never patched in place |
| Codex App Server daemon | both | provider-owned execution for shared-daemon turns | provider upgrades only |
| Durable watch worker | both | holds every registered watch on that machine; delivers one service input per terminal event | rarely |
| Front door: Thinkering server, capture ingress | server (Mac for its own) | accept and retain his inputs while the coordinator restarts | Thinkering releases |
| Update control: stable entry + versioned runner | both | install a release without an idle gate; reach an updater that is already running | rarely; versioned |

### 1.2 What calls what

- Coordinator → host: one private Unix socket per execution, `$CONCIERGE_STATE_DIR/exec/<execution-id>/host.sock`, owner-derived path (never carried in a message), same user, no peer access. Commands: Start, Attach, Submit, Stop, Close (§4.1).
- Host → coordinator: the observation stream over the same socket, sequence-numbered, replayed from any cursor on Attach.
- Coordinator → Codex daemon: the existing bridge (`codex-app-server-client.ts`); after a restart, adoption by exact thread/turn id through `thread/resume` and paginated history; never `turn/start` for an adopted turn.
- Watch worker → coordinator: the existing service-input admission (the path `noticeMissingBackgroundReport` uses today), one stable `watch-event` id per terminal event.
- Front door → coordinator: the existing owner socket; Thinkering's `submit()` wrapped in its existing `ownerRestart` retry policy with its stable submission id; running agents' `router-actions.sh` calls retry the same way with their stable action id.
- Update control → coordinator: `deploy.sh` / `update-mac.sh` become a stable entry point that selects a versioned runner per attempt; the runner installs, restarts the coordinator, and reports; no drain gate for the coordinator.

### 1.3 Where each fact lives (one home each)

| Fact | Home | Never |
|---|---|---|
| Accepted inputs, sessions, turns, requests and returns, settlement, eligibility, user-visible projections, the acknowledged journal cursor per execution | ledger | journal |
| Which host holds which execution, host protocol version, launch manifest digest | ledger `executions` table (new) + the host's manifest file in its directory | `turns.owner_instance_id`, which stays the coordinator's claim only |
| Raw provider frames (stdout lines) with sequence, stderr, control-command identity and receipt, pipe-write attempted/completed, process exit (code, signal, time) | host journal: `$CONCIERGE_STATE_DIR/exec/<id>/journal`, append-only, framed | ledger |
| Live background-task membership for a process | coordinator memory, rebuilt from the `background_tasks_changed` level set and the snapshot after `reinitialize`; projected into the existing `background_job_status` | journal as a queue |
| Watch registrations: origin input, target session, kind, immutable condition, baseline, deadline, observed cursor, terminal event, delivery state | ledger `watches` table (new) | the worker's memory |
| Release references held by running hosts (executable, helper bundle) | ledger `executions` rows; release cleanup refuses while referenced | a cleanup script's guess |

Rule: the journal is observation custody. Projecting frame N and advancing the cursor to N happen in one ledger transaction. Replay rebuilds projections; it never repeats a provider write or an external effect. The journal never independently creates or settles a business obligation; its frames are evidence the ledger's settlement and projection logic consumes. A pipe write completing proves transport acceptance only, never that the model consumed the input. Durable policy state that must survive a restart without resetting, the 15- and 60-minute clocks (task start times) and the once-only identities of notices already sent, lives in the ledger's existing `background_job_status` rows, not in coordinator memory; a restart therefore neither resets a clock nor repeats a notice.

## 2. The execution host

### 2.1 Scope (agreed)

In the host: start one frozen launch manifest (executable, args, cwd, environment including the pinned helper directory and account home); hold stdin open until an explicit identified Close; write identified Submit bytes to stdin and record attempt and completion; spool every stdout and stderr line to the journal with a monotonic sequence before publishing it; accept Attach with a cursor, replay, then stream with no gap; report exact exit; keep the terminal record until the coordinator acknowledges custody; protocol-version handshake; single-writer ordering of control commands; command deduplication by command id; bounded framing; disk-error reporting and backpressure (a full disk stops acknowledging, never drops frames silently); process liveness.

In the coordinator, reconstructed from the journal and retained timestamps on adoption (ages are not reset by a restart): the inactivity policy; the 15- and 60-minute "still need this job?" prompts; task-membership folding; transcript watching and projection; the decision to close stdin after a result; Stop semantics beyond "interrupt once, then signal"; everything that settles a turn or a request.

Why thin: a host that holds policy changes often, and a running host cannot be patched; everything that changes often must live where a three-second restart replaces it.

### 2.2 OS supervision

- Linux: one transient **service** per execution, `concierge-exec-<execution-uuid>.service`, created by the coordinator with `systemd-run --unit=concierge-exec-<uuid> --service-type=exec --property=Restart=no --property=KillMode=control-group --collect <pinned host> <manifest path>` in the system manager, same user and credentials as today. A detached transient service whose supervised main process is the host; do not rely on moving the CLI into a scope to preserve its caller-owned pipes (the pipe-owning process and the unit's lifecycle policy are the actual dependency). No `PartOf`/`BindsTo` the bot. `KillMode=control-group` on the host unit, so a host that dies takes its provider descendants with it rather than leaving orphans without their transport owner (Astra's point; agreed). The bot's own `KillMode=mixed` is unchanged: nothing we want to survive lives in its cgroup any more.
- Mac: one launchd job per execution, label `com.tejasdc.concierge.exec.<execution-uuid>`, in `gui/<uid>`, bootstrapped from a private plist written in the execution directory (not the auto-loaded LaunchAgents folder); `RunAtLoad=true`, `KeepAlive=false`, default `AbandonProcessGroup`; ProgramArguments go through the signed agent-host entry so the macOS permission identity is preserved. The coordinator job keeps its own label; a separate label is what separates lifetimes. A duplicate label is reconciled against its manifest, never replaced blindly. Unknown until acceptance: attribution of the new label under the agent-host app.
- Host death is never auto-restarted. An effectful provider process is not relaunched by a supervisor. A failure confirmed before provider admission may retry under existing policy. An admitted execution whose host dies may already have had external effects, and neither the process death nor a missing final frame proves otherwise: the original run is preserved as interrupted/unconfirmed; a continuation, where the existing policy allows one (`queueTurnContinuation`, reason `interrupted`), is a new input that inspects the transcript and effects and carries the uncertainty, never a replay of the original prompt; later human input stays eligible.
- A host pins its release: its executable and helper bundle stay installed until no `executions` row references them.

### 2.3 Legacy executions at first install

Open pipes cannot be moved into a host, and the current coordinator owns them: replacing it kills them. So the first host-capable release waits once, as updates do today, for the executions it would otherwise kill to finish, then installs. Once installed, every new turn, including resume, uses the host, and subsequent compatible coordinator releases need no execution drain. Running turns are not ended to hurry that first install (the no-cutoff requirement applies to it too). The update line shows that one wait as what it is.

### 2.4 Resume (Tejas's question, answered)

Existing conversations do not remain on an old execution architecture. Every newly started turn, including tomorrow's continuation of a weeks-old conversation, is a fresh `claude` process with `--resume <uuid>`, started inside a host, which resumes the retained conversation. A resumable conversation is a transcript on disk, not a long-lived process. Nothing is migrated, and after the one-time install in §2.3 there is no old path left.

## 3. Updating without waiting

### 3.1 The flow

1. A push to `main` builds the candidate as today.
2. The stable update entry selects the versioned runner from the candidate for this attempt and records the runner version in deployment status. (Pulling new shell text does not change a function already executing; the old entry's job is only to hand over.)
3. The runner installs the release and restarts the coordinator. No drain gate for the coordinator. The capture gate is unchanged (ingress is a separate service).
4. The new coordinator starts and, before reopening effectful dispatch (human intake is never held): lists `executions` rows and host directories; Attaches to each live host exclusively, resuming projection from the committed cursor; sends the identified `reinitialize` through the host, which redelivers pending `can_use_tool`/dialog requests (by their stable provider request ids, handled idempotently, never a second question to Tejas) and is followed by the background-task snapshot. The host journals that response, the snapshot and any concurrent frames in the same sequence as every other frame, and the coordinator consumes the stream in order through the snapshot and onward, so an older membership frame can never overwrite the newer snapshot. A coordinator restart is not a CLI restart: membership is not reset to empty on reconnect; only a genuinely new provider process starts empty. On a CLI too old to send the snapshot, membership is an explicit unknown derived from the journal, never a guessed empty set. The reinitialize re-registers the hooks and launch policy pinned for that execution, not the new release's. Then it restores steering, Stop and settlement authority under the same run and input ids (the old run's source identity stays authorized after adoption, so its helper calls and late replies are not met with permanent refusals), adopts shared-daemon Codex threads by exact ids through `thread/resume` and paginated history, and only then reopens dispatch. Compatibility is checked before a healthy coordinator is replaced (step 2): the candidate must support every host protocol and helper contract still referenced by an admitted execution. If an unexpected incompatibility appears anyway, that execution enters an explicit degraded-recovery state with its custody retained; adoption is not reported as succeeded, unrelated new work is not held behind it, and the way out is a compatible adapter or a compatible rollback, never an old database over accepted inputs. Leaving the unknown host alive is containment, not the success path.
5. Every human entrance survives the restart by identity, not by a broker. Thinkering's `submit()` reuses its retained pending input and retries under the existing `ownerRestart` policy with the same submission id, classifying the real transport errors its client throws (connection refused or reset, lost response), not only an HTTP 503; the composer says "reconnecting, your message is kept" unless there is evidence of a restart, in which case it says so. The other human entrances get the same treatment and are inventoried in step 3: Stop and other controls, new-session creation, consultation, the iPhone and native clients; captures sit in ingress. A steer whose live run has truly ended is not turned into a new ordinary turn to make the retry succeed. The router helper (`router-request-client.ts:5–13` today makes one fetch with no deadline) retains the serialized body, source pair and action id once; retries transient refusals and lost responses with a per-attempt timeout inside a total budget; never mints a new action id; recovers an existing receipt by exact identity or resubmits the identical request through the owner's idempotent boundary; does not retry validation, auth or ownership refusals; and on exhaustion returns a machine-readable unconfirmed outcome with the exact retry identity. The Mac peer's brief restarts reuse the existing peer durability (`session-peers.ts:111, 391–408, 564, 945–969`), with an explicit acceptance check for a crash between remote acceptance and local record.
6. The update line in thnkr.ing says "Update installed" and, while any executions still run on an older host version, "N running conversations will finish on the previous execution version". Host version and coordinator release are separate facts: a coordinator update on an unchanged host binary counts nothing as old; tomorrow's resumed turn always uses the current host.

Comparative decision, fenced blue/green handoff versus single-owner restart (brief question A(iv)). Objective: requirements 1 and 2 at one person's scale. Measured: 2.5-second restart; Thinkering already carries a 60-second owner-restart retry policy; ingress is durable. The handoff would add a generation fence on every effect, a socket broker or routing change, two concurrently live versions and their schema coexistence; nothing it buys is needed to meet the objective once intake retries with identity. Astra withdrew it. Kept from it: exclusive coordinator attachment per execution (double adoption during recovery is a real risk), expand/contract schema changes, LKG rollback. Honest limit: "never wait" cannot mean zero latency; the measured interruption is disclosed, and if Tejas finds the seconds unacceptable the next step is a separately surviving intake endpoint, still not overlapping coordinators.

### 3.2 Schema and helpers across versions

Expand/contract: add columns and tables first, retire later when no running host or rollback release needs them. Old runs invoke their pinned helper bundle (`CONCIERGE_ROUTER_BOT_DIR`) against the new owner. Nothing bounds a long execution to one intervening update (two pushes during one run is ordinary), so there is no generation count: every candidate and every permitted rollback must support every host protocol and helper contract still referenced by an admitted execution, inventoried from the `executions` table before install, until those references retire. A versioned adapter or a stable protocol is the implementation choice; supporting every historical release forever is not the obligation. Direct-ledger reads from helpers move behind owner routes as they are touched. Rollback reattaches surviving hosts with the compatible protocol and keeps every newly accepted input; a database backup is never restored over accepted work.

## 4. Protocols and state machines

### 4.1 Coordinator ↔ host

Environment assumptions: local socket, same user; commands may be duplicated or their replies lost; the client disconnects and reconnects; journal tails may be torn; processes die; PIDs are reused; the coordinator may be any number of releases newer than the host, so the handshake names the host's protocol version and the coordinator speaks every version still referenced.

| Message | Fields and why | Receiver rule |
|---|---|---|
| Start | execution id, manifest digest, coordinator generation, command id | one host per execution (lock in the execution directory); retain the manifest before spawning; duplicate Start with the same digest returns the same handle; different digest refuses |
| Attach | execution id, last committed sequence, protocol versions supported | verify host identity (manifest digest, host pid from the directory lock); fence the previous attached writer; replay from the cursor then stream live; Attach starts nothing |
| Submit | input id, bytes digest, command id, generation | journal the command before writing; same command id returns the prior receipt; record pipe-write attempt and completion separately; no blind resend after an ambiguous write |
| Stop | execution id, command id, generation | journal intent; send the provider interrupt once, then the signal path after the grace; only terminal evidence confirms stopped; never affects the next execution |
| Close | execution id, command id | end stdin; the provider exits on its own; the host reports exit |
| Observation | execution id, sequence, raw frame | appended before publication; duplicate sequences are harmless |
| Status / Terminal | host pid, provider pid, last sequence, pending command ids, exit evidence | process exit is distinguished from a successful result; live, unreachable and dead are distinguished; the terminal record is kept until acknowledged |

Host states: `prepared → starting → live → exited`; `attached | detached` is orthogonal. An ambiguous launch or write is retained as ambiguous, never retried on its own.

Coordinator execution states: `intent retained → host custody → provider admitted → provider acknowledged → result retained → settled`. Adoption changes the coordinator claim generation only; it never increments the dispatch attempt or clears an acknowledgement. Before launch, the execution directory lock and the retained manifest prevent two processes from starting the same execution; a crash after spawn but before the pid is retained is resolved by the host's own lock, never by a second launch.

Hard limit, stated: there is no transaction spanning SQLite, a pipe write and a provider's tools. A host death between a pipe write and its durable receipt stays ambiguous. The guarantee is no blind duplicate and no discarded accepted obligation, not exactly-once external effects under arbitrary machine failure. An ordinary coordinator restart never enters this ambiguity, because the host stays alive.

### 4.2 Coordinator ↔ Codex daemon (adoption)

On restart: for each turn the ledger shows admitted to the shared daemon, `thread/resume` by thread id, read paginated history, identify the turn by provider turn id or client user-message id (the reconnect path already does this while the bot is alive, `codex.ts:1231–1292`), restore the controller without `turn/start`, resubscribe, and reconcile pending server requests (approvals are reissued by the daemon, as P1A showed). Turn completion is model-turn completion, not the exit of every yielded process; the registry keeps "child response completed" and "processes initiated by that child exited" as separate facts (Astra P2).

### 4.3 Requests between sessions

Unchanged: the explicit-reply protocol (`docs/plans/2026-09-23-request-reply-protocol.md`), the Stop hook, the stalled notice, returns carried once. A restart replays retained obligations from the ledger; it never re-asks.

### 4.4 Watch ↔ session

The watch worker registers, observes and delivers; the session receives one service input per terminal event with a stable id (`watch:<watch-id>:<event>`). Delivery states `pending → accepted`, reusing the existing service-input admission and its hold rules (a paused or archived session holds delivery; nothing forces a model run).

## 5. Failure matrix

| Failure | Outcome that preserves the invariants |
|---|---|
| Coordinator restarts while a provider is writing | the host keeps reading; the new coordinator replays from the committed cursor; same run, same ids |
| Coordinator dies after accepting an input, before Submit | the durable intent is picked up once; the host's command id prevents a duplicate write where custody already exists |
| Host gets a command but the reply is lost | retry the same command id; inspect the retained receipt; a timeout is not a refusal |
| Host dies after an ambiguous pipe write | reconcile with the transcript and provider ids; retain uncertainty if unresolved; never repeat the original task automatically |
| Two coordinators overlap during recovery | exclusive attachment per execution (writer fence at the host) rejects the stale one; duplicate observations deduplicate by sequence |
| A native task's start edge is missed | the level set and the snapshot after `reinitialize` rebuild membership; no dependence on paired edges |
| A native task's completion report is lost | the existing missing-report notice, now evaluated from the level set and the output file, one idempotent recovery input; a late native report merges |
| Thinkering sends during the restart | retried under `ownerRestart` with the same submission id; accepted once; the composer shows "Concierge is restarting" rather than a failure |
| A running agent's helper call hits the restart | retried with the same action id; the owner's action-id dedup makes a resend harmless |
| Codex client connection lost with an approval pending | the daemon reissues the pending item on reconnect (observed); Concierge answers it under the same policy; never approves from an old request id |
| Host unit exists but the process is gone | reconcile exact process and exit evidence; keep interrupted/unconfirmed when unresolved; no automatic relaunch and no replay of the original input; a later continuation follows §2.2's conditional evidence-inspection rule |
| Coordinator meets a host protocol version it does not know (compatibility preflight missed it) | containment: leave it running with custody retained, in an explicit degraded-recovery state; adoption not reported as succeeded; unrelated work not held; exit through a compatible adapter or compatible rollback |
| Mac sleeps or reboots | sleep pauses hosts and watches; wake reconciles; reboot ends live compute and yields an explicit interrupted or unconfirmed result, never a counterfeit resume |
| Application rollback | reattach surviving hosts with the compatible protocol; keep all newly accepted inputs |
| Old release cleanup | refused while any `executions` row references its executable or helper bundle |
| Watch fires while the session is paused or archived | result and delivery retained; existing hold honored; recorded outcome visible; no forced model run |
| Watch worker dies | its registrations are in the ledger; on restart it rechecks each baseline and deadline; a change-and-revert during the gap is recorded as unknowable |
| Human Stop races a result | record the Stop intent; terminal or result evidence decides; completed effects are never rewritten as cancelled |
| The updater itself is old | the stable entry hands over to the versioned runner each attempt; an old runner holding an irreversible step is never pre-empted; legacy detection at first install |

## 6. Background-work map

"Run ended" means the model response finished; the provider process may still hold work. After this design, nothing in this table holds a coordinator update.

| Kind | Lifetime owner; what wakes the agent | If the model response ends first | Across a coordinator restart (after this design) | Failure and treatment |
|---|---|---|---|---|
| Claude foreground tool or helper | Claude; the tool result returns into the turn | part of the turn | the host keeps the process; the coordinator reattaches | no automatic tool replay after host death |
| Claude background Bash | Claude; `task_notification` then a new model turn, by the CLI itself while stdin is open (probe) | the process stays open; Concierge keeps stdin open while tracked work remains (today's `claude-code.ts:601`, ceiling at line 62) | survives; membership rebuilt from the level set + snapshot | lost report → one idempotent recovery notice; never a second waiter |
| Claude async subagent | Claude; completion notification in a later turn (docs: sub-agents) | same | same | native delegation retained; no top-level Concierge session per helper |
| Nested helper's own shell | Claude; wakes the helper (observed 2026-10-07) | same | same | keep parent/child attribution; nested notices are never human inputs |
| Claude Monitor | Claude; events while the session is open; not restored on resume (docs: scheduled-tasks) | same | survives in the host | not a durable watch; a day-long obligation is a watch |
| Claude CronCreate / ScheduleWakeup / loop | fires only while the process runs and is idle; no catch-up per missed tick; Cron restored on resume, loop not | timers hold nothing open | the process survives, so timers survive | durable wake-ups use Concierge saved work |
| Claude native `--bg` sessions | upstream supervisor | n/a | n/a | not usable with print mode today; re-check each CLI upgrade; retire our host if it opens |
| Codex foreground long exec (unified exec, yield) | daemon; the yielded command continues after the response (P3: exit is a retained event, not a model wake) | command continues in the loaded thread | the daemon survives; Concierge adopts by ids | inspect exact exit; never rerun |
| Codex background terminal | daemon; list/terminate/clean APIs (experimental) | same | same | terminal exit is not a wake; a long obligation becomes a watch |
| Codex child agents | daemon; completion queued to the parent without a new turn (P2; `trigger_turn: false`) | mailbox until a later input | same | do not promise Claude's wake semantics; use a Concierge request when a durable reply is required |
| Codex App Server turn | daemon; `turn/completed` | n/a | adopted by exact ids, no `turn/start`, attempt not incremented | pending approvals reissued; reconcile history |
| Concierge request/reply | ledger; the return input wakes an idle asker or steers a running one | durable | replayed from the ledger | explicit dispositions only |
| Concierge scheduled / repeating / banked work | ledger; the queue clock | no model until admitted | durable | kind, time, account pin and repeat identity preserved |
| Concierge continuation | ledger | admits a later turn under its condition | durable | never proof of prior effects |
| Service notices | owner, steered into the live run | requires a running turn today | delivery obligation persisted | if the run ended, deliver as a service input to the session |
| **Durable watch (new)** | watch worker; one service input on fire, expiry, failure or cancel | the agent finishes immediately | the worker and registrations survive; Mac sleep is a recorded gap | explicit terminal states; never holds an update |

## 7. The durable watch

What it is for: "wake this session once when this exact condition happens or the deadline arrives", with no model awake while waiting. What it is not: the catalog's `scheduling-jobs` standard already covers "check every N minutes and tell me when something new turns up" with a repeating Concierge schedule whose each firing is a short model judgement; that stays. The watch is its complement, not a second scheduler.

Kinds at first delivery, both with a stored baseline and one terminal obligation:

1. File or directory version change (content hash or mtime+size baseline, rechecked after any gap).
2. Supervised command completion: the worker launches the command from an explicit argv and cwd under the registering agent's existing local authority, with a manifest and a reliable exit record. Observing an already-running process is by exact process incarnation (pid + start time) and reports only "gone", with the exit code marked unknown. A bare pid is never trusted alone.

Authority: registration is local to the machine (`router-actions.sh sessions watch …`, same user, same shell authority the agent already has); the owner authenticates the origin and enforces locality. A watch is never forwarded to a peer and never reachable from a session-facing or public route; a Mac-local condition is a Mac watch, a remote-accessible one runs on the server.

Lifecycle: `accepted → observing → fired | expired | failed | cancelled`; delivery `pending → accepted`. The baseline is saved before the registration is acknowledged (closes the setup race); a level condition is rechecked after subscription and after every wake; deadline and condition racing settle one terminal event in one transaction; the event and its retained observation are written before delivery; delivery is one service input with a stable id to the exact session, under the existing hold rules. Mac sleep pauses observation; on wake the worker compares baseline and deadline and records the gap, because a change-and-revert while asleep is unknowable without a durable event source. One supervised worker per machine multiplexes registrations; no unit per watch.

Version semantics are defined per detector and stated at registration: the file detector's baseline is a content hash where the file is small enough to hash and mtime+size otherwise, and the registration says which; mtime+size is not proof of content identity. What Tejas sees: the conversation shows "watching <what> until <deadline>" with no agent running; when it fires, the same conversation wakes and explains; at expiry it reports that no qualifying change was observed, including any observation gaps; a gap is stated as a gap.

## 8. Bounded per-command checks

What the hook is: a Concierge-supplied command that Claude (`--settings` on every run) and Codex (managed hook, no matcher, every tool) invoke as a new process per matched tool call. Measured cost above. It currently dispatches six policies (`history-guard.ts:92–122`): pushed-history rewrites (with remote lookups), Messages/notification database reads, writable Codex launches from a shared checkout, self-matching wait loops, wait-only background jobs, and website-runbook context. It produced three false refusals during this review alone.

Agreed shape:

- Keep these bounded pre-effect checks for the stated exposure, history-integrity and conflict risks, with the stronger operation boundaries and limitations named: (1) pushed-history rewrite refusal, where Git's pre-push is the authority and the hook is the early, friendlier refusal; (2) direct Messages/notification database access refusal, because exposure cannot be undone and the approved reader withholds login codes; (3) writable nested-agent launch from a shared checkout, an interim conflict guard until the launch capability enforces isolation itself (corruption prevention, not an irreversible syscall).
- Remove now, as a separately authorized scoped change: the wait-only job classifier and the self-matching-loop refusal. Neither names a pre-effect invariant; both are shell-text heuristics with observed false positives; and lifetime policy does not belong in a per-command check. Different parts of what they tried to cover are solved elsewhere: Claude's native completion wake (observed; Codex's completion events do not wake a parent, P2/P3), the provider-specific reconciliation of §6, independently hosted execution, and the missing-report notice with the 15/60-minute prompts. Removal does not wait for the host or the watch.
- Move: website-runbook context goes to the browser capability's own entry; the owed-reply Stop hook stays at response settlement.
- Cost discipline: one parser, bounded input, constant dispatch by operation type; no network, ledger open or repository traversal on unrelated commands; one total deadline for the expensive branch with an explicit indeterminate result; p50/p95 and refusal reasons instrumented.
- Growth rule: a new pre-command policy must name the pre-effect invariant it protects, the material irreversible or conflicting consequence of not checking, and why no stronger boundary (Git, the credential boundary, the launch API) can refuse it. "Agents sometimes do an inefficient thing" does not qualify. The policy table in `history-guard.ts` requires those fields per entry. No new policy framework and no new per-command classifier follow from this review.

## 9. Implementation plan

Each step is a complete delivery with its own acceptance check on the real system; steps are ordered by dependency, not partial activations of one feature (review-gates: design and review each change as one whole). Costs are comparative estimates, not schedules.

| # | Step | Depends on | Acceptance check on the real system | What Tejas sees | Cost | Risk |
|---|---|---|---|---|---|---|
| 1 | Record the facts: this document, probe transcripts, hook measurements on the compiled server bundle | — | the compiled-bundle hook cost measured on the server; P4 snapshot re-run on the Mac once step 2 lands | nothing yet | small | none |
| 2 | Remove the wait-only and self-matching refusals from the hook; keep the three retained checks; add the growth rule to the policy table | — | a deliberate `sleep`-based background job is allowed; `git commit --amend` on a pushed commit is still refused; a Messages database read is still refused | agents stop being refused for harmless jobs | small | low; reversible |
| 3 | Every human entrance survives a short restart by identity: inventory them (web composer, Stop and controls, new-session creation, consultation, iPhone and native clients, the router helper, peer requests); wrap each in the existing `ownerRestart` policy with its stable id; helper gets per-attempt timeout, total budget and an unconfirmed outcome on exhaustion; composer wording that distinguishes a known restart from an unexplained reconnect | — | in an isolated marked owner/provider lane (or a controlled boundary with no unrelated admitted work; never a production restart under live agent work, which today kills it): restart the owner while sending from the web composer, pressing Stop, creating a session, and from a marked agent's `router-actions.sh`: each accepted exactly once, no Retry button, the receipt reconciles; a crash between a peer's remote acceptance and the local record yields one delivery | a message sent during an update just goes through; nothing asks him to resend | small–medium | low |
| 4 | Execution host on Linux, delivered whole: host binary and its documented protocol and version policy, journal, socket, `executions` table, `systemd-run` launcher, adoption on startup, exclusive attachment, release pinning with the cleanup refusal, compatibility preflight; both compositions stop cancelling active turns on shutdown | 3 | a marked test execution running a long harmless tool keeps its host and provider pids while `concierge-bot.service` restarts; a follow-up message and a Stop reach it; pending approval redelivered after `reinitialize`; missed frames replayed once; killing only the host leaves no unmanaged children and replays nothing; release cleanup refuses while the host references it | agents keep working through an update on the server (once step 7 lands) | large | medium: new lifetime boundary; mitigated by the one-time install boundary and exclusive attachment |
| 5 | Codex adoption through Concierge recovery for both Codex kinds on Linux: shared-daemon controller restore by ids, pending-request resubscription, paginated history; private-stdio Codex under the same host as Claude | 4 | restart the coordinator during a marked shared-daemon Codex turn and a marked private-stdio turn: each completes under the same run id, a reissued approval is answered once, no `turn/start` | Codex agents are no longer marked interrupted by an update | medium | low–medium: depends on daemon version; capability recorded per version |
| 6 | Mac host, delivered whole like step 4: per-execution launchd label from a private plist via the signed agent-host entry; Codex kinds the Mac admits; `update-mac.sh` on the stable-entry pattern | 4, 5 | restart `com.tejasdc.concierge` while a marked execution of each kind runs on the Mac; same checks as steps 4 and 5; sleep/wake yields recorded pause, not loss | the Mac updates itself without cutting agents off (once step 7 lands there) | medium | medium: launchd identity attribution unknown until tried |
| 7 | Deploy without the coordinator drain gate, per machine, only when that machine can restart without abandoning any execution kind it admits: Linux after 4 and 5, Mac after 6; stable update entry + versioned runner; compatibility inventory before install; update line "N running conversations will finish on the previous execution version"; the one-time first install waits for legacy executions as today | 4, 5 (Linux); 6 (Mac) | push a trivial change while a marked execution of each admitted kind runs: the update installs within minutes, every execution survives, the line shows the count; a second push after they finish shows none; a candidate missing a referenced host protocol is refused at preflight | updates land while his agents run; no "finish so the update can run" | medium | medium: the first install still waits once |
| 8 | Native task reconciliation: fold the level set as authoritative, snapshot after `reinitialize`, missing-report notice from the set + output file, late report merge | 4 | drop one observed start edge and one completion notice in a marked lane: membership restored from the snapshot; exactly one recovery input reaches the session; a late native notice merges | accurate Working/Waiting state; a missing report is explained, never waited on forever | small–medium | low |
| 9 | Durable watch, delivered whole: `watches` table, worker per machine, two kinds with their stated version semantics, `sessions watch`, delivery via service input, Mac gap semantics, capability-map row | 4 (server), 6 (Mac) | a day-long file watch keeps no model turn open; trigger it during a coordinator restart and after a Mac sleep: one retained result wakes the exact session; expiry, cancel and gap are visible | "watching until tomorrow", the agent is free, the right conversation wakes | medium | low–medium |
| 10 | Final documentation sweep: update runbook, architecture index, retrospective links (each step above already carried its own protocol, compatibility and cleanup documentation) | 4–9 | docs cite the shipped behaviour | nothing visible; the system stays understandable | small | none |

Already-running work: nothing in this plan stops, restarts or alters a running agent, service or account. Steps 2 and 3 are independent of the host and can ship first. The gate is removed per machine only when every execution kind that machine admits is recoverable (step 7); until then the safe gate stays for the uncovered kinds.

## 10. Sources that shaped this design

- Catalog skills: `stateful-shapes` (shape by failure mode: one coordinator per session, durable turn lifecycle, agent thread; guideline 13 on explicit obligations), `protocol-design` (five elements, vocabulary, receiver-side authority, duplicates and sleep), `architecture-lessons` (one home per fact; a derived guard must be watched failing), `review-gates` (minimum sufficient system; one whole per change), `application-observability` (pending ≠ success ≠ failure; every attempt records how it ended), `codex-cli` (who wakes whom), `scheduling-jobs` (the watch-and-notify standard the watch complements).
- Provider documentation: Claude Code agent view (supervisor; `--bg` conflicts with `--print`; background work carries over to the next process; updates do not interrupt working sessions), scheduled tasks (background Bash and monitors never restored on resume; one catch-up fire), sub-agents (completion as a later-turn notification), hooks (new process per invocation; exit 2 blocks); SDK 0.3.263 types (`background_tasks_changed` level set and snapshot on re-initialize; `reinitialize` redelivery; Stop hook `background_tasks`); Codex App Server (unsubscribe, 30-minute unload grace, background-terminal APIs, `process/writeStdin`), Codex hooks (shell and unified exec match as `Bash`; managed hooks), pinned Codex source at 622e9e3 (`completion.rs:117`, `async_watcher.rs:157`, `thread_processor.rs:3605`).
- AWS Well-Architected, as principles at this scale: REL05-BP01 graceful degradation (a sleeping peer is not a failure), REL04-BP02 loosely coupled dependencies (the queue and ledger between front door and coordinator), REL04-BP04 make mutating operations idempotent (submission and action ids), REL10-BP03 bulkheads (one execution's death does not take the coordinator or its siblings; the cell mechanics do not apply), OPS06-BP04 automate rollback (the existing LKG path), REL05-BP03 control and limit retries (the bounded `ownerRestart` policy). Immutable-infrastructure blue/green (REL08-BP04) assumes a fleet and does not apply.
- Established models: Erlang supervision (independent restart decisions per child; no unconditional restart for effectful workers), Temporal signals (a result reaches a sleeping logical session without a process waiting; no deterministic replay of LLM or shell execution), FIPA request (accepted and finished are separate facts), transactional outbox and idempotent receiver.
- Tejas's own reading (Readwise ids): Anthropic, "Scaling Managed Agents: Decoupling the brain from the hands" (`01knr94a5xajcxkbz8jrpfpzmp`): "the harness leaves the container… If the container died, the harness caught the failure as a tool-call error", and a crashed harness is rebooted with `wake(sessionId)` and resumes from the session log's last event. That is this design's split, with the roles mirrored: here the long-lived process is the agent and the replaceable part is the coordinator. Meta's XFaaS (`01jfhj2z3p74rdfea1jjnffm5r`): "central controllers are separate from the function execution path… controller downtime for tens of minutes" is tolerated; the test it suggests is adopted as an acceptance check (a host keeps its provider running with zero coordinator contact for the whole restart window, degrading only to "cannot accept new commands"). Alvaro Duran, "Why Payments Engineers Should Avoid State Machines" (`01jfhjda431jc5vvve8sqke9mc`): "requesting the current state… is an idempotent operation by design", the reason the coordinator pulls the journal by cursor rather than being pushed transitions. Eric Allam, "Two Roads to Durable Agents: Replay vs. Snapshot" (AI Engineer 2025): replay journals must be deterministic and are hard to version across deploys. Settled here: the journal is observation custody read forward by cursor to rebuild projections; nothing re-executes, so no determinism requirement and no replay-format versioning beyond the host protocol version. Vinoth Govindarajan, "Your Agent Didn't Fail. Your Harness Did." (AI Engineer 2026): record "what woke it up, which authority it used, what executed (attempt number, idempotency key), what evidence survived", which the command envelope and the `executions` row carry. clig.dev (`01kd9y2j0n9cqtykrteb1qagxk`): "make it crash-only", the property the host and the hook keep (no cleanup owed if either dies mid-step). Alan Kay via Scott Werner (`01khk84nk5scv4kpr7bwnrg45n`) and Stephen Merity (`01jysp2nnjkg8a8p3cszk2zr2h`): "as complexity grows, architecture dominates material"; the host, journal, cursor and watch are the arch, where more retries and more hook checks would be more bricks. Richard Cook, "How Complex Systems Fail" (`01gm691e8stp8412gx6jgp8s5m`): no boundary is sufficient alone, which is why host state, adoption results and watch states are all queryable facts rather than assumed.

## Changelog from the first draft (3471a7c)

1. The "gate is held" paragraph was a stale local snapshot; current main (f6f062e) releases the gate and retries at idle. Marked historical.
2. Fenced blue/green coordinator handoff withdrawn as the default (Astra, after the measured 2.5-second restart and Thinkering's existing restart retry policy). Replaced by single-owner restart with identity-preserving intake. Exclusive attachment, expand/contract and rollback kept.
3. The resume question answered explicitly (§2.4) with Astra's wording.
4. Host scope fixed as thin (§2.1); OS mechanism named per machine (§2.2) with `KillMode=control-group` on the host unit, not `process`.
5. Intake: Thinkering's send does not retry across a restart today; the fix is to use its existing `ownerRestart` policy for `submit()` and for the router helper (step 3). This replaces the draft's "narrow socket broker or front-door routing change".
6. Claude facts corrected by probes: completion wakes the model natively in print mode; `reinitialize` returns a task snapshot on 2.1.283 (the draft had it as unknown). Citation of the streaming-mode page for stdin behaviour dropped; the stream event names cited to the SDK types, not docs.
7. Codex facts bounded by probes on 0.161.0 (client loss survived; approval reissued; child completion and terminal exit are events, not wakes); third-party descriptions of `spawn_agent`/`wait_agent` and unified-exec flags removed.
8. The durable watch defined against the catalog's scheduling-jobs standard, with two kinds, local authority, and the Mac gap rule.
9. The hook: removal of the two heuristic refusals moved to "now, separately" (both agents, after three false positives in one review); retained checks named with the effect each prevents; growth rule made a field of the policy table.
10. Update control named as its own rarely changing part with a versioned runner, after the Mac updater kept an already-reverted policy until its next cycle.
11. Phases replaced by dependency-ordered complete deliveries with real-system acceptance checks, cost and risk, to honour the no-phases rule honestly.
12. Observability added: host state is a queryable fact, the update line shows old-generation counts, and every watch terminal state is recorded.
13. Round two (Astra): adoption consumes one ordered observation stream through the snapshot rather than "fold then replay"; a coordinator restart never resets task membership; host death never auto-continues uncertain work; the router helper and every human entrance (not only the web composer) retry by identity with bounded attempts; durable clock ages and once-only notice identities live in the ledger; the update wording distinguishes execution version from conversation identity; the hook growth rule asks for an invariant and a material consequence rather than claiming every check is an irreversible syscall.
14. Final read (Astra, all accepted): gate removal per machine depends on recovery for every execution kind it admits (Codex adoption moved before gate removal; Mac after its host); compatibility covers every live reference, not one generation, with preflight before replacing a healthy coordinator and a degraded-recovery state as containment; the first host-capable install waits once for legacy executions instead of pretending to retain them; user-visible claims narrowed to measured behaviour (retained and retried through a brief interruption; expiry reports no qualifying change observed, with gaps); the host-gone row and the hook rationale made consistent with §2.2 and §8; each delivery step carries its own protocol, compatibility and cleanup documentation. No disagreement remains.
