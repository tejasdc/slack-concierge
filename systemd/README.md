# Concierge systemd units

Files in this directory are the repository authorities for Concierge-owned systemd services. Deploy installs them; never edit the installed copies under `/etc/systemd/system` directly.

`router-actions.sh` is also repository-owned even though it is not a unit. Deploy installs it at `/root/.local/bin/router-actions.sh`. Its `todo-add` operation writes `notes/TODOS.md` with an authenticated source-message idempotency marker and relies on the file watcher for Slack projection; `list-add` is retired and never calls the Lists API.

| File | Role | Operational reference |
| --- | --- | --- |
| `concierge-bot.service` | Primary Slack bot, provider drain, child-process shutdown, and managed Codex App Server startup; application readiness is proven by `model/list` before the online marker | [deployment runbook](../docs/runbooks/DEPLOYMENT.md) |
| `agent-inbox.service` | Authenticated external capture ingress; historical unit name retained for `/audio` compatibility | [capture ingress architecture](../docs/architecture/CAPTURE-INGRESS.md) |
| `concierge-capture.conf` | Dedicated capture service identity | [capture ingress architecture](../docs/architecture/CAPTURE-INGRESS.md) |
| `concierge-deployment-kernel.service` | Protected root deployment state/effect kernel and role-separated local sockets | [deployment repair architecture](../docs/architecture/DEPLOYMENT-REPAIR.md) |
| `concierge-deployment-provider-adapter.service` | Root-only, capability-gated adapter that injects the existing Codex credential into repair/review model transport without exposing it to worker tools | [deployment repair architecture](../docs/architecture/DEPLOYMENT-REPAIR.md) |
| `concierge-deployment-repair@.service` | Incident-scoped non-root Codex repair worker with a standalone credential-free Git repository and loopback-only model transport | [deployment repair architecture](../docs/architecture/DEPLOYMENT-REPAIR.md) |
| `concierge-deployment-review@.service` | Fresh non-root independent review worker over a root-owned read-only repair snapshot | [deployment repair architecture](../docs/architecture/DEPLOYMENT-REPAIR.md) |
| `concierge-deployment-coordinator.service` | Non-root, generation-fenced deployment reconciliation coordinator; installed observe-disabled until rollout gates pass | [deployment repair architecture](../docs/architecture/DEPLOYMENT-REPAIR.md) |
| `concierge-deployment-rollout@.service` | One non-root, systemd-restarted activation supervisor per rollout; owns only its fenced kernel lease and `rollout.sock` | [deployment repair activation plan](../docs/plans/2026-08-24-feat-activate-deployment-repair-plan.md) |
| `concierge-deployment.conf` | Dedicated coordinator, repair, review, and builder identities | [deployment repair architecture](../docs/architecture/DEPLOYMENT-REPAIR.md) |
| `concierge-deployment.tmpfiles.conf` | Clean-host state roots and ownership required before deployment service path sandboxing | [deployment runbook](../docs/runbooks/DEPLOYMENT.md) |

`monologue-poll.service`, `monologue-poll.timer`, and `journalmaxx-ingest.service` remain repository stubs for the larger capture/ingest requirements. The live Monologue poller is owned and deployed by `/root/workspace/remote-box`: its one-minute timer targets one `Type=oneshot` service, so systemd leaves an active run in place instead of starting an overlapping poller. Concierge deploy does not install or overwrite it. Do not infer the live poller's behavior from these stubs.
