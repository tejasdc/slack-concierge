# Deployment and service operations

## Normal deploy

This repository is one peer in a Git-distributed codebase. Propagate code through origin and deploy with `bot/scripts/deploy.sh`; never edit installed units or project files directly on the service peer. The deploy script pulls, refuses conflicts, installs repository-owned units, and restarts only after drain safety is established.

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

Deploy asks `bot/scripts/drain-status.ts` whether provider turns have live owners. It waits 20 minutes between checks while work is live, with no maximum age. It proceeds past blocking rows only after process identity proves every owner stale. Indeterminate liveness fails closed.

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
