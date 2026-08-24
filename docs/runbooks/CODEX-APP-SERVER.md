# Codex App Server Lifecycle

Slack Concierge is the repository authority for the shared Codex App Server's host startup integration and restart-safety policy. This does not mean Concierge implements or owns the Codex updater. The Codex daemon owns provider-thread runtime; `concierge-bot.service` invokes its standalone managed binary's `app-server daemon start` before starting the bot. Concierge's controllers, its Codex Remote observer, and the Mac Codex app's SSH proxy are clients of the same Unix socket; none is a second App Server.

The daemon is detached from the Concierge process and may outlive a bot restart. Ordinary Concierge deployment starts it if absent but does not stop, restart, bootstrap, or update it.

## Lifecycle Invariants

- `/root/.codex/packages/standalone/` is the canonical install channel because `concierge-bot.service` invokes that path directly. Package releases, `current`, sockets, PID files, and logs are machine-owned runtime state and must never sync from another OS.
- Installing and activating are separate transitions. The standalone installer may stage a release and repoint `current` while the loaded App Server continues running. Only a later restart activates it.
- App Server activation must share Concierge's admission boundary: close new provider admission, prove every owned provider turn idle, restart once, probe `model/list`, reconnect the persistent client, and then reopen admission.
- A reported version is not topology proof. Verify the selected CLI, managed target, running process, `current` symlink, internal `codex` symlink, and code-mode host separately.
- `daemon bootstrap` is not routine pairing repair. In Codex 0.149.1 it also starts an updater whose restart policy is not coordinated with Concierge's durable queue or deployment gate.

## Current Update Policy

- **Install channel:** standalone only. The redundant global npm package was removed on 2026-08-24. Do not add npm, Homebrew, or another parallel Codex installation on this host.
- **Discovery:** the interactive standalone CLI may check for and offer a new version. No repository-owned systemd timer or automatic updater checks for Codex releases.
- **Staging:** accepting the standalone CLI prompt or manually running the official installer updates the versioned package tree and `current`. It does not activate the new App Server binary.
- **Activation:** explicit maintenance only. There is no automated Concierge activation command yet. Close provider admission, prove turns idle, restart the App Server, probe it, reconnect, and reopen admission.
- **Built-in updater:** disabled because its fixed 60-second grace period and lack of Concierge admission coordination do not satisfy the active-agent contract.

## Built-In Updater Semantics

These semantics are verified against the Codex 0.149.1 source used on the service peer:

1. The updater waits five minutes after it starts, then runs hourly.
2. Each check runs the official standalone installer.
3. If the App Server is not running, the updater does not start it.
4. If the managed and running versions match, it does not restart.
5. If the managed version changed, it sends `SIGTERM` to the managed App Server immediately; it does not first ask Concierge whether admission is closed or whether work is idle.
6. The App Server's signal handler waits for its running assistant-turn count to reach zero. An idle server therefore restarts immediately. Existing turns get at most 60 seconds to finish before the daemon sends `SIGKILL`; the stop operation times out after 70 seconds.

The restart is scheduled rather than random: it can occur on the first five-minute/hourly check after a new release appears, without operator confirmation. The graceful drain makes short turns safer, but it is insufficient for Concierge because turns commonly exceed 60 seconds and the updater bypasses Concierge's durable admission gate. Keep the built-in updater disabled until activation is integrated with that gate.

`check_for_update_on_startup` is separate. It lets an interactive CLI discover and offer a newer release; accepting from the standalone CLI exits that CLI and runs the installer. It does not signal the App Server by itself.

## Inspect Installed And Running Versions

```sh
type -a codex
/root/.local/bin/codex --version
test ! -e /usr/bin/codex
/root/.local/bin/codex app-server daemon version
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

## Repair Malformed Standalone Topology

1. Record App Server and code-mode-host PIDs, start times, versions, `current`, and `/proc/<pid>/exe`.
2. Preserve malformed package directories under a timestamped recovery directory inside `~/.codex/packages/standalone/`; never delete a path while a live process may reference its inode.
3. Run the installer. If it reuses an already-present malformed release, preserve that release too and rerun the installer to force a clean download.
4. Verify that `current` points to the intended release, `current/codex` points to `bin/codex`, and `current/bin/codex-code-mode-host` is executable.
5. Confirm that the original PIDs and start times remain unchanged. Healthy loaded processes do not require a restart to make future launch paths correct.
6. Retain recovery directories through the next approved activation and post-restart verification.

The dated failure and repair evidence is in [the 2026-08-24 incident](../incidents/2026-08-24-codex-runtime-sync-corruption.md).
