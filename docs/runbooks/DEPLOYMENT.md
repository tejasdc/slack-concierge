# Deployment and service operations

## Normal deploy

This repository is one peer in a Git-distributed codebase. Propagate code through origin and deploy with `bot/scripts/deploy.sh`; never edit installed units or project files directly on the service peer. The deploy script pulls, refuses conflicts, installs repository-owned units, and activates an exact immutable release only after drain safety is established.

Deploy and bootstrap establish a root credential environment when `HOME` is
absent and disable terminal Git prompts. Normal deploy verifies that `origin`
is readable through the existing `gh` credential helper before claiming either
admission gate, so a credentialless transient launcher fails immediately rather
than waiting for active turns to drain. Callers must not source or copy GitHub
tokens; `/root/.gitconfig` and `/root/.config/gh/hosts.yml` remain the
service-peer credential authorities.

The stopped-service bootstrap fetches before draining and records the exact
pulled commit beside its one-time handoff token; the nested deploy validates
that local proof without contacting the network after the service is stopped.
The scaffold cutover performs the same origin preflight before claiming its
long-lived gates and reuses that result when it eventually enters normal deploy.

Deploy asks `bot/scripts/drain-status.ts` whether provider turns have live owners. It waits 20 minutes between checks while work is live, with no maximum age. Interrupting only the child wait requests an immediate ownership recheck; terminating the deployment runner still cancels the run and releases its live gates. It proceeds past blocking rows only after process identity proves every owner stale. Indeterminate liveness fails closed.

There is no standing deployment service. An ordinary agent invocation carries its durable turn identity in the provider tool environment. `deploy.sh` validates that identity against the live turn owner, rejects an uncommitted source worktree, persists the requested commit and exact provider/Slack continuation mapping, and joins or creates the one active batch for the Concierge target. The first request launches one deterministic transient `systemd-run` unit; later requests join that batch. The transient runner owns drain, pull, restart, probes, gate release, and the terminal batch result, so the bot restart cannot kill it.

The non-agent fallbacks are intentionally narrower. A direct operator invocation outside the service runs synchronously in that caller and has no thread to wake. An invocation inside `concierge-bot.service` without durable turn identity retains the legacy per-invocation transient handoff but cannot enroll a verification wake. `bootstrap-deploy.sh` and `project-scaffold-cutover.sh` remain specialized one-time paths and do not create post-deploy verification turns.

After restart, deploy requires an active service, nonzero `MainPID`, successful
Slack user-token `auth.test`, a successful Codex App Server `model/list`, authenticated access to the private capture queue,
and a `concierge_bot_online` marker from the current systemd invocation. For an
agent-enrolled batch, the marker's Git SHA must exactly equal the canonical
checkout SHA pulled by the runner. Capture
ingress must also pass its local HTTP probe before the Slack bot restarts.
Normal startup publishes this marker before beginning its best-effort Canvas
refresh, so slow Canvas API calls cannot hold Socket Mode or capture delivery
behind the deployment health gate. Canvas maintenance uses a separate
rate-limit lane from user-visible Slack operations and serializes writes per
channel. A scaffold cutover remains fail-closed and publishes the marker only
after its explicitly required all-channel refresh.
`bot/tests/deploy.test.ts` is the focused authority.

Every normal deploy also installs the protected deployment bundle, verifies the
fixed Slack incident notifier against the registry-owned project channel, and
builds the exact pulled commit with the incumbent credential-free non-root
builder. `concierge-bot.service` starts through the protected stable release
pointer. The candidate becomes last known good only after capture and service
functional health, exact runtime SHA, released gates, and a final unchanged
systemd invocation proof all agree.

If a failure occurs after candidate activation, the EXIT recovery path selects
only the prior last-known-good release recorded before activation. It switches
the stable pointer through the protected kernel, re-runs both functional probes,
and re-proves runtime SHA and invocation before releasing either gate. A proven
restore produces one fixed `runtime_restored` incident alert in the project
channel; a notifier ambiguity is reconciled by exact readback without reposting.
If no healthy restore can be proven, Concierge remains stopped and both admission
gates remain held. Recovery never resets the canonical checkout or executes the
failed candidate's deploy code.

## Post-deploy agent verification

The deployment coordinator persists `deployment_runs`, append-only phase events, per-turn requests, per-session wake intents, and failure notices in Concierge's main SQLite database. A run moves through `prepared`, `draining`, `updating`, `restarting`, `verifying`, and `releasing`. It becomes `succeeded` only after the current service invocation reports the pulled SHA, both functional probes pass, both admission gates are released, and the same invocation and runtime SHA pass the functional service probe again immediately before terminal success. Invocation drift or an unprovable final health boundary makes the run `ambiguous`, never succeeded. A dead runner in any externally ambiguous phase is classified the same way.

After success, each distinct waiting `(provider session, Slack channel, visible Slack thread)` receives one explicit `deployment_verification` turn. It waits while that session is running and proceeds only when the exact persisted session is idle; `error`, `archived`, and every other non-idle state park with a durable notice. An admitted wake uses the original provider UUID, model, reasoning effort, and Slack thread. Its immutable input names the requested commit(s), deployed commit, service invocation, and health evidence, and asks the same agent to inspect the live behavior, fix a regression, and deploy again if necessary. The turn has its own status reply and advances the existing cumulative thread summary, but it has no synthetic Slack user message and therefore no hourglass reaction.

Failed or ambiguous runs never create verification turns. A requested commit that is not an ancestor of the deployed commit also does not create one. Those outcomes create durable, idempotent Slack notices instead. If the original provider mapping has changed, Concierge parks the wake and posts a notice; it never substitutes a fresh provider session. Crash recovery retries a wake only while provider admission was provably not attempted. Once admission intent is durable, an interrupted wake is parked to avoid a duplicate provider turn.

Inspect a known run without changing it:

```bash
CONCIERGE_STATE_DIR=/root/.local/state/concierge \
  /root/.bun/bin/bun run bot/scripts/deploy-state.ts show --run-id <run-id>
journalctl -u concierge-deploy-<run-prefix>.service
```

`bot/src/deployment-state.ts`, `bot/src/deployment-worker.ts`, `bot/scripts/deploy-state.ts`, and `bot/tests/deployment-state.test.ts` are the focused authorities for batching, recovery, wakes, and failure notices.

## Staged repair control plane

Normal deploy installs and starts the protected deployment kernel, root-only
provider credential adapter, and non-root coordinator; installs the incident
repair/review templates; routes application activation and post-activation restoration
through the immutable release boundary, and preflights the deterministic
notifier. Changed control bundles or units restart in kernel, adapter,
coordinator order; deploy verifies the startup-captured kernel version and
adapter/coordinator version markers before release preparation. The installed tmpfiles
authority creates `/var/lib/concierge-deploy`, `/var/lib/concierge-repair`, and
`/var/lib/concierge-review` with their dedicated owners on a clean boot. The
coordinator is intentionally observe-disabled and agent requests
continue to use the proven legacy batch. The checked-in settings must remain:

```text
CONCIERGE_DEPLOYMENT_CONTROL_ENABLED=0
CONCIERGE_ENABLE_CONTROL_REQUESTS=0
CONCIERGE_AUTONOMOUS_REPAIR_ENABLED=0
```

Do not enable one flag in isolation. The activation boundary is the complete
rollout sequence in [the deployment repair architecture](../architecture/DEPLOYMENT-REPAIR.md),
including an initial immutable last-known-good release, production-equivalent
security negatives, and a contained restore drill.

Inspect the staged control plane without mutating it:

```bash
systemctl status concierge-deployment-kernel.service concierge-deployment-provider-adapter.service concierge-deployment-coordinator.service
/root/.bun/bin/bun run bot/scripts/deployment-repair/control.ts snapshot
journalctl -u concierge-deployment-kernel.service -u concierge-deployment-provider-adapter.service -u concierge-deployment-coordinator.service --since "30 min ago"
```

Protected kernel or policy changes are versioned separately from repair-owned
code. After independent review of that exact diff, the first authorized rollout
sets `CONCIERGE_APPROVE_CONTROL_PLANE_UPDATE=1` only for the deploy invocation.
Leaving it set would turn a one-shot operator promotion into ambient authority.
Ordinary later deploys refuse to replace a changed protected bundle without a
new explicit promotion.

The control database is inside the existing `/root` backup boundary. Immutable
release artifacts live under `/var/lib/concierge-deployment` and join the
machine-level `/var/lib` backup boundary. Never edit the control database,
installed bundle, release directories, or stable pointer directly.

The normal deploy is currently the only authority that activates and promotes a
release. The autonomous coordinator must remain disabled until the real-unit
repair/review/provider denial matrix, non-root application candidate, synthetic
end-to-end incident, and contained rollback gates in the architecture are all
proven. The repair and review workers are never started manually: the protected
kernel creates their exact incident packet and repository/snapshot first, then
systemd starts only the corresponding UUID instance.

The adapter consumes `/root/.codex/auth.json` as the existing credential
authority and never copies it into a worker home. If it restarts during an
incident, the worker asks the kernel to re-admit the same persisted short-lived
capability before resuming its exact provider session. A review correction
rotates that capability while preserving the exact session and repository.
Provider-launch intent is durable before Codex starts; an interrupted fresh
launch with no proven UUID parks as ambiguous instead of creating another
session. Request and streamed-response bodies are bounded at the adapter. A
missing or mismatched capability fails the worker closed; do not copy an auth
file or provider token as a workaround.

Notification reconciliation is automatic while control reconciliation is
enabled. A `sending` or `ambiguous` deterministic notice is searched by its
fixed identity until delivered or terminally parked; it is never reposted.

`/usr/bin/bwrap` is also a control-plane prerequisite. The kernel uses it for
every Git inspection or export of a repair-owned repository, running Git as the
repair UID with no network and no host view beyond that repository and system
binaries. A missing Bubblewrap binary therefore blocks repair safely; do not
fall back to root Git against the incident repository.

## One-time managed-project scaffold cutover

The canonical instruction-source migration is not a normal deploy and must not run from an isolated feature worktree. After its implementation branch is reviewed, committed, pushed, and integrated into `main`, follow [channel adoption and scaffold migration](CHANNEL-ADOPTION.md): run the dry inventory, review its exact exception set, then invoke `bot/scripts/project-scaffold-cutover.sh` once.

The cutover wrapper deliberately reuses this runbook's provider deployment gate, capture hold, service stop, deployment, and health probe. Its durable cutover state blocks startup through early/mid failure, resumes incomplete Git propagation, and forces an all-Slack-visible-channel Canvas refresh before startup publishes `concierge_bot_online`. Do not reproduce those steps manually or add a second admission mechanism. Recovery commands and phase distinctions are in the channel-adoption runbook.

## First drain-aware rollout

The first upgrade from a service without the database admission gate uses the guarded bootstrap once:

```bash
git fetch origin
git show origin/main:bot/scripts/bootstrap-deploy.sh > /tmp/concierge-bootstrap-deploy.sh
chmod +x /tmp/concierge-bootstrap-deploy.sh
/tmp/concierge-bootstrap-deploy.sh
```

The bootstrap waits until the legacy service cgroup is empty, freezes and reinspects the complete cgroup, stops the service, and creates a one-time mode-600 token. The new deploy requires that exact token and an inactive service before bypassing the normal database gate. If pulling fails, the legacy service remains stopped rather than reopening unsafe admission.

Capture acquires its own deployment gate before the bot gate and changes it to a durable hold before Concierge becomes unavailable. The hold is released only after capture ingress and the new bot pass functional health. See [capture ingress architecture](../architecture/CAPTURE-INGRESS.md).

The first capture-ingress installation also creates two independent mode-600
secrets under `/etc/concierge`: the external Pebble route bearer and the private
queue bearer. Later deploys preserve both. The public service receives no Slack
credential; Concierge receives the queue bearer and continues to use its
existing Slack user token.

After the origin is healthy, publish the readable hostname from the repository
root:

```bash
wrangler deploy --config cloudflare/capture-worker/wrangler.toml
curl --fail https://capture.tejas.nyc/health
```

The Worker exposes only exact `POST /pebble` and `GET /health` requests. The
existing `sslip.io` origin remains the Caddy termination point and `/audio`
fallback; it is not replaced by the Worker.

## Shutdown and runtime dependencies

`concierge-bot.service` uses `KillMode=mixed`: graceful stop sends `SIGTERM` only to the main process so it can wait for provider children, while forced `SIGKILL` applies to the cgroup. `TimeoutStopSec=infinity` prevents escalation merely because valid provider work is long-running.

Deploy installs the frozen production dependency graph before restarting either service; the focused deploy test performs that exact clean install from the committed manifest and lockfile. The service checks `/usr/bin/node` and `/usr/bin/python3`, starts the managed Codex App Server daemon, and then starts Concierge. Python is used only by the TODO synchronizer's small `renameat2(RENAME_EXCHANGE)` helper. Startup must complete a real `model/list` request before publishing `concierge_bot_online`, and the external healthcheck repeats that provider probe. Codex controllers and the Remote observer multiplex through one persistent Concierge client connected to `/root/.codex/app-server-control/app-server-control.sock`; they do not own or stop the daemon. A persistent Node bridge performs only the WebSocket-over-Unix framing because Bun does not expose that client transport. `/usr/bin/node` is the default bridge runtime; `CONCIERGE_NODE_BIN` may override it for a manually started service, while the checked-in systemd unit deliberately fails fast unless the standard host path exists. `CONCIERGE_CODEX_APP_SERVER_SOCKET` may override the socket for an intentional installation; the checked-in unit is the authority for the managed Codex binary. `codex app-server daemon bootstrap --remote-control` is the one-time host pairing/bootstrap operation; normal deploy uses `daemon start` and preserves the existing Remote-control setting.

`agent-inbox.service` retains its historical name for `/audio` compatibility. Its security and shutdown contract is documented in [capture ingress architecture](../architecture/CAPTURE-INGRESS.md). Repository Monologue and journalmaxx units are stubs; Concierge deploy does not replace the live one-minute Monologue poller owned by `/root/workspace/remote-box`.

Slack audio fallback uses the pinned local `whisper.cpp` runtime. `bot/scripts/install-transcriber.sh` installs dependencies, builds for the host CPU, and downloads the `base.en` model. Deploy runs it idempotently. Do not use the upstream container on AX41 because its binary requires AMX.

## Backups and restore boundary

Concierge owns no backup scripts. The machine-level `/root/workspace/remote-box` project snapshots `/root`, `/etc`, and `/var/lib`, including bot state, the capture queue, and `/etc/concierge`.

Restore bot state, then restart:

```bash
/root/workspace/remote-box/scripts/restic.sh restore latest --target / --include /root/.local/state/concierge/state.db
systemctl restart concierge-bot
```

Restore capture state, then restart ingress:

```bash
/root/workspace/remote-box/scripts/restic.sh restore latest --target / --include /var/lib/concierge-capture/state.db
systemctl restart agent-inbox.service
```
