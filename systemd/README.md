# Concierge systemd units

Files in this directory are the repository authorities for Concierge-owned systemd services. Deploy installs them; never edit the installed copies under `/etc/systemd/system` directly.

`router-actions.sh` is also repository-owned even though it is not a unit. Deploy installs it at `/root/.local/bin/router-actions.sh`. Its `todo-add` operation writes `notes/TODOS.md` with an authenticated source-message idempotency marker and relies on the file watcher for Slack projection. Concurrent helper retries serialize through an immediate transaction on the existing Concierge state database before checking that marker and appending. `list-add` is retired and never calls the Lists API.

All posting verbs dispatch to `bot/scripts/router-post.ts`: `post`, `resume`, and `upload` select the user token; `audit` selects the bot token and confirms the triggering message's root before posting. `thread-of` exposes that exact lookup using the user token. Posting success returns JSON containing the exact message timestamp and Slack-provided permalink, with transient receipt reads retried internally under a bounded deadline. `resolve-upload` and `permalink` provide exceptional read-only recovery. See the [router helper runbook](../docs/runbooks/ROUTER-ACTIONS.md) for syntax, failure handling, and caller migration.

`trigger <turn-id>` uses the same backing script to resolve the exact active turn's originating channel, message, and reply root from the local state database, without a Slack token or API call. The explicit ID comes from the supplied artifact directory; ambient IDs and newest-row inference are not used.

`react <channel> <message-ts> <emoji>` returns a structured JSON receipt for
the exact outcome-reaction add and in-progress-reaction removal, including
idempotent Slack responses. HTTP, transport, response-shape, and Slack API
failures instead return structured JSON on stderr and exit nonzero; empty output
is never success.

| File | Role | Operational reference |
| --- | --- | --- |
| `concierge-bot.service` | Primary Slack bot, provider drain, child-process shutdown, and managed Codex App Server startup; application readiness is proven by `model/list` before the online marker | [deployment runbook](../docs/runbooks/DEPLOYMENT.md) and [Codex App Server lifecycle](../docs/runbooks/CODEX-APP-SERVER.md) |
| `agent-inbox.service` | Authenticated external capture ingress; historical unit name retained for `/audio` compatibility | [capture ingress architecture](../docs/architecture/CAPTURE-INGRESS.md) |
| `concierge-capture.conf` | Dedicated capture service identity | [capture ingress architecture](../docs/architecture/CAPTURE-INGRESS.md) |
| `concierge-deployment-repair@.service` | Root-trusted autonomous repair supervisor for one persisted failed deployment incident | [deployment repair architecture](../docs/architecture/DEPLOYMENT-REPAIR.md) and [deployment runbook](../docs/runbooks/DEPLOYMENT.md) |

`monologue-poll.service`, `monologue-poll.timer`, and `journalmaxx-ingest.service` remain repository stubs for the larger capture/ingest requirements. The live Monologue poller is owned and deployed by `/root/workspace/remote-box`: its one-minute timer targets one `Type=oneshot` service, so systemd leaves an active run in place instead of starting an overlapping poller. Concierge deploy does not install or overwrite it. Do not infer the live poller's behavior from these stubs.
