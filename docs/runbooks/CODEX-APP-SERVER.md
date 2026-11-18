# Codex App Server Lifecycle

Slack Concierge is the repository authority for the shared Codex App Server's host startup integration and restart-safety policy. This does not mean Concierge implements or owns the Codex updater. The Codex daemon owns provider-thread runtime; the AX41 runner starts its standalone managed binary when the App Server is absent. Concierge's controllers, its Codex Remote observer, and the Mac Codex app's SSH proxy are clients of the same Unix socket; none is a second App Server.

The daemon is detached from the Concierge process and may outlive a bot restart. Ordinary Concierge deployment restarts the runner, whose start path starts the daemon if absent; deployment does not stop, restart, bootstrap, or update an App Server that is already running.

Concierge's native session observer uses a separate App Server connection. It scans
loaded threads once after connecting, reads their status and history head without
resuming idle history, subscribes to running threads, and unsubscribes after a turn
becomes idle. Codex's broadcast status changes reveal turns started by other clients
without a recurring scan.
On 2026-11-03 an account switch restarted the daemon and the old observer resumed
748 saved sessions, raising its resident memory above 12 GB. A Concierge release
closes that observer connection without restarting the daemon; Codex can then unload
the idle threads after its grace period. Verify the loaded-thread count and daemon
memory after release, and do not manually restart a daemon with running turns.

Both observers reconnect on their own and file a "stopped after repeated failures" repair
notice only after two minutes of continuous failure. Every release closes the runner relay for
a few seconds (503 `RUNNER_NOT_LISTENING`); that gap is not an outage
([failure record](../incidents/2026-11-11-codex-observer-false-outage-on-release.md)).

## Lifecycle Invariants

- `/root/.codex/packages/standalone/` is the canonical install channel because `concierge-bot.service` invokes that path directly. Package releases, `current`, sockets, PID files, and logs are machine-owned runtime state and must never sync from another OS.
- Installing and activating are separate transitions. The standalone installer may stage a release and repoint `current` while the loaded App Server continues running. Only a later restart activates it.
- App Server activation must share Concierge's admission boundary: close new provider admission, prove every owned provider turn idle, restart once, probe `model/list`, reconnect the persistent client, and then reopen admission.
- A reported version is not topology proof. Verify the selected CLI, managed target, running process, `current` symlink, internal `codex` symlink, and code-mode host separately.
- `daemon bootstrap` is not routine pairing repair. With automatic updates enabled, it starts an updater whose restart policy is not coordinated with Concierge's durable queue or deployment gate; ordinary `daemon start` can do the same.

## Current Update Policy

- **Install channel:** standalone only. The redundant global npm package was removed on 2026-08-24. Do not add npm, Homebrew, or another parallel Codex installation on this host.
- **Minimum version 0.166.0:** the history guard needs Codex to report each command's own folder to its pre-command hook, which Codex does from 0.166.0 (openai/codex #57198). Earlier versions report the session's folder, so a local-only amend in another repository was refused on 2026-11-12. The server staged 0.166.0 that day; the App Server picks it up at its next restart.
- **Discovery:** the interactive standalone CLI may check for and offer a new version. No repository-owned systemd timer checks for Codex releases.
- **Staging:** accepting the standalone CLI prompt or manually running the official installer updates the versioned package tree and `current`. It does not activate the new App Server binary.
- **Activation:** explicit source-bound `sessions codex-maintenance` from an independent outside CLI worker; see [runtime maintenance](#source-bound-runtime-maintenance). It closes admission, defers active shared work, uses the supported native graceful-only drain and reopens only after replacement/API proof. Ordinary deployment preserves the loaded daemon.
- **Built-in updater:** disabled by Codex's supported `updater.autoUpdateEnabled: false` in each machine's own `~/.codex/app-server-daemon/settings.json`, preserving the other settings. The server's normal release installer merges the preference before service restart; its systemd startup and in-process daemon-start path refuse to launch without it. The Mac installer merges it as the signed-in user before its daemon start, not in the later sudo hook step. Account-switch restarts also refuse if it is missing. Both `daemon start` and `daemon bootstrap` otherwise launch an updater, even if the App Server is already running. The updater's fixed 60-second grace and lack of Concierge admission coordination do not satisfy the active-agent contract. An intentional CLI update may stage a new release without activating the loaded App Server.

Autonomous deployment repair and its independent review use this same installed
standalone CLI as root with the normal `/root` configuration. Concierge does not
freeze or promote a second Codex copy. Updating standalone `current` therefore
changes future interactive and repair CLI launches, while the already-running
managed App Server remains on its loaded executable until an explicit App Server
maintenance restart. Repair prompts and supervisors never install Codex or
restart that daemon.

Tejas clarified on 2026-10-08 that the recovery agent's CLI running outside
the shared App Server is intentional and acceptable. He recalls a prior
permission issue as the reason, but described that connection as probable;
this incident did not re-establish the original failure. The repair CLI and
shared provider server may therefore load different staged versions without
that difference being an incident or a reason to merge their process paths.
When diagnosing access, check which process actually made the call and its
permissions; do not assume the repair CLI executes inside the provider daemon.

## Built-In Updater Semantics

These semantics were verified against Codex 0.149.1 and observed again with 0.162.0
on 2026-10-08. The [pinned 0.162.0 daemon documentation](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/app-server-daemon/README.md#commands)
documents the native disable setting and that ordinary `start` also ensures an updater
when enabled.

1. The updater waits five minutes after it starts, then runs hourly.
2. Each check runs the official standalone installer.
3. If the App Server is not running, the updater does not start it.
4. If the managed and running versions match, it does not restart.
5. If the managed version changed, it sends `SIGTERM` to the managed App Server immediately; it does not first ask Concierge whether admission is closed or whether work is idle.
6. The App Server's signal handler waits for its running assistant-turn count to reach zero. An idle server therefore restarts immediately. Existing turns get at most 60 seconds to finish before the daemon sends `SIGKILL`; the stop operation times out after 70 seconds.

The restart is scheduled rather than random: it can occur on the first five-minute/hourly check after a new release appears, without operator confirmation. The graceful drain makes short turns safer, but it is insufficient for Concierge because turns commonly exceed 60 seconds and the updater bypasses Concierge's durable admission gate. Keep the built-in updater disabled until activation is integrated with that gate.

The 2026-10-08 incident showed that stopping an updater process alone is insufficient:
the next ordinary service start launched another while the older App Server was still
serving work. That updater forced the server down 60 seconds after requesting shutdown.
Normal Concierge installation merges the native disable preference before `daemon start` without replacing other settings. It refuses malformed settings instead of overwriting them; the server startup independently checks the result. Verify the server setting with
`jq -e '.updater.autoUpdateEnabled == false' /root/.codex/app-server-daemon/settings.json`;
a missing or malformed setting is not disabled. The Mac uses its own home, not root's; its `install-mac.sh` applies and checks the same preference before starting the daemon. These install checks do not stop an updater that is already running. For an updater already running,
confirm its exact `pid-update-loop` PID and process group before stopping that PID only.
Never stop the shared scope or signal a
process group to contain the updater. `daemon --help` offers no updater-only command;
its supported persistent control is the settings file, not an invented CLI flag.

`check_for_update_on_startup` is separate. It lets an interactive CLI discover and offer a newer release; accepting from the standalone CLI exits that CLI and runs the installer. It does not signal the App Server by itself.

## Inspect Installed And Running Versions

```sh
type -a codex
/root/.local/bin/codex --version
test ! -e /usr/bin/codex
/root/.local/bin/codex app-server daemon version   # must include "backend":"pid"
ps -eo pid,ppid,lstart,args | rg 'codex.*(app-server|proxy|code-mode|updater)'
readlink /proc/<app-server-pid>/exe
test -L /root/.codex/packages/standalone/current
test -L /root/.codex/packages/standalone/current/codex
test -x /root/.codex/packages/standalone/current/bin/codex-code-mode-host
```

Interpret the surfaces independently:

- `cliVersion` describes the inspecting command.
- `managedCodexVersion` describes the target used by a future managed launch.
- `appServerVersion` describes the currently running server.
- `/proc/<pid>/exe` identifies the executable inode already loaded by that process, even after its directory is renamed.

The standalone installation is the sole host authority. `type -a codex` must resolve only through `/root/.local/bin`, and `/usr/bin/codex` must remain absent.

## Stage Without Activating

Run the official standalone installer:

```sh
curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh
```

Repeat the topology and version checks, then stop. Do not run `daemon restart` merely because `managedCodexVersion` is newer than `appServerVersion`. Existing sessions continue on their loaded executable; future ordinary CLI launches use the new `current` target.

Use the source-bound operation below for the verified supported native runtime. Do not substitute the built-in updater or `daemon stop/restart`, whose forced deadline can interrupt accepted work.

## Source-bound runtime maintenance

Run from an independent `sessions ask --outside` worker, with that worker's own exact live source
input/run, stable action and the full source commit that the installed runner must contain:

```sh
router-actions.sh sessions codex-maintenance --required-commit <full-source-commit> --source-input <worker-input> --source-run <worker-run> --action-id <stable-action>
```

Keep retrying the same command while it returns `waiting`, `draining` or `uncertain`. The operation
identity and source action are retained before owner admission closes. A changed required commit
or runner conflicts before a new hold is created, including after terminal success. If the worker
resumes in a new turn, pass its new live source pair plus `--resume-operation <runtime:id>`; only
the same worker session can progress/read the already retained operation, with its original
source/action/runner/release unchanged. A terminal original source run is not a valid live actor.

The distinct durable maintenance hold survives owner restart. It blocks shared-daemon queue
starts while genuine independent outside CLI turns remain eligible. The queue and stuck-work
watch use the same predicate: outside placement must be the JSON Boolean `true`, matching the
execution host. This exception applies only when every admission holder is a complete,
source-bound runtime-maintenance recovery whose holder matches its runner and operation.
Account activation, credential/re-home operations, legacy holders, unknown kinds and malformed
recovery still block outside work, including in combination with maintenance. Settling one
holder never releases another. Restore classifies the existing `holder` and `recovery_json`
rows without a schema migration or rewriting the retained source, action or required release;
unknown or incomplete recovery fails closed. All other queue controls still apply, and admission
uses the existing protected outside launcher rather than another execution path.

Replay `bun run scripts/codex-outside-admission-fixture.ts` from `bot/` for the real disposable
queue/watch and pre-fix durable-row restore cases; it never launches a provider or opens live state.

The existing restart lock and
runner activation journal reserve the App Server before the first asynchronous preflight and
restore auto-start/account/re-home fences on runner restart. Shared owned turns remain untouched;
independent outside CLI runs do not self-block on a daemon they do not use. Native loaded-thread
activity must also prove idle before the first signal. The runner records boot ID, exact control
listener PID and start ticks, then sends **SIGHUP**, not SIGTERM or a daemon-controller stop.

This operation currently supports only a loaded `codex-cli 0.166.0`, checked through that exact
process's executable. [Pinned upstream native signal handling](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/app-server/src/lib.rs)
maps SIGHUP to GracefulOnly; native admission and drain share the receiver's lock. A native start
racing the snapshot is either refused or fully drained. There is no force deadline. Retried
SIGHUP to the same exact generation is graceful-only too, so recovery after durable intent but
before signal cannot accidentally invoke a forced second-signal path.

After the original generation exits, the runner starts through the installed image mask, or
reconciles a replacement already present. It proves the exact listener sees the inaccessible
0:0 image device and `model/list` answers. The owner repeats the model read through a retained
protected proof lane owned by its persistent API client, at that client's exact socket/runner.
The direct proof client disables daemon management and the owner lane uses the existing protected
receiver, so neither successful reads nor reconnect failures can tune, move or start the daemon.
The lane has its own connection/error lifetime and closes with its owning client; active ordinary
RPCs and their normal recovery behavior remain untouched. This proves the owner proof lane's
reconnect/API access, not the ordinary active bridge's reconnect. Ordinary admitted provider work
remains separate installed acceptance.

Direct requests and automatic recovery commit
the full applied result to the original retained action together with deletion of only its exact
durable holder, then publish the admission change. Failed persistence leaves the hold in place;
a stale waiting/uncertain result cannot overwrite an applied owner receipt.

Before applying the idle guard to unfinished work, the owner asks the existing runner channel
for `accounts.codex.runtimeMaintenance.observe` with the same complete binding. This distinct
read method makes older runners refuse safely rather than ignore a new option on a mutating
call. It never reserves, writes the journal, signals, starts or progresses unfinished work.
An already-applied journal result retains its original/replacement identities. The reader proves
that exact current listener is still masked and its provider API answers; the owner repeats its
own API read and confirms the same generation again before committing completion. Later active
work does not block this reconciliation or recreate its maintenance hold. A saved terminal owner
receipt returns directly, including after restart/response loss, without any runtime operation.
Missing/changed/unmasked replacements preserve historical applied evidence and report current
uncertainty separately; they never authorize draining a different generation. Unknown/malformed
observations or an older runner cannot fall through to mutating progress. Confirmed unfinished
operations still close admission and obey the existing owned/native idle guards.

Runner completion is durable only when both the runtime phase and published operation status
are applied. Until then all existing runner fences/exclusions remain held, including after failed
write, fsync or rename. Observation reports historical effect, current proof and publication as
separate facts and never repairs persistence itself. For an already-proved but unpublished effect,
the same operation's distinct `accounts.codex.runtimeMaintenance.publish` retry rechecks the exact masked replacement/API and republishes
only its terminal journal. It cannot drain/start, waits for no later work, and fails closed if the
retained effect or replacement is missing/changed. Older receivers reject this distinct method,
including if the runner reconnects to an older process after observation. Only successful publication can release that
runner fence; the owner still commits its own receipt/hold transaction afterwards. Valid process
identities are required before generation equality or terminal admission; missing fields cannot
become equal generations.

Replay `bun run scripts/runtime-terminal-reconciliation-fixture.ts` from `bot/` for composed
disposable owner action/hold and runner-journal recovery, atomic rollback, stale-response,
version-skew and exact-generation checks. No provider or production state is used.
`bun run scripts/runtime-terminal-proof-fixture.ts` exercises the actual client and receiver
boundaries with private sockets and daemon-effect counters, including ordinary recovery controls.

For unfinished maintenance, unknown generation, unsupported runtime,
response loss or failed proof keeps admission held and the original request open. Terminal-only
reconciliation leaves any existing holder in place on failed proof and never creates a new one.
No credentials
or provider inputs are rewritten. A replacement that already proves mask/API health is never
drained again just to repeat acceptance. Native protocol/process fixtures are separate from
installed provider-agent no-byte-open, API access and owner/backup-namespace acceptance.

## Invariant: Only The Managed Daemon Starts The App Server

Every App Server on this host is started by `codex app-server daemon start`, either by the Concierge runner that supervises it (`bot/scripts/runner.ts`, at the runner's start or when a relay finds nobody listening; see [Runners](../architecture/RUNNERS.md)) or by an operator. Until 2026-11-05 `concierge-bot.service`'s `ExecStartPre` started it; the owner now starts no App Server. `daemon version` must report `"backend":"pid"`; an output without a `backend` field means the listener was started outside the managed path, and `daemon restart` and `daemon stop` will refuse it with `app server is running but is not managed by codex app-server daemon`. Treat that as an incident to repair, never as a topology to operate.

Before that command, the start path (`startCodexDaemonWhenAbsent`, used by the runner; formerly the
owner's systemd unit) restores the caller's ownership and private modes on the
managed daemon and control-socket directories. Codex 0.156.1 refuses to start when the
socket parent belongs to another local user, even when that directory is mode `0700`.
The September 22 deployment exposed this after macOS ownership had been preserved on
the box: the already-running 0.153.4 daemon remained usable, but its next restart could
not pass the newer ownership check. The startup prerequisite is deliberately idempotent;
it repairs directory metadata only and does not remove or replace sockets, locks, or
credentials. The sync exclusions below remain the primary boundary against peer runtime
state crossing machines.

The Mac Codex app is not a starter. Its SSH payload in 0.153.4 only fixes `PATH`, links the forwarded agent socket, and runs `codex app-server proxy`; if no managed daemon is listening, the connection fails instead of booting a server. The 0.149.1 payload still contained a boot-if-absent branch (guarded by `CODEX_SSH_SKIP_APP_SERVER_BOOT`), which is how the 2026-08-24 replacement server came to run unmanaged under `--listen unix://` with `features.code_mode_host` for two weeks. Its 0.149.1 binary then outlived the 0.153.4 install and rejected the config default model `gpt-6-astra` for every Codex Desktop session on 2026-09-07, while Concierge turns with explicit models kept working.

Repair an unmanaged listener once Concierge admission is idle (`turns` has no nonterminal rows, `deployment_drain` is empty):

1. `kill -TERM <app-server-pid>` and wait up to 70 seconds. On 2026-09-07 the 0.149.1 server stayed in `futex_wait` with clients attached and never exited; that was not an in-flight turn.
2. `kill -KILL <app-server-pid> <code-mode-host-pid>`, then rename the orphaned socket to `app-server-control.sock.stale-<UTC timestamp>` as in the 2026-08-24 repair. Never delete it.
3. `/root/.local/bin/codex app-server daemon start`; `daemon version` must then show `backend: pid` and matching `managedCodexVersion` / `appServerVersion`.
4. Concierge's observer reconnects by itself: one `codex_remote_observer_disconnected` warning at the kill, then a burst of `codex_remote_thread_subscribed` events. No bot restart is needed.
5. From an OS temporary folder, probe with `codex -m gpt-6.1-sol -s read-only -a never exec --skip-git-repo-check "Reply with OK only."`. This availability check does not grant project trust. The Mac app's next connection attaches to the managed daemon (observed 10 seconds after the 2026-09-07 start); its previous `codex app-server proxy` process pointed at the old release and is replaced by the new SSH session.

## The Daemon Lives In Its Own Scope

A detached daemon stays in the systemd cgroup of whoever started it, and systemd ends every
process in a unit's cgroup when that unit stops. On 2026-10-08 the daemon had been started from an
SSH login and died at 6:47 AM when that login closed; its replacement was started by an agent's
`codex` call inside a `concierge-exec-*` unit, and the next by the account switch inside
`concierge-bot.service`, which every update restarts. Each connection Concierge opens therefore
moves the daemon, its updater and their children into a transient `codex-app-server-<pid>.scope`
(`moveCodexDaemonToOwnScope` in `codex-daemon-file-limit.ts`, beside the open-file raise), logging
`codex_daemon_moved_to_own_scope` or `codex_daemon_scope_move_failed`. Moving changes only the
cgroup; nothing restarts. `systemd-cgls -u 'codex-app-server*'` shows where it lives.

## Only The Manager Brings A Missing Server Back

Codex updates itself: its updater stops the running server and launches a replacement. At
3:53 PM on 2026-10-08 the replacement for 0.162.0 quit with `app-server control socket is already
in use` because the old server had not yet let go, and the updater gave up after its ten-second
readiness wait. Five seconds later the Mac Codex app's SSH payload, which starts
`codex app-server --listen unix://` whenever nothing answers, started an unmanaged server
(`daemon version` without `backend`). Two changes close that path:

- `install-codex-stop-hook.sh` installs `/etc/ssh/sshd_config.d/50-codex-managed-app-server.conf`
  with `SetEnv CODEX_SSH_SKIP_APP_SERVER_BOOT=true`, the payload's own opt-out, checked with
  `sshd -t` before a reload. The Mac app then only connects through its proxy, and its
  forwarded SSH agent is no longer linked into the control directory.
- When a Concierge connection finds the socket refusing or missing, `startCodexDaemonWhenAbsent`
  (`codex-daemon-file-limit.ts`) runs `daemon start` in a fresh scope, at most once per
  30 seconds, logging `codex_daemon_started_when_absent` or `codex_daemon_start_failed`.

An unmanaged server that is already running is replaced by Concierge itself, with the repair
section's steps, at the first moment no Concierge Codex turn runs and none is observed running from
another client (`repairUnmanagedCodexServer` in `provider-activation.ts`, checked at startup and on
every execution change). It stops only the processes holding the control socket (matched by its
inode), keeps the old socket under a dated name, holds Concierge's own start-when-absent meanwhile,
and starts the managed server in its own scope. It changes no account and releases no held work.
Every Codex restart Concierge makes, a switch or this repair, runs one at a time and first holds new
Codex admission (`holdCodexAdmission` in `state.ts`), then counts running Codex turns and defers if
any run; the hold lasts only the seconds of the restart, and queued work is never held while an agent
is working. Server only: the lookup uses `/proc`.

## OAuth Token Revocation Triggers The Same Restart

An account-side OAuth token revocation while the App Server is loaded leaves
the daemon holding an invalidated access-and-refresh pair that it does not
recover from on its own. The models_manager surfaces it as periodic
`401 Unauthorized: token_revoked` errors against
`https://chatgpt.com/backend-api/codex/models?client_version=<version>`:

```text
ERROR codex_models_manager::manager:
  failed to refresh available models: unexpected status 401 Unauthorized:
  Encountered invalidated oauth token for user, ... auth error code: token_revoked
```

The daemon does not re-read `~/.codex/auth.json` on refresh failure. Even if
`codex login` (or `codex login --device-auth`) has already rewritten the file
with a valid new account, the loaded daemon continues to fail with the same
in-memory token. Only its next restart picks up the new file.

Concierge's observer can hide the revocation entirely if it has already cached
an account-scoped usage refusal from an earlier window
([usage-limit scope](../incidents/2026-09-15-codex-usage-limit-scope.md)). It
will then refuse every dispatch locally without reaching the App Server, so
turns keep failing but no cross-boundary error is emitted. Inspect the App
Server's own stderr when the daemon looks quiet but dispatches keep failing.

Recover with the same admission-close sequence as for a version-change
restart:

1. Prove Concierge admission is idle (`turns` has no nonterminal rows,
   `deployment_drain` is empty).
2. `codex app-server daemon restart`. Because the daemon is managed
   (`backend:"pid"`), the CLI's `restart` subcommand is the whole operation;
   no manual `kill -TERM` or socket rename is needed.
3. Verify `daemon version` reports `"backend":"pid"` with matching versions.
4. Concierge's observer reconnects on its own. No bot restart.
5. Then clear Concierge's cached refusal — see the next section — because the
   restart alone does not touch the observer's state.

The 2026-09-16 incident is the dated evidence.

## Restart Preflight: Raise The Daemon's File-Descriptor Ceiling

`codex app-server daemon start` inherits `RLIMIT_NOFILE` from whatever
process invoked it. Both an interactive SSH shell's default 1024 soft limit
and `concierge-bot.service`'s own limit reach the daemon that way; the
systemd unit propagates `LimitNOFILE` to the detached daemon through `ExecStartPre`'s fork chain, but only if the unit sets it explicitly. The unit now sets `LimitNOFILE=1048576`; the systemd default was leaving the soft limit at 1024 even with a 524288 hard limit.
An idle-load restart never notices, but a restart that must reopen the
observer's tracked codex threads at once — each thread costs a writer-lock
open plus a `wss://chatgpt.com/backend-api/codex/responses` websocket
handshake — pegs the soft limit within seconds. The failure surfaces as
two entangled classes in the daemon's stderr:

```text
ERROR codex_api::endpoint::responses_websocket:
  failed to connect to websocket: HTTP error: 403 Forbidden, url: wss://chatgpt.com/backend-api/codex/responses
ERROR thread-store internal error: failed to open thread writer lock ...:
  No file descriptors available (os error 24)
```

The `403 Forbidden` is a symptom of the same exhaustion: the websocket TLS
handshake cannot open its own socket.

Raise the limit before invoking `daemon start` or `daemon restart`:

```sh
ulimit -n 65536
/root/.local/bin/codex app-server daemon start   # or daemon restart
```

Fix a live daemon that is already storming without a second restart:

```sh
prlimit --pid <daemon-pid> --nofile=1048576:1048576
```

The 2026-09-16 incident documents both stderr classes and the `prlimit`
recovery.

## Answers Containing U+2028 Or U+2029

The bridge between Concierge and the App Server speaks JSON Lines. Bun's `node:readline` also
ends a line at U+2028 (line separator) and U+2029 (paragraph separator), which JSON leaves
unescaped inside strings, so any App Server message holding one reached Concierge as broken
pieces and was skipped. On 2026-10-21 one conversation whose history held two U+2029 characters
never received a `thread/resume` answer and refused every input, while Node clients resumed it
in 150 ms ([failure record](../incidents/2026-10-21-codex-thread-resume-unanswered-on-shared-connection.md)).
Now every JSON Lines reader runs through `src/json-lines.ts` (split on `\n` only), our writers
escape both characters, and the release lint refuses `node:readline` in Bun code. A resume
timeout also spends that conversation's retry budget rather than the Codex account's.

To check a suspect thread by hand without restarting the App Server, resume it from a fresh
connection through the release's bridge:
`node ~/workspace/agent-scripts/codex-thread-probe.mjs <release>/bot/src/codex-app-server-bridge.mjs <thread-id> 'thread/resume'`.
The App Server's debug line `composing running thread resume response` in
`~/.codex/logs_2.sqlite` is written before the answer is sent, so it does not prove delivery.

## Clearing Concierge's Cached Usage Refusal

Concierge's provider-usage observer caches account-scoped Codex refusals as
[a single balance with one reset instant](../incidents/2026-09-15-codex-usage-limit-scope.md).
That cache survives an App Server restart and continues refusing every
Codex dispatch locally until an operator clears it after a top-up, a plan
change, or an early reset. The daemon side of the pipeline can be
completely healthy and Concierge will still refuse.

Clear it with the deployment-installed script:

```sh
cd /root/workspace/slack-concierge && \
  CONCIERGE_STATE_DIR=/root/.local/state/concierge \
  /usr/local/lib/slack-concierge-deployment/bun \
  bot/scripts/provider-usage.ts clear codex
```

The correct `CONCIERGE_STATE_DIR` for the running bot is
`/root/.local/state/concierge`. An earlier `/var/lib/concierge-bot` path
exists on the host but is decommissioned older state.

The output includes `"resumed_work":false`. That is authoritative: turns
already in `error` status from the cached-refusal window remain terminal,
do not enter the retry loop, and do not appear in
`dispatch_next_attempt_ms`. Autogenerated `native` lifecycle events
regenerate naturally on the next session tick; human-initiated turns
(Slack messages, `Report a bug` intakes, operator `resume` requests) must
be re-issued by their originator. Bug reports themselves reach the native
Inbox through `capture_delivery_ok` before the Codex turn is created, so
their content is preserved even when the response turn is lost; only the
Codex response has to be re-requested.

`provider-usage.ts status` reports the current cache without changing it
and is safe to run at any time.

## Repair Malformed Standalone Topology

1. Record App Server and code-mode-host PIDs, start times, versions, `current`, and `/proc/<pid>/exe`.
2. Preserve malformed package directories under a timestamped recovery directory inside `~/.codex/packages/standalone/`; never delete a path while a live process may reference its inode.
3. Run the installer. If it reuses an already-present malformed release, preserve that release too and rerun the installer to force a clean download.
4. Verify that `current` points to the intended release, `current/codex` points to `bin/codex`, and `current/bin/codex-code-mode-host` is executable.
5. Confirm that the original PIDs and start times remain unchanged. Healthy loaded processes do not require a restart to make future launch paths correct.
6. Retain recovery directories through the next approved activation and post-restart verification.

The dated failure and repair evidence is in [the 2026-08-24 incident](../incidents/2026-08-24-codex-runtime-sync-corruption.md).

## Resumes Never Ask For History

Every Concierge `thread/resume` sends `excludeTurns: true`: turns read only the thread id, model and
policy from the answer, and reconciliation reads history separately with `thread/read`. On
2026-11-04 full-history resumes of a 218 MB conversation held Concierge's shared connection long
enough that every Codex session's resume timed out for six minutes
([failure record](../incidents/2026-11-04-codex-resume-full-history-stalled-all-sessions.md)).
A turn's resume, at dispatch and in restart recovery, also has no deadline. A cold resume loads the whole rollout before answering, and
the App Server queues resumes per thread, so asking again only adds another load. The turn waits
while the connection lives and logs `codex_resume_waiting` every 30 s. Stop and a disconnect still
end the wait. A resume still unanswered after ten minutes (about four times the slowest cold load
seen) logs `codex_resume_unanswered` and records one `stuck_work` repair notice for the standing
Repair agent; the turn keeps waiting, and the wait's end resolves the notice or adds a recovery fact.
`bot/scripts/codex-resume-notice-fixture.ts` injects a never-answering resume in the release build.
To find the conversation behind a burst of resume timeouts, look for the thread whose
`otel.name="thread/resume"` span in `~/.codex/logs_2.sqlite` began just before the burst, and
compare its rollout size under `~/.codex/sessions`.

## Project trust for command-line work

The [0.169.0 release notes](https://learn.chatgpt.com/docs/changelog) say that
`exec` leaves project configuration and MCP disabled in untrusted directories,
including with `--sandbox workspace-write`. Trust and filesystem permissions are
separate. The real 0.169 binary's `exec --help` and `exec resume --help` expose
`--trust`: it saves trust for future chats, including MCP commands outside the
sandbox, persists even with `--ephemeral`, and refuses an explicitly untrusted
project. Installed 0.166 rejects that flag. Do not replace it with a command-line
`projects.<path>.trust_level` override: that could defeat an explicit refusal.

Concierge's project-work launches share `bot/src/trusted-codex-exec.ts`. A help-only
probe runs on the actual execution host immediately before launch. When that
executable advertises `--trust`, the launch adds it before the resume subcommand;
otherwise it retains the legacy invocation. A failed help probe stops the launch.
The host's existing stderr journal records `Concierge Codex project trust: explicit`
or `legacy CLI`, without prompt content. Shell arguments remain separate values:
the prompt, path, model, effort and exact resumed conversation are never expanded
as shell text. This uses the CLI's native trust owner and existing execution host,
with no trust store, background job, model call, or coordinator-side version guess.

| Launch | Trust policy and model |
| --- | --- |
| Outside request, fresh or resumed (`bot/src/outside-codex.ts`) | Trusted project work through the compatibility helper, on the runner when applicable. The bound model wins; a missing model uses Concierge's Sol investigator default. |
| Autonomous deployment repair, fresh or resumed (`bot/src/deployment-repair-agent.ts`) | Trusted repair work through the same helper. Explicit Sol investigator selection; existing deadline, process group, hook policy and structured result stay in force. |
| Local side question (`bot/src/session-asides.ts`) | No trust grant. Ephemeral, read-only answer on a saved fork; explicitly select the bound model, or Sol only when absent. |
| Runner side question (`bot/scripts/runner-aside-worker.ts`) | Same exemption and explicit model selection as the local side question. |
| Outage-alternative probe (`bot/src/provider-outage.ts`) | No trust grant. OS temp directory, read-only, no approvals, explicit candidate model. |
| Agent command wrapper (`bot/scripts/codex`, `agent-codex-launch.ts`) | Caller-owned arguments, including model and trust. Never infer trust globally: source-isolated fallbacks also call Codex. Escalation recording remains enforced. |
| Ordinary sessions, forks, login, account and daemon commands | App Server or lifecycle commands, not `exec`; no command-line trust change. |

No executable `codex review` launch exists in Concierge. Conceptual `exec` mentions
in the outside-request, provider and execution-host docs refer to the two launchers
above. Historical plans, incidents and archives retain the names and syntax they
actually observed. The shared skills catalog owns manual project-work examples;
its update is separate. The sibling twitter-timeline fallback remains source
isolated in a scratch repository with its own tool restrictions; it is not
authorized to grant trust through this helper.

Run the native preflight from a task worktree on the server:

```sh
bun bot/scripts/codex-exec-trust-acceptance.ts /root/.codex/packages/standalone/current/bin/codex
# Repeat with an unpacked official candidate binary; do not replace the installed CLI.
bun bot/scripts/codex-exec-trust-acceptance.ts /absolute/path/to/candidate/codex
```

The command creates and removes only disposable Git projects and Codex homes. A
deliberately malformed project config distinguishes loaded from ignored layers;
an absent model provider stops execution before authentication or any model call.
It checks raw isolation, trusted fresh/resumed launch, saved trust under
`--ephemeral`, and explicit-untrusted preservation/refusal. On 0.166 the helper
must reach the legacy preflight without an unsupported flag; on 0.169 fresh and
resume must load the project layer and preserve an explicitly untrusted refusal.
This establishes CLI/config compatibility, not a successful provider response.
After installation, exercise a marked outside request through `sessions ask
--outside` and inspect its actual return separately; never start a deployment
incident just to test repair. Neither this change nor its preflight updates Codex
or restarts the shared App Server.
