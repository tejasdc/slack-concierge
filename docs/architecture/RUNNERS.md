# Runners and the owner on its own app server

**Status (2026-11-04):** built: the agents' network entrance, per-run and per-runner tokens, the
runner lease engine with its routes, and a probe runner. **Not built: turns on runners.** Agent
turns, execution hosts, the shared Codex App Server, provider account homes and checkouts still
live on the owner's machine, so the owner **cannot move to the app server yet**; the remaining
work is "Turns on a runner" below, plus the couplings marked "after the cut" in the inventory.
Decided plan: remote-box `docs/plans/2026-11-04-off-one-server-architecture.md` ("Decisions after
review"), steps 2 and 3.

## Why

Tejas, 2026-11-04: "We should stop using our server as the only machine that everything runs …
What should we run on the server? What could happen elsewhere? And how does the communication
work?" The decided end state is a **control plane** (the Concierge owner: ledger, Inbox, routing,
session catalogue, presentation) on a small dedicated app server, and **runners** (machines with
checkouts, provider accounts and agent processes) that pull work from it. The AX41 becomes the
first runner. The owner must never again share a processor or disk with an agent.

## Today's couplings (inventory 2026-11-04)

Everything the owner assumes because agents run beside it. Each line names where it goes.

| Coupling | Today | After the cut |
| --- | --- | --- |
| Agent helpers → owner | `requests.sock` (file mode 0600 is the only boundary; a source input/run pair is a bearer pair) | the agents' network entrance with a signed run token (built) |
| Hooks run by the shared Codex App Server (no per-run environment) | same socket | a runner token in the App Server's environment on the runner (built: runner tokens) |
| `router-actions.sh channel-id`, `channels-list`, `router-threads`, `router-post` lookups, `todo-add` | open the ledger file directly | owner routes, or retired with Slack (all four are Slack-era) |
| Execution hosts | `systemd-run` on the owner's machine, owner attaches to `host.sock`, reads the journal from disk | started by the runner; journal frames shipped to the owner as sequenced events (below) |
| Shared Codex App Server | started by the owner's unit (`ExecStartPre`), reached over a local socket | started and supervised by the runner |
| Claude transcript watch, provider history, handoff/resurrection writes into `~/.claude` and `~/.codex` | owner reads/writes its own home | runner-side, results sent as events |
| Provider account homes, usage readings, sign-in CLIs | owner's home | runner-side; the owner keeps the allowance decision and receives readings |
| Project folders, worktrees, `git` in checkouts, file watches, artifact folders, links judged by reading files | owner's disk (`/root/workspace`) | runner-side; jobs name a project, the runner resolves its folder |
| Attachments passed by path (`/tmp/concierge-native-*`) | owner writes, agent reads | bytes travel in the job (or by digest from the owner); the runner writes them locally |
| Thinkering capability socket (`/run/thinkering/session-capabilities.sock`) used by agents with curl | local socket | Thinkering's own authenticated HTTPS with the same run token, Thinkering's step 2 |
| Execution host manifest | carries the owner's **whole** environment (including credential paths) until the provider starts | a runner builds the environment from the job; the owner's environment never leaves it |
| `agents.slice`, `CPUWeight=1000`, `/proc` and cgroup reads | protect the owner from agents on one box | unnecessary on the app server; stay on runners for their own accounting |

## Agents reach the owner over the network (built)

- **Entrance:** the owner's front-door process (the foreground gateway, a separate process from the
  owner's main loop) opens a third listener when `CONCIERGE_AGENT_API_LISTEN=<host>:<port>` is set.
  It serves exactly what `requests.sock` serves, except process-control routes, and refuses any
  caller without a valid token before the owner sees the request. Bound on the tailnet like the peer
  listener, its traffic is encrypted by WireGuard; a runner outside the tailnet would reach it
  through a Cloudflare Tunnel hostname with the same tokens.
- **Tokens** (`agent-run-tokens.ts`): HMAC-SHA256 over `{kind, principal, expiry}` with a 32-byte key
  in `$CONCIERGE_STATE_DIR/agent-token.key` (0600). The gateway verifies without opening the ledger.
  - `run`: minted into a turn's environment as `CONCIERGE_AGENT_TOKEN`, only when the owner has a
    network address to give it (`CONCIERGE_AGENT_API_URL`); valid eight days (an execution host
    lives at most seven). Before the cut it must be resolved per turn rather than per environment:
    a shared Codex thread keeps its first turn's shell environment for the thread's life.
  - `runner`: minted on the owner's machine (`POST /runner/v1/token` on the local socket only); valid
    90 days; used by the runner daemon and by hooks without per-run environment. It carries the local
    socket's **full** command authority (session communication, `/external/*`, requests), not only
    the runner routes, because a runner's agents need that authority anyway.
  - A run token can land on the runner's disk (Codex keeps a thread's shell environment in its
    session files). That grants nothing a root reader of that disk lacks today; it matters only
    once a runner is a machine an attacker could read without root, and then rotation applies.
  - Revocation is key rotation (delete the key file; the next start creates a new one). Per-token
    revocation was not built: one operator, short run lifetimes, and the owner still validates every
    action's source input and run against the ledger.
- **What a token authorizes:** what the local socket authorizes today, except process-control
  routes (`/internal/*`, including the event-stream page), which only the local socket serves. The owner's existing source
  checks still decide every action; the token adds a verified principal, forwarded to the owner as
  `x-concierge-agent-principal` (`run:<session>:<turn>` or `runner:<name>`), which callers cannot set.
  A tighter binding (refusing a run that names another run's source) was not added: helpers and
  Codex subagents legitimately act for their parent's run, and agents are never handcuffed beyond
  data and privacy boundaries [decision: agents-are-never-handcuffed].
- **Client:** `router-request-client.ts` uses `CONCIERGE_OWNER_URL` with the token when the run
  carries both, and the local socket otherwise. The owner passes `CONCIERGE_OWNER_URL` only when
  `CONCIERGE_AGENT_API_URL` is configured, and only then mints the run token. On the AX41 it is not:
  agents on the owner's own machine keep the socket, and carry no token, until turns run on runners.

## Runner protocol (built: engine, routes, probe runner)

Records in the owner's ledger (`runner-leases.ts`):

| Record | Meaning |
| --- | --- |
| `runner_jobs` | the work: kind, payload, whether replay is safe, state `queued → leased → finished`, or `unconfirmed` |
| `runner_attempts` | one runner's custody of a job: runner, **epoch**, lease expiry, durable event cursor |
| `runner_events` | the attempt's sequenced events (`seq` from 1), the record a coordinator replays |
| `runner_commands` | commands for the job's runner (submit, close, signal), each with its own id and first result |

Routes (`/runner/v1/*`, runner token required unless noted):

| Route | Rule |
| --- | --- |
| `claim {kinds}` | oldest queued job of those kinds, new attempt at epoch 1, 90 s lease; `job:null` when none |
| `heartbeat {attemptId, epoch}` | extends the lease (runner sends every 15 s), returns unanswered commands |
| `events {attemptId, epoch, events:[{seq, frame}]}` | stores only the contiguous run after the cursor; answers `ackedSeq`; resends store nothing twice |
| `command-results {…, results:[{commandId, result}]}` | the first result per command id stands |
| `finish {…, operationId, result}` | ends attempt and job once; the same operation id repeats the first answer, another conflicts |
| `reacquire {attemptIds}` | a restarted runner takes back its live attempts at a **new epoch**; expired ones are `stale` and must be stopped locally |
| `GET jobs/<id>?attempt=<id>&after=<seq>` (any agent) | a read: job state (a passed lease reported as the state the next transition records), attempts, and one attempt's events after that attempt's cursor (latest attempt unless named) |
| `POST probes {probeId}` (any agent) | queues a marked, replay-safe `probe` job; the runner echoes it |
| `POST token {runner}` (local socket only) | mints a runner token |

Invariants:

- **Fencing.** Every write names the attempt and epoch it holds; anything else is refused
  `STALE_EPOCH` (409). A second copy of a runner daemon, or one that lost its lease, cannot write.
- **Liveness is computed, not swept.** An attempt holds its job only while its lease has not passed;
  each transition first settles passed leases. No timer has to run for an expiry to take effect.
- **A dead runner loses nothing and replays nothing unsafe.** At expiry a replay-safe job (a build,
  a probe) is queued again; any other job (an agent turn) becomes `unconfirmed`, which the
  coordinator settles exactly as it settles a `lost` execution today (interrupted, never replayed).
- **Every effect has its own operation identity**: events by sequence, commands by command id,
  the finish by operation id. Ambiguous external effects are reconciled, never replayed.
- Runners open no port; they poll `claim` every 2 s when idle. With nothing queued and no lease due
  the answer comes from two indexed reads and takes no write lock; a long poll is a later refinement
  if measured worth it.

The runner daemon is `bot/scripts/runner.ts` (`CONCIERGE_OWNER_URL`, `CONCIERGE_RUNNER_TOKEN_FILE`,
`CONCIERGE_RUNNER_STATE`; `--once` for checks). It records held attempts in its own folder and
reacquires them at start (a reacquired probe is left to expire; turn jobs will resume heartbeats).
Today it runs `probe` jobs only.

## Turns on a runner (the cut, with the app server)

The execution host already has the runner's shape: a supervised process, an append-only journal
with sequence numbers, idempotent `submit` by id, attach-with-replay from a sequence, and `release`
only after the coordinator has settled the outcome. The cut keeps that program unchanged and moves
who talks to it:

1. A new turn becomes a `turn` job (not replay safe) whose payload is today's launch manifest minus
   the owner's environment: prompt, folders by project name, model, account label, session ids,
   attachment bytes, the run token.
2. The runner claims it, starts the execution host with `systemd-run` exactly as today, attaches to
   `host.sock` locally, and ships journal frames as events (`seq` = journal sequence). The owner's
   `HostedClaudeCodeTransport` reads the same frames from `runner_events` instead of the socket, so
   adoption, replay and settlement logic stay as written.
3. Steering, Stop and close become `runner_commands`; the runner applies them with `submit`,
   `signal` and `close`, whose host receipts are the command results. `release` is a command sent
   only after the owner durably settles the turn, as today.
4. The shared Codex App Server, transcript watch, account homes and project checkouts move to the
   runner side of this line; the owner receives their observations as events.

The cut is not built yet because on a single machine it adds a hop and a second custody path with
nothing gained; it is the work that makes the CCX23 move a deploy.

## Heavy work out of the owner's request loop

The repair agent's ranking of today's owner stalls (1,202 s of lag over the day): Inbox thread upkeep
(`forwardedReplies`, 213 s), session event transactions (160 s), non-storage JavaScript (73 s), the
ghost-turn sweep (62 s), the running-sessions brief (46 s), provider message projection (40 s).
Measured on a quiet moment with Bun's SQLite, the two `forwardedReplies` statements take 2-8 ms on
the existing partial indexes: the stalls are mostly the host's CPU and disk contention, which the
move removes. What still leaves the request loop with the move: provider message projection and
transcript ingestion run on the runner and arrive as events; the presentation worker already runs
apart. Re-rank on the app server from `owner_event_loop_lag` before moving more.

## Step Functions Activities versus the ledger lease engine

Objective: a lease engine whose custody survives runner death and owner restarts, at one operator's
scale, without a second source of truth for obligations.

| | AWS Step Functions Activities | Lease engine in the Concierge ledger (chosen) | Do nothing (local hosts only) |
| --- | --- | --- | --- |
| Claim and lease | `GetActivityTask` long poll (60 s), task token | `claim` with epoch and lease | n/a |
| Heartbeat and expiry | `SendTaskHeartbeat`, `HeartbeatSeconds` → `States.Timeout` | `heartbeat`, computed expiry | n/a |
| Commands to a running worker (Stop, steering) | none: the API is worker → service only | `runner_commands` on heartbeat | local socket |
| Sequenced event stream with durable cursor | none; task input/output limited to 256 KiB per quota page | `runner_events` | local journal |
| Fencing at Concierge's data APIs | must be built anyway | built in | n/a |
| Source of truth | a second one (execution state in AWS beside the ledger, kept consistent by an outbox) | the ledger | the ledger |
| Cost | about $7/month at 60k turns, plus AWS credentials on every runner | no new service | none |
| Survives a runner machine's death | yes | yes | no: the journal dies with the box |

Step Functions would supply only claim, heartbeat and timeout, the smallest part; commands, the event
stream and fencing are needed regardless, and it adds a second authority for the same obligation.
Sources: [GetActivityTask](https://docs.aws.amazon.com/step-functions/latest/apireference/API_GetActivityTask.html),
[SendTaskHeartbeat](https://docs.aws.amazon.com/cli/latest/reference/stepfunctions/send-task-heartbeat.html),
[service quotas](https://docs.aws.amazon.com/step-functions/latest/dg/service-quotas.html) (the
256 KiB and 1 MiB payload figures disagree between the API reference and the quota page).

## Moving the owner (after turns run on runners)

0. Build "Turns on a runner" and run the AX41's turns through it while the owner is still on the
   AX41; only then is the move a deploy.
1. On the app server: install the release, restore the ledger and presentation store, set
   `CONCIERGE_AGENT_API_LISTEN` to its tailnet address and leave out the Codex App Server
   `ExecStartPre` lines and `agents.slice` settings.
2. On the AX41: run `runner.ts` as a service with a runner token; set `CONCIERGE_AGENT_API_URL` on
   the owner so runs carry the network address and their tokens.
3. Thinkering's capability socket moves behind Thinkering's own HTTPS entrance (its step 2).

## Checks

- `bot/scripts/agent-entrance-check.ts`: the real gateway refuses missing, malformed, forged and
  foreign-key tokens before the owner, forwards run and runner principals that callers cannot spoof,
  keeps process control unreachable, and the agents' client takes the network path.
- `bot/scripts/runner-lease-check.ts`: claim, contiguous events, commands, epoch fencing, computed
  expiry (turn unconfirmed, build requeued) and idempotent finish.
- Live, 2026-11-04 on release 75faaa3d: over `100.118.245.110:8789` a call without a token got 401,
  the token route 403 and a process-control route 404; probe `probe:live-8623-20261104` was queued
  and run by the installed `runner.js --once` with an `ax41` runner token: one attempt at epoch 1,
  events `started` and `echo` acknowledged to sequence 2 (a resend stored nothing), job `finished`.
  `router-actions.sh sessions get` with only `CONCIERGE_OWNER_URL` and a token (no local state
  folder) answered through the entrance.
