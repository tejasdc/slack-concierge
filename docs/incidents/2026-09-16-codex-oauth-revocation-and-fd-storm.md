# Codex OAuth revocation, app-server restart, and FD storm (2026-09-16)

An OAuth token revocation on the loaded Codex App Server took the managed
daemon into a silent failure state that only the models_manager refresh
surfaced. Restarting the daemon to load the new `~/.codex/auth.json` picked up
the new account cleanly, but the Concierge observer's resubscription burst
immediately exhausted the daemon's inherited 1024 soft file-descriptor limit
and produced hundreds of `os error 24` and cascaded `403 Forbidden` websocket
errors per second. Raising the live daemon's `RLIMIT_NOFILE` with `prlimit`
returned the daemon to a healthy serving state without a second restart.
Neither trigger is documented in the current lifecycle runbook.

This record establishes both facts as first-class lifecycle events and lists
the follow-up scope for [the runbook](../runbooks/CODEX-APP-SERVER.md).

## Trigger: the loaded daemon keeps a revoked OAuth token in memory

The App Server had been running since 2026-09-07 on the operator's Pro 20x
account (`tejastej.dc@gmail.com`). At 2026-09-16 10:02:31 UTC the daemon
began returning `401 Unauthorized: token_revoked` on its periodic
`GET https://chatgpt.com/backend-api/codex/models?client_version=0.153.4`
refresh. The `~/.codex/auth.json` on disk was still the same content it had
been the day before; the revocation was server-side, five minutes before any
local action.

```text
2026-09-16T10:02:31Z ERROR codex_models_manager::manager:
  failed to refresh available models: unexpected status 401 Unauthorized:
  Encountered invalidated oauth token for user
```

The refresh retried at ~five-minute intervals (10:02, 10:07, 10:11, 10:16),
each with the same error. The daemon did not re-read `auth.json` on refresh
failure. Direct `codex login --device-auth` to a new Pro 5x account at
10:07 UTC rewrote `~/.codex/auth.json` in place, but the loaded daemon
continued to fail with the same in-memory token; only its next restart
picked up the new file.

Downstream effect on Concierge: the observer had already recorded an
account-scoped exhaustion from an earlier refusal window and cached it under
[the account-scoped usage semantics](2026-09-15-codex-usage-limit-scope.md).
That cache carried a `2026-09-22T14:18:11Z` reset instant and refused every
subsequent dispatch locally without reaching the App Server, so the
revocation did not surface as user-visible refusals — the observer was
already refusing them for a different reason. Only the App Server's own
stderr told the whole story.

## Response: restart drained cleanly, then the FD ceiling collapsed

The restart itself matched the runbook. With no in-flight `codex exec`
processes, `deployment_drain` empty, and `daemon version` reporting
`"backend":"pid"`, a single `codex app-server daemon restart` returned:

```json
{"status":"restarted","backend":"pid","pid":3806003,"managedCodexPath":"...",
 "managedCodexVersion":"0.153.4","socketPath":"/root/.codex/app-server-control/app-server-control.sock",
 "cliVersion":"0.153.4","appServerVersion":"0.153.4"}
```

`daemon version` immediately reported the new PID with matching versions.
`codex_session_thread_subscribed` events fired in a tight burst as
Concierge's observer reconnected without a bot restart — the expected shape
from the existing runbook.

The observer then attempted to resubscribe to every codex thread it had
tracked, and the daemon's stderr filled with two distinct failure classes:

- `codex_api::endpoint::responses_websocket ... 403 Forbidden`, one to
  eleven per second against `wss://chatgpt.com/backend-api/codex/responses`.
- `thread-store internal error: failed to open thread writer lock ...:
  No file descriptors available (os error 24)`.

Direct probes disproved a Pro 5x access problem: `codex exec -m gpt-5.6-luna`
returned a valid completion during the storm. `/proc/<pid>/limits` showed:

```text
Max open files            1024                 1048576              files
```

with `/proc/<pid>/fd` sitting at 1023 entries. The soft limit was inherited
from the interactive SSH shell that had run `daemon start` on 2026-09-07,
which had never carried enough concurrent state to hit it. On a restart with
many pre-existing observer subscriptions, the daemon opened a writer lock
per thread plus a `chatgpt.com/backend-api/codex/responses` websocket, each
costing multiple file descriptors, and pegged the soft limit within seconds.
Both stderr classes stemmed from that ceiling: `os error 24` when the lock
open call itself was rejected, and `403 Forbidden` when the websocket
handshake could not complete its TLS setup because it could not open a
socket.

## Response: raise `RLIMIT_NOFILE` live

`prlimit --pid <daemon-pid> --nofile=1048576:1048576` on the running
process cleared the ceiling without another restart. The stderr storm
stopped within seconds. Concierge journal showed 51 `codex_session_thread_subscribed`
successes and 40 `codex_session_thread_subscription_failed` warnings over
the next two minutes — the failures being resubscriptions to codex threads
whose rollout JSONL files no longer existed on disk (deleted worktrees).
Those threads are permanently un-resumable and their subscription failures
do not affect new turns.

## Response: clear the Concierge usage cache

The Concierge-side cached refusal is orthogonal to the daemon's health and
survives an App Server restart. Once the daemon was healthy, running
`provider-usage.ts clear codex` cleared the cached
`2026-09-22T14:18:11Z` exhaustion:

```sh
cd /root/workspace/slack-concierge && \
  CONCIERGE_STATE_DIR=/root/.local/state/concierge \
  /usr/local/lib/slack-concierge-deployment/bun \
  bot/scripts/provider-usage.ts clear codex
```

The script's own output confirmed `{"provider":"codex","generation":1,
"cleared":true,"resumed_work":false}` — the same string that appears in
the script header. `resumed_work: false` is the important half: turns in
`error` status remain terminal and do not enter the retry loop. Seven turns
(1585 through 1591) had already been marked `error` with
`dispatch_attempt=1` before the clear; four were autogenerated `native`
lifecycle events that regenerate naturally, three were human-initiated
turns (two `Report a bug` intakes and one operator `resume`) that the
operator must re-issue manually. The bug reports themselves reached the
native Inbox intact (their `capture_delivery_ok` receipts pre-date the
refusals); only their codex response turn was lost.

## Recovery verification

- `daemon version` returned `"backend":"pid"` with matching 0.153.4 on both
  sides.
- App Server stderr had no new entries in the six-minute window after
  `prlimit`.
- `codexbar usage --provider codex --status` reported the new account:
  `Account: tejas@chann.app`, `Plan: Pro 5x`, `Weekly: 100% left`.
- A direct `codex exec` on `gpt-5.6-luna` and on `gpt-6-astra` completed
  normally.
- `provider-usage.ts status` returned `{"provider":"codex","generation":1,
  "limits":[]}`.
- `deployment_drain` remained empty throughout.

## Learnings

Three additions to [the lifecycle runbook](../runbooks/CODEX-APP-SERVER.md)
belong with this incident:

1. **OAuth token revocation is a lifecycle trigger.** The runbook's current
   list of restart triggers covers version-change activation and unmanaged
   listener repair. Revocation is a third trigger with the same admission
   sequence: prove turns idle, restart once, verify `backend:"pid"`, allow
   the observer to resubscribe. It is silent from Concierge if a prior
   account-scoped usage cache is already refusing dispatches, so operators
   should inspect App Server stderr when the daemon looks quiet but
   dispatches keep failing.

2. **`daemon start` inherits its file-descriptor limit from its caller.**
   The interactive SSH shell's 1024 soft limit is not enough for a restart
   that must reopen many observer subscriptions at once. Raise it before
   invoking `daemon start` or `daemon restart`, or fix a live daemon with
   `prlimit --pid <pid> --nofile=1048576:1048576`. The systemd unit's
   `LimitNOFILE` does not follow the daemon after it detaches.

3. **`provider-usage.ts clear` does not resume work.** Its
   `resumed_work: false` output is authoritative: turns already in
   `error` status remain terminal. Human-initiated turns lost during the
   cached-refusal window must be re-issued; autogenerated `native` events
   regenerate naturally. The correct `CONCIERGE_STATE_DIR` for the running
   bot is `/root/.local/state/concierge`. An earlier `/var/lib/concierge-bot`
   path exists but is a decommissioned older state.
