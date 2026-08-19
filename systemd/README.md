# Concierge systemd units

Files in this directory are the repository authorities for Concierge-owned systemd services. Deploy installs them; never edit the installed copies under `/etc/systemd/system` directly.

| File | Role | Operational reference |
| --- | --- | --- |
| `concierge-bot.service` | Primary Slack bot, provider drain, and child-process shutdown | [deployment runbook](../docs/runbooks/DEPLOYMENT.md) |
| `agent-inbox.service` | Authenticated external capture ingress; historical unit name retained for `/audio` compatibility | [capture ingress architecture](../docs/architecture/CAPTURE-INGRESS.md) |
| `concierge-capture.conf` | Dedicated capture service identity | [capture ingress architecture](../docs/architecture/CAPTURE-INGRESS.md) |

`monologue-poll.service`, `monologue-poll.timer`, and `journalmaxx-ingest.service` remain repository stubs for the larger capture/ingest requirements. AX41 has a separately installed Monologue poller that posts to `#slack-inbox`; Concierge deploy does not install or overwrite it. Do not infer the live poller's behavior from these stubs.
