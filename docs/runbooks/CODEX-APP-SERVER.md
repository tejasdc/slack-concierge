# Codex App Server Lifecycle

Slack Concierge is the repository authority for the shared Codex App Server's host startup integration and restart-safety policy. This does not mean Concierge implements or owns the Codex updater. The Codex daemon owns provider-thread runtime; `concierge-bot.service` invokes its standalone managed binary's `app-server daemon start` before starting the bot. Concierge's controllers, its Codex Remote observer, and the Mac Codex app's SSH proxy are clients of the same Unix socket; none is a second App Server.

The daemon is detached from the Concierge process and may outlive a bot restart. Ordinary Concierge deployment starts it if absent but does not stop, restart, bootstrap, or update it.

## Lifecycle Invariants

- `/root/.codex/packages/standalone/` is the canonical install channel because `concierge-bot.service` invokes that path directly. Package releases, `current`, sockets, PID files, and logs are machine-owned runtime state and must never sync from another OS.
- Installing and activating are separate transitions. The standalone installer may stage a release and repoint `current` while the loaded App Server continues running. Only a later restart activates it.
- App Server activation must share Concierge's admission boundary: close new provider admission, prove every owned provider turn idle, restart once, probe `model/list`, reconnect the persistent client, and then reopen admission.
- A reported version is not topology proof. Verify the selected CLI, managed target, running process, `current` symlink, internal `codex` symlink, and code-mode host separately.
- `daemon bootstrap` is not routine pairing repair. With automatic updates enabled, it starts an updater whose restart policy is not coordinated with Concierge's durable queue or deployment gate; ordinary `daemon start` can do the same.

## Current Update Policy

- **Install channel:** standalone only. The redundant global npm package was removed on 2026-08-24. Do not add npm, Homebrew, or another parallel Codex installation on this host.
- **Discovery:** the interactive standalone CLI may check for and offer a new version. No repository-owned systemd timer checks for Codex releases.
- **Staging:** accepting the standalone CLI prompt or manually running the official installer updates the versioned package tree and `current`. It does not activate the new App Server binary.
- **Activation:** explicit maintenance only. There is no automated Concierge activation command yet. Close provider admission, prove turns idle, restart the App Server, probe it, reconnect, and reopen admission.
- **Built-in updater:** disabled by Codex's supported `updater.autoUpdateEnabled: false` in `/root/.codex/app-server-daemon/settings.json`, preserving the other settings. Both `daemon start` and `daemon bootstrap` otherwise launch an updater, even if the App Server is already running. The updater's fixed 60-second grace and lack of Concierge admission coordination do not satisfy the active-agent contract. An intentional CLI update may stage a new release without activating the loaded App Server.

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
Set the native disable preference before `daemon start`. Verify it with
`jq -e '.updater.autoUpdateEnabled == false' /root/.codex/app-server-daemon/settings.json`;
a missing or malformed setting is not disabled. For an updater already running,
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

There is not yet a Concierge-owned App Server activation command. Until one is implemented with the admission sequence above, activation is an explicit operator maintenance operation. Do not substitute the built-in updater.

## Invariant: Only The Managed Daemon Starts The App Server

Every App Server on this host is started by `codex app-server daemon start`, either from `concierge-bot.service`'s `ExecStartPre` or by an operator. `daemon version` must report `"backend":"pid"`; an output without a `backend` field means the listener was started outside the managed path, and `daemon restart` and `daemon stop` will refuse it with `app server is running but is not managed by codex app-server daemon`. Treat that as an incident to repair, never as a topology to operate.

Before that command, the systemd unit restores root ownership and private modes on the
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
5. Probe with `codex exec` on the default model. The Mac app's next connection attaches to the managed daemon (observed 10 seconds after the 2026-09-07 start); its previous `codex app-server proxy` process pointed at the old release and is replaced by the new SSH session.

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

An unmanaged server that is already running is left alone: replacing it is a restart, which
follows the repair section above once admission is idle.

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
