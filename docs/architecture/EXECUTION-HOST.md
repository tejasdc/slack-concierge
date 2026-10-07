# Execution host

**Status: built for Claude Code runs on Linux (server), 2026-10-07.** The Mac host (launchd), Codex
adoption and update without the drain gate are later deliveries of the same design:
[agent work and updates without waiting](../plans/2026-10-07-agent-work-and-updates-without-waiting.md)
§9 steps 5–7.

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
   synchronous step that starts the replay. Frames are held until this run's writer exists, then
   handed over in order. Frames up to `until` are the predecessor's history: stdout lines carry their
   original receipt time (the adapter's clock, so a background job keeps its age) and the
   predecessor's writes are rebuilt (pending follow-ups, a Stop already sent, a compaction or a
   model switch with its request id). **During the replay the adapter only rebuilds state: it writes
   nothing, closes nothing and registers no steering or Stop.** At the end of the history
   (`onReplayEnd`) it acts once on what is still owed: a continuation owed after a compaction or a
   model switch that the record does not show written (sent with a stable command id), a close the
   predecessor's decision implies, the steering and Stop registrations, and one close-after-result
   evaluation of the final state. Replayed output is not re-parsed per line for narration.
5. A Stop requested while no coordinator held the run is sent to the process after the replay.

Tool-approval prompts: Claude's print mode asks its host to answer them (`--permission-prompts`
defaults to `host`), and Concierge has never answered them; that gap predates hosts and is unchanged.
A pending `control_request` stays in the journal and is replayed exactly as Claude sent it, by its
own request id, so a later policy that answers them needs no reinitialize handshake to see it. The
design's `reinitialize` (§3.1 step 4) was for recovering missed frames from a cursor; a replay of the
whole record misses none, and Concierge registers no SDK hook callbacks for it to re-register (hooks
are command hooks in `--settings`, held by the unchanged process).

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
