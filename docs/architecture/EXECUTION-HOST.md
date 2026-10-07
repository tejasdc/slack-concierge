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
recorded before it is written), `o` one stdout line, `e` a stderr chunk, `c` a control fact (close,
signal, write failure, release, host exit), `x` the provider's exit `{code, signal, at}`.

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
| `release {id}` | refused while the provider runs; afterwards the host exits |

A full disk stops reading the provider (backpressure) and is reported in `status`, never a dropped frame.

## Coordinator states

`executions.state`: `intended` (recorded before `systemd-run`) → `live` (unit started) → `exited`
(the `x` frame was consumed) → `released`; `lost` when startup finds no answering host. Adoption
changes `turns.owner_instance_id` and `executions.coordinator_instance_id` in one transaction and
counts `adoptions`; it never increments the dispatch attempt or clears an acknowledgement.

## Taking a run back (adoption)

At startup, for each open execution of a still-running turn whose coordinator is dead and whose host
answers its exact execution id:

1. The turn is claimed for the new coordinator (same dispatch attempt), before steering recovery and
   turn recovery run, so neither reads it as orphaned.
2. Follow-ups the old coordinator had queued but not written fail back to their queue (provably
   unsent); one it was writing is decided by the journal: written means Claude's pickup decides it.
3. The run re-enters the same native execution path (`SessionExecutionHost.run(claim, adoption)`),
   with the exact prompt, folders, model, account and session id stored at launch in
   `executions.processor_json`, and a transport in `adopt` mode.
4. The transport attaches from sequence 1. Frames up to the host's sequence at attach are a replay:
   stdout lines carry their original receipt time, which the Claude adapter uses as its clock, so a
   background job keeps its age; the old coordinator's writes are rebuilt (pending follow-ups, a Stop
   already sent, a compaction or model switch in flight). Replayed output is not re-parsed per line
   for live narration. Then live frames continue.
5. A Stop requested while no coordinator held the run is sent to the process, not answered without it.

A host that does not answer leaves the run to ordinary recovery: interrupted and unconfirmed, never
replayed. The original input is never resent.

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
