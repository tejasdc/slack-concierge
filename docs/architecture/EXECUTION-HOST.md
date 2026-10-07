# Execution host

**Status: built on Linux (server) for Claude runs, Codex runs and updates, 2026-10-07; the Mac host
(launchd) is a later delivery** of
[agent work and updates without waiting](../plans/2026-10-07-agent-work-and-updates-without-waiting.md)
§9 steps 4, 5, 7 (Linux) and 6.

## What it is for

A Claude agent used to be a child process of the Concierge service, so restarting the service killed
it. Each new Claude run now starts inside its own small supervised program, the **execution host**,
which holds the agent's pipes and records everything it says. The Concierge service (the
**coordinator**) can then stop and start without touching the agent, and the next coordinator takes
the run back under the same turn, run and input identities.

| Part | Where | Owns |
| --- | --- | --- |
| Host program `bot/scripts/execution-host.ts` (release bundle `control/bot/scripts/execution-host.js`) | one transient systemd service per execution, `concierge-exec-<id>.service`, outside `concierge-bot.service` | the provider process, its stdin/stdout/stderr, the journal, exit evidence |
| Coordinator side `bot/src/execution-host-client.ts` | inside Concierge | starting a host, the connection protocol, `HostedClaudeCodeTransport` |
| Ledger table `executions` (`bot/src/executions.ts`) | Concierge's SQLite | which host holds which run, custody state, what adoption needs |
| Adoption at startup (`claimAdoptableExecutions`) | both runtime compositions, before steering and turn recovery | taking a run back |

The host holds no policy. Inactivity limits, background-job waits, steering, Stop semantics, what a
frame means and every settlement stay in the coordinator, which a restart replaces. A running host is
never patched.

## Lifetimes

- `systemd-run --unit=concierge-exec-<id> --service-type=exec --collect -p Restart=no -p KillMode=control-group`
  starts `bun run <release>/control/bot/scripts/execution-host.js <state>/exec/<id>` in the system
  manager. The unit name is the one-start lock; a journal already present also refuses a second start.
- `KillMode=control-group`: if the host dies, systemd stops the unit and the provider and every tool
  it started go with it (checked: killing only the host left no `claude` or tool shell behind).
  Nothing restarts a host and nothing relaunches a provider that already ran.
- `concierge-bot.service` keeps `KillMode=mixed`; nothing that must survive lives in its cgroup.
- The host stays after the provider exits until a coordinator acknowledges the exit (`release`),
  or seven days pass.

## Files

`$CONCIERGE_STATE_DIR/exec/<16-hex id>/` (0700): `manifest.json` (executable, args, cwd, opening input;
the environment is removed from disk once the provider has started), `journal` (append-only JSON
lines `{s, t, k, d}`), `host.sock` (0600). Folders of runs that ended over 30 days ago are removed at
startup; their ledger rows stay.

Journal kinds: `h` host facts (protocol, pids), `i` a write to the provider (`{id, line, meta}`,
recorded before it is written), `o` one stdout line, `e` a stderr chunk, `c` a control fact (`written`
when the pipe accepted an `i`, `write-failed`, close, signal, release, host exit), `x` the provider's
exit `{code, signal, at}`. A frame is published only once it is fully on disk; a failed write resumes
where it stopped, so a torn tail never swallows the next frame. While the disk refuses, the host stops
reading the provider and keeps answering `status`, `signal` and `close`; a `submit` is refused with
`written:false` (provably unsent) rather than written without a record.

## Protocol (version 1)

Line-delimited JSON over the private socket, same user, path derived by the owner, never sent in a
message.

| Message | Rule |
| --- | --- |
| `status` | host pid, provider pid, last sequence, exit, journal error |
| `attach {protocol, from}` | refused unless the protocol matches; fences any earlier attached connection (`fenced`, its commands refused); replays the journal from `from` and switches to live delivery in one synchronous step, so nothing falls between |
| `submit {id, line, meta}` | only from the attached connection; records `i` before writing; the same `id` returns the first receipt and never writes again; `written: true` proves the pipe accepted it, never that the model read it |
| `close {id}` | ends stdin; the provider exits by itself |
| `signal {id, signal}` | SIGINT/SIGTERM/SIGKILL to the provider's process group |
| `release {id}` | refused while the provider runs or the record is not fully on disk; afterwards the host exits. Sent by the turn's owner only after the turn's outcome is durably settled (`releaseExecutions`), never on seeing the exit, so a crash in between leaves the record for the next coordinator |

A full disk stops reading the provider (backpressure) and is reported in `status`, never a dropped frame.

## Coordinator states

`executions.state`: `intended` (recorded before `systemd-run`) → `live` (unit started) → `exited`
(the `x` frame was consumed) → `released`; `lost` when startup finds no answering host. Adoption
changes `turns.owner_instance_id` and `executions.coordinator_instance_id` in one transaction and
counts `adoptions`; it never increments the dispatch attempt or clears an acknowledgement.

## Taking a run back (adoption)

At startup, before steering recovery and turn recovery run, each open execution of a still-running
turn whose coordinator is dead is decided by evidence (`claimAdoptableExecutions`):

The decision (`hostCustody`) is the same one a live run makes when its connection breaks or its
first attach fails after a launch: the supervisor's view is three-valued (`systemctl show`: alive,
positively gone, or unknown when the query fails), unknown keeps custody, and the unit name is derived
from the execution id, so a launch that crashed before recording it is still checked. A run whose
connection is lost stays pending (held) and keeps deciding, 1 s then every 30 s; it never unwinds
through provider-failure settlement while its host may still act.

| Host | Decision |
| --- | --- |
| answers its exact execution id | taken back live (`adopt`) |
| gone (its unit no longer runs) with a recorded exit | settled from its record alone (`adopt-record`): the outcome is the provider's own, never an interruption |
| still running but not answering, or speaking a protocol this coordinator cannot adopt | **held**: the turn becomes this coordinator's (so recovery never reads it as dead while the agent may act), the execution is marked `held: …`, and an unresponsive host is retried every 30 s until it answers, leaves a record, or is gone; only that session waits |
| gone with no recorded exit | `lost`: ordinary recovery, interrupted and unconfirmed, never replayed |

Taking back:

1. The turn is claimed for the new coordinator in one transaction (same dispatch attempt).
2. Follow-ups queued but never handed to the provider fail back to their queue. One that was being
   sent is decided by the host's receipts: no recorded attempt or a recorded failure means unsent; a
   recorded completed write is decided by Claude's pickup during or after the replay; an attempt with
   no outcome, or a record that cannot be read, stays uncertain (never resent).
3. The run re-enters the same native execution path (`SessionExecutionHost.run(claim, adoption)`),
   with the exact prompt, folders, model, account and session id stored at launch in
   `executions.processor_json`.
4. The transport attaches; the host returns its sequence at that moment (`until`) in the same
   synchronous step that starts the replay. Frames that arrive before the boundary is known wait
   unsorted; the history (up to `until`) is collected whole, so each recorded write is replayed with
   its recorded outcome (a write the host recorded as failed rebuilds nothing), and it is handed over
   only after this run's writer exists. Frames up to `until` are the predecessor's history: stdout lines carry their
   original receipt time (the adapter's clock, so a background job keeps its age) and the
   predecessor's writes are rebuilt (pending follow-ups, a Stop already sent, a compaction or a
   model switch with its request id). **During the replay the adapter only rebuilds state: it writes
   nothing, closes nothing (a close any rebuilt decision implies is owed), arms no policy deadline
   (compaction, model switch, a background job's missing-report grace) and registers no steering.**
   At the end of the history (`onReplayEnd`) it acts once on what is still owed: completing a Stop
   whose interrupt is in the record (close and signal grace, the interrupt not resent), an owed close,
   the deadlines still pending (from now), a continuation owed after a compaction or a model switch
   that the record does not show written (sent with a stable command id), the steering
   registration, and one close-after-result evaluation of the final state. Replayed output is not
   re-parsed per line for narration. The inactivity limit starts after the replay, and a host whose
   disk is full (`journalError`) is waited on, not taken for a silent provider.
5. Stop is his and works at once, replay or not: it closes the input even when a full disk refused
   the interrupt. A Stop requested while no coordinator held the run is sent to the process.

Tool-approval prompts: Claude's print mode asks its host to answer them (`--permission-prompts`
defaults to `host`), and Concierge has never answered them; that gap predates hosts and is unchanged.
A pending `control_request` stays in the journal and is replayed exactly as Claude sent it, by its
own request id, so a later policy that answers them needs no reinitialize handshake to see it. The
design's `reinitialize` (§3.1 step 4) was for recovering missed frames from a cursor; a replay of the
whole record misses none, and Concierge registers no SDK hook callbacks for it to re-register (hooks
are command hooks in `--settings`, held by the unchanged process).

## Codex runs (design step 5)

- **Shared-daemon turns** (the usual kind): the Codex App Server daemon already outlives Concierge.
  Each such run is recorded as an execution with supervisor `codex-daemon` (no host, live at once).
  After a restart the next coordinator follows the turn by its exact thread (the session's bound
  provider id) and recorded provider turn id (`adoptTurn` in `runCodexTurnShared`): it resumes the
  thread, reads its history, settles a finished turn from it or keeps following notifications, and
  never calls `turn/start`. A turn the thread's history never shows is reported unconfirmed after a
  bounded search. Follow-ups that were being sent are decided by the history (`clientId`).
- **Private turns** (a turn bound to one account home, on its own `codex app-server --stdio`): the
  process lives in an execution host like Claude, reached through the same line transport
  (`runCodexTurnStdio` with `transport`). Replay rebuilds thread, turn and progress from the
  predecessor's requests and the server's answers; request ids continue above the predecessor's;
  a server request the record shows unanswered is answered once after the replay; an unfinished
  turn is reconciled with `thread/read`.
- Concierge's Codex turns use `approvalPolicy: "never"`, so there are no approvals to reissue.
- Not yet exercised on a live Codex turn: the server's Codex is signed out (2026-10-07).

## Updates (design step 7)

A running turn holds an update only if it would end with the coordinator. One rule, in
`bot/src/execution-survival.ts`, used by the update gate (`drain-status.ts inspect`), the queue
(`claimNextQueuedTurn`) and the update line (`deploymentWait`):

- **Proof.** A kind of run (provider and supervisor: `claude-code/systemd`, `codex/codex-daemon`,
  `codex/systemd`) counts as surviving only after this machine has recorded one execution of that
  kind whose provider was **still running when a later coordinator took it over**
  (`executions.adopted_live`: a host attach that found no exit, or a Codex thread whose turn was still
  in progress) and that then settled and was released. A run settled from a finished record, a held
  run or a mere claim proves nothing. Until the proof exists the update waits for that kind exactly
  as before. The first proof is the acceptance restart with a marked test run (see below).
- A running turn whose execution is of a proven kind and on an adoptable host protocol is reported
  `continuing`, not `active`: the update does not wait for it.
- While the gate is held, the queue keeps starting turns of proven kinds (not forks), so a new
  message is not held behind the install; other kinds wait as before, and their receipts say so
  (`DEPLOYMENT_HOLD`).
- **Compatibility between the real releases.** `bot/src/host-protocols.json` holds the protocol new
  hosts speak (`current`) and every protocol a release can take back (`adoptable`); the host program
  and the coordinator both read it, and each release answers `drain-status.js host-protocols`. Before
  any candidate is activated (a normal update and a repair's fix alike), its own
  `drain-status.js adoptable-check --running <installed> --rollback <last known good>` requires that
  the candidate adopts every protocol admitted executions speak plus the running release's `current`
  (hosts it may start until it stops), and that the last-known-good release, the one every restore
  path brings back, adopts all of those plus the candidate's `current`. A new protocol therefore
  ships in `adoptable` one release before it becomes `current` (expand, then use); the check refuses
  any other order. It fails closed: both releases are required, and a release whose
  answer is missing, invalid, slow or crashed is unknown and refuses the activation. Only the exact
  usage refusal of a release from before the command is read as its generation: protocol 1 if it
  ships a host, adopting nothing if it does not. The release lint's contiguous-versions rule is authoring hygiene;
  this check is the guard.
- A refusal leaves the running release exactly as it is: the run is recorded as failed and its gates
  released, with no restore, restart or repair handoff (`PREFLIGHT_REFUSED` in `deploy.sh`).
- Taking a host back speaks the protocol that host was started with, read from its status before the
  attach, and refuses a protocol this release does not adopt (the run is held, never treated as dead).
- A shutdown waiting for turns that end with the coordinator re-evaluates whenever an execution
  changes, so a turn that gains its host during the shutdown stops being waited for at once.
- What he sees: while an update waits, the line says how many conversations continue through it
  (`continuing`); after it installs, `executionsOnPreviousVersion` counts running conversations
  whose host program differs in content from the installed one (`host_digest`, sha256 at launch), so
  an update that did not touch the host leaves none on a previous version, and the line reads "Concierge update installed ·
  N finishing on the previous version" until they finish.
- The first release that contains this rule installs at an idle moment as before (the deployment
  runs the previous control).
- Known limits: the capture gate still holds incoming captures in ingress for the deployment's
  duration (unchanged; they are retained and delivered afterwards). The Mac has no host yet.

## Shutdown

Server (`drainAndStop`) waits only for turns that end with the process (`turnsThatEndWithThisProcess`)
and exits; the Mac composition does not cancel hosted turns. Until the update gate is removed (design
step 7) the deployment still waits for idle, so this matters for restarts outside deployments now and
for every update after step 7.

## Compatibility and releases

`ADOPTABLE_HOST_PROTOCOLS` lists every protocol this coordinator can adopt; a run on another protocol
is left running with its record and logged (`execution_host_protocol_unadoptable`), never reported
adopted. `hostProtocolsInUse()` and `releaseFilesInUse()` give a candidate release and any release
cleanup the facts they must respect; releases are not pruned today (250 kept on 2026-10-07). The
preflight that refuses a candidate missing a protocol in use belongs to the deploy-without-gate step.

## Not covered yet

- The Mac (launchd host, Keychain-held Claude homes), Codex runs (shared daemon and private
  stdio): later steps. Codex and Mac runs keep the previous direct child process.
- Forks and legacy Slack turns keep direct child processes.
- `CONCIERGE_EXECUTION_HOSTS=0` returns new runs to direct child processes without touching hosts
  already running.

## Signals

`execution_host_attached` (mode, pids, replayed count), `execution_adopted`, `execution_host_unreachable`,
`execution_host_protocol_unadoptable`, `execution_adoption_failed`, `execution_journal_unreadable`.
`systemctl list-units 'concierge-exec-*'` lists live hosts.
