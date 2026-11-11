# Runners and the owner on its own app server

**Source state (2026-11-06):** the agents' network entrance, runner lease engine and authenticated
relay carry Claude Code turns, Codex App Server traffic, runner machine calls and watches. The
service configures new Claude, Google and outside-Codex execution for `ax41`, and uses the Codex
App Server supervised there. Existing conversations retain their recorded machine; an unavailable
runner fails the affected action without making owner startup wait for it. Provider homes, history
and project work use runner operations described below. Concierge's own thnkr.ing calls use
thnkr.ing's network entrance. Installed and live proof is recorded separately in the acceptance
cards below; moving the owner to its own app server is a later deployment operation.

The first Codex runner candidate failed owner startup on 2026-11-04 and was rolled back. The
repaired order gates Codex readiness per turn, not at owner startup. A Claude runner turn survived
the 2026-11-05 owner restart (execution `b212ed3c76cd9766`). Command and file watches run on the
registering agent's runner. The AX41 runner starts and supervises its Codex App Server, and new
Codex threads' shells name the runner's folders. Historical threads keep the shell settings they
started with.
Decided plan: remote-box `docs/plans/2026-11-04-off-one-server-architecture.md` ("Decisions after
review"), steps 2 and 3.

## Why

Tejas, 2026-11-04: "We should stop using our server as the only machine that everything runs …
What should we run on the server? What could happen elsewhere? And how does the communication
work?" The decided end state is a **control plane** (the Concierge owner: ledger, Inbox, routing,
session catalogue, presentation) on a small dedicated app server, and **runners** (machines with
checkouts, provider accounts and agent processes) that pull work from it. The AX41 becomes the
first runner. The owner must never again share a processor or disk with an agent.

## Original couplings (inventory 2026-11-04)

Everything the owner assumes because agents run beside it. Each line names where it goes.

| Coupling | Today | After the cut |
| --- | --- | --- |
| Agent helpers → owner | `requests.sock` (file mode 0600 is the only boundary; a source input/run pair is a bearer pair) | the agents' network entrance with a signed run token (built) |
| Hooks run by the shared Codex App Server (no per-run environment) | same socket | a runner token in the App Server's environment on the runner (built: runner tokens) |
| `router-actions.sh channel-id`, `channels-list`, `router-threads`, `router-post` lookups, `todo-add` | open the ledger file directly | owner routes, or retired with Slack (all four are Slack-era) |
| Execution hosts | `systemd-run` on the owner's machine, owner attaches to `host.sock`, reads the journal from disk | started by the runner; journal frames shipped to the owner as sequenced events (below) |
| Shared Codex App Server | started by the owner's unit (`ExecStartPre`), reached over a local socket | started and supervised by the runner (built 2026-11-05) |
| Claude transcript watch, provider history, handoff/resurrection writes into `~/.claude` and `~/.codex` | owner reads/writes its own home | runner-side, results sent as events |
| Provider account homes, usage readings, sign-in CLIs | owner's home | account identity, readings, sign-in and Codex reset-credit calls run on the selected runner; owner retains account selection, usage ledger and allowance holds |
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
| `claim {kinds}` | oldest queued job of those kinds, new attempt at epoch 1, five-minute lease; `job:null` when none |
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
reacquires them at start. It runs probe, turn, project setup and peer placement jobs; its
authenticated relay also serves Codex App Server traffic and bounded machine calls.

## Turns on a runner (built for Claude Code turns)

The execution host program is unchanged; what moved is who talks to it. The coordinator reaches a
host through one interface (`host-access.ts`) with two places: **local** (systemd or launchd on the
owner's machine, socket and journal on its disk, exactly as before) and **runner**
(`runner-host-access.ts`). Every custody rule in [execution host](EXECUTION-HOST.md) (adoption,
replay with recorded write outcomes, held runs, settlement from a record, release only after
settlement) is written once against that interface, so both places follow it.

What happens for a turn on a runner:

1. The owner records the execution (`executions.supervisor = 'runner'`, no folder) and queues a
   `turn` job (not replay safe) whose payload is the launch manifest: provider command name, args,
   project and relative subfolder, provider account label, the run's own variables (identity,
   run token, model settings), the opening input, attachment bytes, and the host protocols the
   owner adopts. The runner resolves its own project folder and account home. The owner's own
   environment is not in the job.
2. A turn bound to a runner carries that runner's name in its queued job. The lease engine only
   offers it to that runner, so a later turn cannot move away from its account and transcript.
   The owner's `CONCIERGE_TURN_RUNNER` names the current Claude target; the Codex relay target is
   configured independently. A runner claims it within two minutes (`CONCIERGE_RUNNER_CLAIM_MS`), or the owner withdraws the
   still-queued job in one statement. The ordinary claim-timeout path parks the turn for custody
   reconciliation after its admission intent; only the owner-drain withdrawal in step 7 returns
   the turn unsent. The runner writes the
   attachments, finds the provider command on its own `PATH`, builds the environment from its own
   (its state folder, its release's helpers, its address for the owner, `THINKERING_CAPABILITY_URL`
   when set) plus the run's variables, and starts the host under its own systemd. A command it
   cannot find, a missing folder or a host protocol the owner does not adopt is its definite
   refusal (`notStarted`), which the owner treats like a host that never started.
   If the runner's project call channel is temporarily absent before provider admission, the
   owner requeues that exact unsent turn with ordinary dispatch backoff; it does not fail the input
   or try the owner's workspace. A runner-side credential or paid-credit preflight refusal is
   returned as `notStarted` before the host launches, so the lease can settle without waiting for
   an attachment that will never arrive.
3. The runner reports `attached` (protocol, pids), then ships every journal frame as an event
   (`{k:'host', f, h}`; `h` is the highest host sequence shipped). The owner's link reads them from
   `runner_events`, woken in-process when a runner write commits (`runnerActivity`), so replay and
   live frames reach `HostedClaudeCodeTransport` as they did from the socket.
4. Submit, close, signal, status and release are job commands; the runner applies each through the
   host's socket with the same id and returns the host's receipt as the result (a host refusal is a
   result; a lost connection is not, and the command is offered again). Claude's transcript is
   followed on the runner (`watch-transcript`) and pickups come back as events.
5. **One call per runner, not per turn:** every half second the runner sends one `sync` carrying each
   held turn's new events; the owner stores them, extends each lease once it is a heartbeat old and
   answers each turn's unanswered commands, all in one transaction. An attempt the runner no longer
   holds is refused alone.
6. After the owner settles the turn it sends `release`; the host exits; the runner stores the last
   events and finishes the job. A runner restart reacquires each held turn at a new epoch, resumes the
   host journal after the last stored `h` and keeps going. A lease that passes makes the job
   `unconfirmed`: the owner settles it from the provider's recorded exit if the events hold one, or as
   lost (interrupted, never replayed); a runner whose attempt is refused stops that host.
7. **Fencing both ways.** Leases last five minutes. A runner that has not reached the owner for four
   minutes stops its agents itself, so no agent acts after the owner could have settled its turn as
   lost and a later turn resumed the conversation elsewhere. At its start the owner extends every live
   lease from now, so its own downtime never counts against a runner. A later owner withdraws a job
   no runner claimed yet, holds a claimed job until its runner reports the host, and records a
   takeover as live (survival proof) only once the runner reaches it after the takeover.
   A runner process restarted after four minutes without contact stops those agents before taking
   its turns back. "Without contact" is measured from the later of the turn's claim and the
   runner's last successful sync (its `owner-contact` file), never from the claim alone, so a turn
   of any age the owner was still hearing from survives a runner restart. An owner outage longer than four minutes therefore still ends runner agents (now
   by the runner's own stop). Every turn fenced at one moment is stopped in a single `systemctl stop`
   (systemd stops them together), and each only once, so the next attempt to reach the owner waits
   for one bounded stop instead of one stop per turn (2026-11-05 failure record below).
8. **Deadlines that need no live runner.** The runner records each time it reaches the owner (a
   claim, a sync, a reacquire) in `owner-contact` in its state folder, and every host it starts
   reads that file (`ownerContact` in the launch manifest): once the last contact is older than the
   fencing time, the host journals a `SIGTERM` and stops its provider itself (and `SIGKILL` 30 s
   later if it has not exited), so a runner that died and stayed down cannot leave an agent acting.
   A runner whose sync is answered 404 is talking to an owner without the sync route (a rollback to an
   older release, which has already settled these turns as lost) and stops its agents at once instead
   of after the fencing time; the current owner never answers 404 there. A rollback to a release
   without the agents' entrance at all (before 01d246f6) refuses the connection, so only the fencing
   time covers it. A runner rolled back to a release that does not write `owner-contact` leaves hosts
   started by this one to stop their agents at the fencing time. At its start the owner extends only leases whose runner was heard from within the
   last lease, so restarting the owner repeatedly cannot keep a dead runner's turn open; a lease
   never outlasts its runner's last contact by more than two lease lengths.

Survival through owner updates uses the existing rule: `claude-code/runner` counts as surviving only
after one such run was taken over live by a later owner. Until then updates wait for runner turns.
On runner reacquisition, Claude transcript watches resume only after that runner resolves the
turn's saved account home. If it cannot resolve the home, it keeps the hosted turn attached but
refuses a watch instead of reading the runner's default Claude home.

### Side questions and resurrection

Runner-bound side questions and resurrected conversations now resolve their project and provider
account on the runner. The owner sends a bounded side-question job or archived transcript through
the authenticated machine relay; the runner reads its provider home and starts the private fork
there. Older Claude sessions use their saved Claude account label; if that identity is absent, the
runner refuses instead of launching with an empty home. When the chosen side-question account
shares the same physical project history, the runner uses the fork in place and avoids copying the
file onto itself. Resurrection records the chosen runner and account with the new conversation so
a later turn cannot silently resume against the owner's home. Distinct or missing provider history
copies refuse continuation. Local-only peer conversations keep their existing local restore path.
For side questions, the runner keeps one saved native fork in the source provider home per source
conversation. Its manifest records the last completed final-answer boundary and fork identity.
Every question reads that fork without saving its own turn. A running main turn leaves the
boundary unchanged. A newer completed final answer makes a new fork and removes the old one;
Codex forks pin `lastTurnId` to the owner's completed provider turn before any question starts.
Codex's App Server holds the saved fork's writer; each question therefore uses an ephemeral fork
from the saved copy in a read-only sandbox, leaving the reusable copy untouched. The observed
[writer conflict](../incidents/2026-11-07-codex-side-copy-writer-conflict.md) records why.
Codex's source transcript filename includes a timestamp before the UUID. The runner resolves that
exact UUID at the filename's end in its credential-verified homes, then requires one physical match;
the marked side-question failure and repair are recorded in
[the November 7 case](../incidents/2026-11-07-codex-side-question-runner-could-not-find-source.md).
Native forks use the same saved runner, account and project binding. The owner sends the native
conversation ID, exact turn boundary, stable fork source and project identities; the runner resolves
its own account home and project folders before asking Claude Code or its local Codex App Server to
fork. The new conversation records the fork's exact runner and account; a parent explicitly bound
to local keeps that binding, while an older parent with no binding keeps its lineage for the next
turn to resolve. Codex forks check the daemon's account without changing its login while
another turn may be running. A daemon account mismatch is a definite refusal before any fork;
the control turn settles as failed rather than uncertain. Recovery searches that exact runner and account for a matching Codex fork. A lost runner
answer remains uncertain instead of starting an owner-local fork. Check with
`bun bot/scripts/runner-provider-fork-check.ts`.

The original [same-machine inventory](../plans/2026-11-05-owner-off-agent-machine-remaining.md)
records why these paths existed. Account and project dispatch, Google, outside Codex, held-usage
probes, auth holds, Codex repair and hook settings now use the runner operations below. Source checks
use separate owner and runner roots. The AX41 still shares its filesystem with the current owner,
so an installed check there cannot by itself prove physical disk isolation; moving the owner to the
app server is the final deployment step for that property.

## Codex App Server on a runner (built, off until `CONCIERGE_CODEX_RUNNER` is set)

Codex turns do not use a per-turn host: one long-lived Codex App Server holds every thread, and
Concierge talks JSON-RPC to it over a WebSocket on its local control socket through a small Node
bridge (`codex-app-server-bridge.mjs`). Custody already rests on that daemon (a later owner follows a
turn by its thread and turn id), so moving it only changes where the bridge's WebSocket ends:

1. The runner keeps one outbound WebSocket open to the agents' entrance,
   `/runner/v1/relay/listen`, with its runner token (`runner.ts`, job kind `codex` in
   `CONCIERGE_RUNNER_KINDS`, on by default). A run token is refused; the newest channel per runner wins.
2. With `CONCIERGE_CODEX_RUNNER=<runner>` on the owner, every App Server client (turns, the session
   observer, history workers, device sign-in) starts the same bridge against the owner's
   `requests.sock` at `/runner/v1/relay/connect?runner=<runner>&target=codex-app-server`.
   Runner-owned account activation also opens this bridge to prove the new App Server login. Its
   executable is deeper in the sealed release than the owner's application bundle; the bridge
   lookup walks to that release's manifest, and candidate validation checks the runner entry
   before activation. The [November 6 failure record](../incidents/2026-11-06-runner-account-switch-lost-bridge.md)
   records the queue impact when that lookup used the owner's fixed depth.
3. The gateway (`runner-relay.ts`, inside the front-door process, no ledger) asks the runner over its
   channel to open `/runner/v1/relay/accept?id=…`; the runner opens a fresh connection to its own
   App Server socket and the gateway pairs the two. Messages pass unchanged and in order, including
   the bridge's own `initialize`. Up to 16 MB sent before pairing waits in the gateway.
4. Either end closing closes the other, and a runner that does not accept within 15 s ends the
   relay. The App Server client already treats a dropped bridge as an ambiguous disconnect and
   reconnects, which is a new relay. Idle sockets are pinged every minute, so a runner that vanished
   is noticed instead of leaving a dead listener.
5. **The runner supervises its App Server; the owner starts none.** At the runner's start, and when a
   relay finds nobody listening, it starts one (`codex app-server daemon start`, in a scope in
   `agents.slice`, after restoring the private control and daemon folders and only with Codex's
   updater off) under the runner's own environment. Whoever started it, the first relay each half
   minute lifts its open-file limit and moves it into a scope of its own, as the owner did on every
   connection before. The owner's unit no longer runs `daemon start` (2026-11-05).
   **A Codex thread names the runner, never the owner** (`runner-machine.ts`): the owner sends a
   thread's shell settings without its own folders (`withoutMachinePaths`), and the runner fills in
   its own on the way through the relay: its helpers first on `PATH`, its state folder, release, Bun,
   name and `CONCIERGE_RUNNER_STATE`. Where the owner is lives only in the runner's
   `connection.env` (owner address, token file, thnkr.ing address), rewritten at each runner start
   and read by `router-request-client.ts` and `scripts/thinkering` on every call, because a thread
   keeps its first turn's shell settings for life and an address written there would outlive the
   owner's move. A `turn/start` passing through pins that thread's hooks to the runner's release
   (`<runner state>/hook-pins/codex/<thread>`, kept eight days), which the machine's hook wrappers
   read before the owner's pins. The owner still files its own pin, read only by an App Server
   its unit started (the AX41's until its next restart); off the AX41 nothing reads it. Only owner-to-App-Server
   messages are inspected, by a substring test before any parse; the streamed answers pass untouched. A run's own token and owner
   address are kept out of a Codex thread's shell settings, because a thread keeps them for its life,
   past the token's expiry and the owner's move. Codex helpers therefore act as `runner:<name>`; the
   owner still checks every action's source input and run. This substitutes the runner token for the
   per-turn token the plan asked for: any Codex shell on that runner holds the runner's full
   authority, including claiming its jobs and opening its relay channel (which carries every
   session's Codex traffic). A root agent on the runner could read the token file anyway, so this
   widens nothing on a machine where agents are root; a per-turn exchange (runner token plus
   `CODEX_THREAD_ID` for the current turn's run token, as the commit-provenance hook resolves its
   turn) is still owed before a runner hides its token from agents.
6. Backpressure: a side that stops reading past 64 MB is disconnected (`closeOnBackpressureLimit`),
   and a message Bun refuses ends the relay; nothing is dropped silently.
7. **Owner drain.** After stopping new turn claims, the owner withdraws its still-queued runner turn
   jobs before it waits for active turns. A launch crossing that sweep withdraws its own queued job
   before waiting for a claim. Withdrawal is conditional on `queued`, so a runner that already
   claimed a job keeps custody and the existing adoption and fencing rules apply. The withdrawn
   launch reports not-started, and the owner clears that attempt's admission intent and requeues
   its exact turn as proven unsent for the next owner. The drain also stops the front door taking
   new connections but keeps open relays (`stopListening`; Bun's graceful stop leaves upgraded sockets working). A Codex turn's
   relayed App Server connection therefore lives until the owner closes its App Server client as its
   last step, exactly as the local socket does, and the next owner follows the turn by thread and turn
   id. Only then are the relays and listen channels closed (`closeRelays`), so the final stop is
   never held by them. `codex-relay-check.ts` holds a relayed connection through the first step.

**Startup order.** Codex readiness never holds or fails Concierge's startup. Recovery claims
surviving Codex turns immediately; every Codex turn, adopted or new, then waits at one readiness
gate before connecting to its App Server. A new turn waits before provider admission and execution
intent. On owner drain that turn's wait ends and its exact input returns to the queue as proven
unsent; an already recorded execution remains with its host for adoption. A human Stop requested
during an ordinary readiness wait is held and takes effect when Codex answers. The gate opens when a
`model/list` probe answers. The probe starts with the first Codex turn or with the startup
readiness phase, whichever comes first. It retries through any error (a missing request socket,
the relay's 503 for an absent runner channel, a down App Server) with a backoff of up to 15
seconds, and logs `codex_app_server_unready` at most once a minute. Claude work, the request API
and everything else run normally meanwhile. The deployed health probe still reads the service's
runner setting and checks that route: it can reject a candidate, but Concierge stays up. The
service sets `CONCIERGE_CODEX_RUNNER=ax41` again now that a failed Codex probe cannot stop the
owner. On 2026-11-05 each failing owner had exited about 0.1 s after its gateway opened, while the
runner retries its listen channel every 5 s, so the channel could not reconnect before the exit.

## Agent session commands

The session command named in agent instructions resolves to the wrapper installed in that
machine's `~/.local/bin`, outside release directories. The owner sets this path for local
provider turns; a runner replaces the owner's machine path with its own before launching a
Claude turn or relaying a Codex thread. The wrapper routes server session commands to the
current installed command parser. A release's `control/bot/scripts` contains the parser and
other helpers, but no `router-actions.sh` wrapper. See the [missing command path failure
record](../incidents/2026-11-06-injected-session-command-path.md).

## Agents' thnkr.ing calls

Agent wording (canvas think-aloud, the `--todo` hint) names the release's `thinkering` helper
(`bot/scripts/thinkering`, on every run's `PATH`): curl with its own arguments, where a URL written
`http://x/<path>` goes to thnkr.ing. With `THINKERING_CAPABILITY_URL` set (runner turns and the
runner's Codex App Server) it uses thnkr.ing's network entrance with `CONCIERGE_AGENT_TOKEN`, or the
runner token file in a Codex shell, sent from a private header file; otherwise the local socket. The
Mac keeps `ssh remote-box curl --unix-socket …`, and thnkr.ing's own rendering of the think-aloud
text keeps its socket (`capabilityCommand` is optional). The wording keeps the socket command as a
fallback because a Codex conversation keeps its first turn's `PATH`, which may name a release
without the helper. The address and token file come from the runner's `connection.env` when the
shell names a runner. A shell with no run token (a Codex thread) uses thnkr.ing's socket whenever it
exists on that machine, because thnkr.ing identifies the session from the calling process there; over
the network such a call would carry only the runner token. Known cost, on a runner without
thnkr.ing's socket only: thnkr.ing records a call made with the runner token as
`runner:<name>` with no session, so a Codex shell's calls that carry no `X-Concierge-Agent-Source`
(board reads, `/todos/tasks`, `/app/*` routes that fall back to the caller's session, Canvas page
inspection) lose session attribution; calls that carry the source header are verified by it as before.
The per-turn token exchange (item 5 under "Codex App Server on a runner") removes this.

**No ledger on a runner.** A runner turn and, since 2026-11-05, a relayed Codex shell name the
runner's state folder, so helpers that open the ledger file directly (`scripts/ledger-read.py` with a
bare name, `router-actions.sh threads`, `trigger`, Slack channel-name lookups, `todo-add`) do not find
one there; `ledger-read.py` says so and takes the owner's database by absolute path where it is on
the same machine, and `todo-add` refuses rather than creating an empty ledger.
thnkr.ing's nightly report audit and repair commit hook also read that file directly. A runner turn
uses `router-actions.sh reports window <since-UTC> <until-UTC>` for the accepted in-app report
captures, their linked dispatches, settlement, and thread-post state; it uses
`router-actions.sh reports chain <input-or-request-id>` for the exact input ancestry, carried report
files, Inbox request links and each step's exact words; `router-actions.sh reports capture <captureId>`
reads one cited capture's exact words by ID. All three are authenticated reads through the agents' entrance. The owner
executes the bounded database work in its isolated read process, returns an explicit error when the
owner or range is unavailable, and never treats a missing runner ledger as an empty report window.
The source chain retains the immediate sending input for authority and returns Inbox request source
captures separately: one dispatch can serve several human requests in different topics. The two
thnkr.ing readers switch to these commands in their own project; until then, they still cannot
audit or enforce report citation from a runner.

Why a relay and not the job protocol: the App Server's traffic is a live connection with many
streamed notifications, not obligations; carrying it through `runner_events` would write every token
delta into the ledger the move is meant to relieve, and add half a second per request. The relay
stores nothing and keeps the App Server's own protocol end to end. Why not a port on the runner:
runners open none (decided plan, "How the parts talk", 3).

Current Codex migration limits:
- The post-turn leftover-process audit uses `codex.leftoverProcesses` and `codex.processAlive`
  on the runner that hosts the App Server. The owner retains the audit intent, sightings, grace
  period and Inbox report; a lost runner call leaves the intent or sighting open for retry.
  The Codex Remote observer remains separate from this native-turn audit.
- One relayed message is limited to 64 MB, the same as the backpressure limit.
- Threads started before 2026-11-05 keep the owner's folders in their shell settings for life; they
  work on the AX41, where those folders exist, and only there. The AX41's running App Server was
  started by the owner's unit and keeps the owner's environment (its hooks read the owner's pins)
  until it is next restarted, which the runner then does under its own.

## Runner machine calls

Some of the owner's work is a question to an agent's machine, not an obligation: read a path, start
or ask after a watched command. These ride the relay the runner already keeps
open (target `runner-machine`, `runner-machine-calls.ts`): the owner opens one WebSocket per runner
on its local request socket, the gateway pairs it with the runner, and each call is one JSON message
`{id, method, params}` answered by `{id, result}` or `{id, error}`. Nothing is stored and nothing is
resent: the ledger keeps every decision, and a call that cannot be answered (runner away, channel
dropped, 15 s timeout) is not knowing this time, as with a local host that does not answer. The
runner answers with the same functions the owner uses for its own machine, under the runner's state
folder and release; a host record outside the runner's own `exec` folder is refused.

Why not the job protocol: these are reads and idempotent starts the owner already records and
retries per poll; leases, events and fencing would add ledger writes to every five-second watch poll.
Why not a port on the runner: runners open none.

### Provider accounts on runners

`runner-provider-accounts.ts` is runner-safe: it reads that runner's credential files, provider
CLIs and session folders; it does not import the owner's SQLite or usage ledger. The owner asks for
`accounts.identity` and `accounts.readings`; the response contains account identity labels and
usage snapshots. The owner stores runner-tagged readings, chooses accounts and enforces holds;
when the configured runner is unavailable, its prior snapshot remains visible with its original
timestamp and cannot be refreshed from the owner's credential files.
Claude identity requires the exact selected account label. The runner verifies that label against
its own saved home and returns no identity when the label is absent or maps to multiple homes; it
never treats the runner's default `.claude` folder as the selected account. A newly filed Claude
sign-in links the machine-shared settings, instructions, hooks, skills and project history into
that account home while keeping credentials and other per-login files separate. Conflicting
private shared files are retained under `.unlinked-*` before the shared link is installed.
When claude-swap's separate saved copy reports a sign-in problem, the runner reads allowance
from the exact home it launches. A successful provider read from that home clears the stale
claude-swap warning for the Accounts view and dispatch. The read is cached for five minutes per
credential version; a newly filed login bypasses that cache.
The runner resolves a provider account label to its own verified home before launching Claude Code.
Home paths stay on that machine. `accounts.transcript` reports `unique`, `shared`, `missing` or
`ambiguous` for an exact provider session UUID. `shared` means Claude account homes expose the same
physical transcript; it returns no account label. Before continuing that transcript, the owner
chooses its selected Claude account and asks the runner to validate that exact label. Distinct
physical copies remain ambiguous and refuse continuation. Content-only authored-subject and
worktree reads may deduplicate a shared physical file, but return no account identity and do not
authorize provider execution.

Interactive sign-in uses `accounts.signin.start`, `.status` and `.complete`, keyed by one stable
operation ID. A start returns the provider's one-time link and, for device sign-in, its code; the
runner's durable journal stores only the operation ID, provider, outcome and account label. It never
stores the link or pasted code. Retrying a start or completion with the same ID returns the recorded
operation outcome and does not launch or submit twice. A different active sign-in for the same
provider is refused. If the runner restarts during sign-in, the pending operation becomes
`interrupted`; the caller must start a new operation. If the runner is unreachable, the call has no
answer and its outcome is unknown until the same operation ID is queried again.
When runner readings or an exact runner turn refusal show a saved Claude login has stopped working,
the owner creates the existing Mac-browser renewal request for that account; it does not try the
owner's local Claude home. A Codex turn refusal likewise names the account that actually ran.

The owner stores only the selected runner, operation ID and optional saved profile ID in its
pending sign-in row. After an owner restart it asks that same runner for the operation's status;
it does not start a local provider CLI. A completed Codex login is activated under the owner's
Codex admission hold, then the owner refreshes its usage ledger. Claude selection stores a stable
account label; each remote Claude turn sends that label and the runner resolves its own home.
Codex reset-credit redemption also runs on the runner after the owner sends the account label and
a one-use operation ID. The runner returns its provider outcome; the owner remains responsible for
clearing stale usage evidence and releasing held work only after a confirming reading.

Codex account activation uses `accounts.codex.activate` with an operation ID. The owner wrapper
holds Codex admission under that activation's identity and refuses the switch while an active-turn
count is nonzero or unreadable, including turns observed from another Codex client. App Server
re-home has a separate admission holder, so settling or deferring one operation cannot release the
other operation's hold. The owner serializes account switches and re-homes through one restart
queue; the runner also refuses a switch during a re-home and a re-home during a switch. A `busy`
reply means the runner started no new replacement. A first attempt releases only its own holder;
after a lost reply, the durable holder stays until the runner proves the App Server's account and
runner environment. A call that failed before sending leaves no replacement to reconcile. The
runner checks an already managed, same-account App Server without requiring all hosted turns to
finish; only a stop and restart needs an idle runner.
The runner holds its App Server auto-start, moves only credential files, restarts its own daemon and
asks that daemon to refresh and report the requested account. It rolls back on a definite failure;
an unconfirmed rollback is durably `uncertain` and blocks another switch until reconciled. Repeating
an operation ID returns its recorded result. The owner uses a timeout long enough for the runner's
restart and account probes; if the relay answer is lost, it keeps Codex admission held and retries
the same operation ID until the runner reports a settled result. A runner-reported uncertain state
keeps admission held for inspection. The dispatcher also exposes
`accounts.codex.resetCredit`; the runner validates a unique account home and runs the provider's
own redemption protocol there.

Google/Antigravity turns can target the configured turn runner. The owner stores the selected
runner and account label; the runner starts its own `agy` executable and checks its own
`~/.gemini/antigravity-cli/settings.json` before launch. If the setting is unreadable or
`useG1Credits` is true, dispatch refuses before starting the provider, so a runner cannot silently
spend paid credits. `accounts.google.readings` reads quota and account identity on that runner;
the owner stores the runner-tagged result and keeps the allowance ledger. Provider identity for a
new Google session is recorded from the runner's reading, not from the owner's local profile.

For Claude turns explicitly marked for a runner while `CONCIERGE_TURN_RUNNERS=marked`, the runner
identity and account home are resolved on that machine. A marked turn never sends a profile label
from the owner's current account selection without runner validation. The shared owner usage view
continues to describe its configured provider source; per-session runner placement is retained in
the session binding.

When a runner owns Codex or Claude credentials, the owner's auth-held watcher does not watch or probe
the owner's credential files. It polls the exact runner's identity and a fresh account reading; only
a matching, signed-in reading clears the owner's auth hold. A failed or stale runner answer keeps the
hold. Codex App Server repair is also sent to the selected runner: the owner first holds new Codex
admission and checks its own active/external turn records, then the runner refuses while it owns any
turn. For a managed server whose exact socket listener lacks the runner-state environment, the
runner uses Codex's supported daemon stop command, starts it in the runner's own scope, and verifies
the same account, managed backend and runner-state environment before reporting repair. It keeps the
existing exact-listener stop path for unmanaged servers. An unreadable listener or failed proof
stays uncertain; the runner does not switch the account. This call is asynchronous to owner startup;
an unreachable runner does not gate startup.

Offline acceptance state card (source and isolated runner fixtures, not a live runner):

- Verified in isolated fixtures: exact provider/account identity resolves from runner-owned homes,
  shared Claude transcript links identify one physical file without choosing its account, distinct
  copies stay ambiguous, and content-only readers deduplicate the shared transcript.
- Verified: duplicate sign-in start with the same operation ID returns the original outcome and
  does not start another CLI operation.
- Verified: the isolated sign-in check has no provider CLI available and reports a bounded failure;
  no owner-side sign-in fallback is attempted by the remote route.
- Unknown: provider-native interactive sign-in, owner restart recovery against a live runner,
  Codex App Server account activation or same-account re-home, reset-credit redemption, and held-work release after a
  fresh live usage reading have not been exercised on AX41. Google quota parsing, runner-side
  paid-credit refusal and Google turn execution have not been exercised against AX41's real `agy`
  installation. Runner auth-hold polling and unmanaged-server repair have not been exercised with
  an auth-held turn or an App Server replacement on AX41. AX41's current exact socket listener was
  read without changing it: the runner is active, its three labelled Claude homes link the same
  `projects` tree, and the running Codex App Server PID lacks `CONCIERGE_RUNNER_STATE`. It was not
  restarted because that daemon owns an active Codex turn.

| Capability | Source state | Verified here | Live runner |
| --- | --- | --- | --- |
| Account identity and verified home resolution | Implemented | Isolated credential-home check | Not checked |
| Usage snapshot collection | Implemented | Bundles; no provider usage run | Not checked |
| Sign-in start/status/complete and owner restart recovery | Implemented | Offline CLI refusal and duplicate start outcome; owner and runner bundles | Not checked |
| Codex activation and owner admission hold | Implemented | Bundles; no daemon restart | Not checked |
| Codex reset-credit redemption | Implemented | Runner bundle only; no provider redemption | Not checked |
| Google quota and paid-credit guard | Implemented | Settings absent permits; enabled and unreadable settings refuse; bundles | Not checked |
| Runner auth-held polling and Codex repair/re-home | Implemented | Owner/runner bundles; exact managed re-home decision and same-account proof fixtures; no daemon restart | Not checked |
| Exact transcript resolution | Implemented | Unique, missing and ambiguous fixtures | Not checked |

Users: durable watches ([watches](WATCHES.md), `watch-machine.ts`, methods `watch.*`). Turn artifacts need none: only the retired Slack presentation makes an artifact folder; a native turn makes none.

Project reads use the same call channel (`runner-projects.ts`): `projects.list`, `projects.exists`,
`projects.resolve`, `projects.locate`, `projects.files`, `projects.instructions`, `projects.file`, `projects.fileAt`,
`projects.todos`, `projects.todos.update`, `projects.todos.append`, `projects.worktrees`, and
`projects.shareStatus`. The owner
sends a registered project name and a relative path; the runner
resolves it under its own workspace (`CONCIERGE_WORKSPACE_ROOT`, default `~/workspace`). `projects.locate`
can migrate an older absolute session folder by matching its registered project name and relative suffix;
the resulting directory must exist inside exactly one runner project. The supplied absolute root never
selects a filesystem authority. `projects.fileAt`
accepts a file path only when that path is already under the runner's own workspace; paths outside
that root are reported as unmatched so the owner can route them to the machine that owns them. It never
accepts an owner-supplied workspace root or uses an absolute path to choose a project. File reads keep the
existing sensitive-name, symlink, file-type, and size limits. Worktree reads require the provider,
native session UUID and account label; the runner resolves that exact transcript on its own verified
account home and compares its path references with registered Git worktrees. It returns only the
matching worktrees with branch, head, and uncommitted file count. Git runs with system and global
configuration disabled, optional locks off, and fsmonitor disabled. TODO reads and updates are
runner-local; updates compare the observed SHA-256 before replacing the canonical file and use an
atomic rename. Task appends carry an owner-generated idempotency marker, so a retry after an uncertain
reply finds the existing item instead of duplicating it.

A bound conversation without a saved runner recovers its machine from the most recent
execution whose host actually launched (`executions.unit` is present). A later unclaimed
or withdrawn execution intent cannot move the conversation or hide its earlier runner.
If that launched execution was on a runner but its exact lease is missing, resume refuses
to guess the machine; a handoff reports the omission instead of examining the owner's
checkout. Handoffs resolve the recovered runner's project and read worktrees there.
Turn dispatch, handoffs and the owner's project-location reads (registered-project checks,
task creation, outage reruns) share this one rule in `session-runner-home.ts`.

The Google paid-credit check and CLI lookup is `google.executable` (`runner-providers.ts`). It runs
against the runner's Google settings and returns only the executable path. A missing or unreachable
runner is an unknown check; it cannot be treated as proof that paid credits are disabled.

Claude hook settings contain runner-local environment references for Bun and the optional managed
history hook. The owner may prepare the settings JSON, but the command paths resolve when Claude runs
on the runner, using that machine's helper release and executable. A runner-hosted Claude turn names
`claude` for the runner to find on its own PATH; an absolute executable from the owner's service
environment is never sent. When a session is assigned to a
runner, its project name and relative subfolder are resolved there before the host starts; the job
manifest never carries the owner's absolute working directory. Google executable and paid-credit
checks run on the runner before a Google host starts. Outside Codex prompt bytes are written beneath
that execution's private runner state folder and the CLI receives only its execution-bound path.

Project creation is a replay-safe `project-setup` runner job. The owner first validates the exact
completed workspace-organizer answer against its request ledger and reserves the placement receipt.
It then enqueues a deterministic job for the configured project runner, carrying only the project
name, purpose, group, template, order identity, and target runner. The runner stages the scaffold in
its own workspace, disables Git hooks and non-HTTPS Git transports, and uses its own `gh` login to
create or verify the expected private repository. It proves the remote head matches the staged
commit before renaming the checkout into the registered project location. The owner records the
creation and sends the existing peer placement jobs only after receiving that proof. A retry uses
the same order identity, so a lost reply resumes from the staged checkout or recognizes the exact
private repository and commit; it never overwrites a different remote history. The job remains
queued if its runner is away; transient completed failures get a fresh lease job identity while
reusing the same order and staging folder. The runner's `gh` identity and availability are required
for project creation, while organizer proof and project-creation records remain owner-ledger facts.
Network Git calls keep system and global Git configuration disabled, but explicitly use the runner's
signed-in GitHub CLI credential helper. If `gh repo create --push` creates the private repository
before its push fails, the retry verifies the exact repository and staged origin before pushing again.

Peer project placement is a separate replay-safe `project-place` runner job. The owner validates and
retains the peer's original placement order, then sends only its order identity, project name,
grouping folder, and target runner. The runner uses its own GitHub identity to confirm the expected
repository is private, stages the checkout under its private workspace placement area, verifies
the checkout origin and that its commit matches the repository head, then atomically renames it into
the registered project folder. A retry recognizes that exact checkout; a conflicting folder or
different repository is refused. This keeps peer placement from requiring an owner-side project
checkout or GitHub login. The runner's GitHub login is required for placement; the original order
and its outcome remain in the owner's ledger.

## Concierge's own thnkr.ing calls (built)

Every call the owner itself makes to thnkr.ing (ChatGPT runs and their source search, native reads,
human commands, the to-do check on questions, the thesaurus before each turn) goes through one
choice, `thinkering-capability-target.ts`: when `CONCIERGE_THINKERING_CAPABILITY_URL` is set it uses
thnkr.ing's network entrance with the service token in `CONCIERGE_THINKERING_TOKEN_FILE`
(remote-box README "Network capability entrance"); otherwise the local socket, as before. The owner
unit sets the AX41's tailnet entrance and names `/etc/thinkering/network-callers/concierge-owner.token`
itself (not a systemd credential, which is a copy taken at start), so the owner already works
without thnkr.ing's socket. The token file is read on every call: rotation needs no restart, and a
missing file fails that call instead of falling back to a socket another machine will not have.
Tests and sandbox lanes that switch thnkr.ing off clear these variables too. Deploy refuses any
unit whose `LoadCredential=` file is missing (it would never start). The Mac's owner keeps reaching thnkr.ing over `ssh remote-box`.

## Provider history and transcript restores (runner calls)

Provider histories stay in the provider account home on the runner. The owner keeps the parsed
history index and its allowance decisions. It asks the runner for metadata tied to one exact
provider account and native conversation ID; transcript reads return at most 256 KiB and pin the
source file identity and snapshot size across every chunk. The owner mirrors a Claude transcript
into its private state folder only while importing it into the existing history index. That mirror
is a cache of runner-owned source bytes, not a new authority; a changed or shortened source refuses
the read and the next preparation takes a fresh snapshot.

The closed `provider-history.*` relay methods return timestamps for requested Codex item identities,
match an authored subject against one exact transcript, and restore a transcript in bounded chunks.
Commit attribution reads an agent's authored subject from the runner recorded for that turn or
session; it does not scan the owner's provider home when the turn ran remotely.
Legacy authored-subject reads without an account label scan registered account homes and return a
timestamp only for one unique exact native-ID match. Missing and ambiguous matches remain explicit;
the owner's current account is never used as historical evidence.

Restore uses a durable state card on the runner containing the operation UUID, provider/account,
native ID, destination, byte count, SHA-256 and current state. The owner sends a bounded chunk only
to that operation. Replaying the same chunk bytes at the same offset is idempotent; changed bytes,
offset gaps, digest mismatch and a conflicting destination refuse. Finish links the verified staged
file into its provider home without replacing an existing transcript, then records the terminal
state so a retry returns the first result. Neither owner paths nor arbitrary filesystem paths are
accepted by these methods. Check with `bun bot/scripts/runner-provider-history-check.ts`.

Usage breakdown follows the same boundary. The runner scans its registered account homes into its
own incremental cache. For a report, the owner sends a compressed, one-week snapshot of the
session, turn, account and prompt-cache facts needed for attribution. The runner joins those facts
to its local usage cache and returns a compressed report, including the account/session breakdown
and bounded cache diagnostics. The owner combines reports from its configured runners and publishes
the new result only after all answer. A missing runner leaves the previous result and its timestamp
intact. The owner no longer retransfers every raw usage record on each five-minute refresh. The
older path-free record pages remain for focused diagnostics, not the recurring report. The report
call caps its compressed request and response independently of the number of usage records; a
one-person fixture with 100,004 calls returned in two runner calls.

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
   `CONCIERGE_AGENT_API_LISTEN` to its tailnet address and leave out the `agents.slice` settings (the
   unit no longer starts a Codex App Server).
2. On the AX41: run `runner.ts` as a service with a runner token; set `CONCIERGE_AGENT_API_URL` on
   the owner so runs carry the network address and their tokens.
3. Thinkering's capability socket moves behind Thinkering's own HTTPS entrance (its step 2).

## Checks

- `bot/scripts/runner-provider-usage-breakdown-check.ts`: the runner scans fixture account homes,
  emits no provider path, bounds pages, preserves first-call metadata, and keeps records appended
  after a page snapshot out of its remaining cursor pages; the owner collector holds one report
  window across pages and propagates a runner failure before the report cache can be replaced.
- `bot/scripts/runner-provider-history-check.ts`: bounded exact transcript reads and identity
  fencing, exact-byte provider-home restore/retry, no-overwrite, and unique legacy subject match.
- `bot/scripts/runner-provider-fork-check.ts`: exact native fork and recovery identities, runner
  account and project resolution, Codex source provenance, and path traversal refusal.

- `bot/scripts/agent-entrance-check.ts`: the real gateway refuses missing, malformed, forged and
  foreign-key tokens before the owner, forwards run and runner principals that callers cannot spoof,
  keeps process control unreachable, and the agents' client takes the network path.
- `bot/scripts/codex-relay-check.ts`: the real gateway, runner daemon, bridge and App Server client
  against a stand-in App Server: a run token cannot listen, an unknown runner is refused at once,
  requests reach the App Server only through the runner, a dropped App Server connection ends the
  relay and the next request opens a new one. `--real-app-server` asks this machine's real App Server
  `model/list` through the runner (2026-11-04 on the AX41: 8 models answered).
- `bot/scripts/runner-lease-check.ts`: claim, contiguous events, commands, epoch fencing, computed
  expiry (turn unconfirmed, build requeued), idempotent finish, and owner restarts that stop extending
  a runner silent for a lease.
- `bot/scripts/runner-turn-check.ts` (needs systemd; not in the build): the real runner daemon starts
  real hosts for a scripted provider; output, follow-up receipts, attachment bytes, the runner-built
  environment (no owner variable leaks), release after settlement, a coordinator taking the run back,
  a killed and restarted runner continuing with every host frame stored once in order, a turn
  claimed longer ago than the fencing time surviving a runner restart, a host whose
  runner died with an old last contact stopping its own provider (`SIGTERM` journaled), and the two
  unstarted refusals (command not found, no runner claimed).
- Live, 2026-11-04 on release 75faaa3d: over `100.118.245.110:8789` a call without a token got 401,
  the token route 403 and a process-control route 404; probe `probe:live-8623-20261104` was queued
  and run by the installed `runner.js --once` with an `ax41` runner token: one attempt at epoch 1,
  events `started` and `echo` acknowledged to sequence 2 (a resend stored nothing), job `finished`.
  `router-actions.sh sessions get` with only `CONCIERGE_OWNER_URL` and a token (no local state
  folder) answered through the entrance.
