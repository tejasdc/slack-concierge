# Concierge systemd units

`concierge-bot.service` is the source of truth for the primary service. Deploys
copy it to `/etc/systemd/system` before reloading systemd. Do not edit the
installed unit directly; the next deploy replaces it.

`agent-inbox.service` is the source of truth for the authenticated external
capture ingress. The historical unit name is retained so deployment can replace
the old `/opt/agent-inbox.py` receiver without a second listener or a public
proxy change. Its routes are data in `config/capture-routes.toml`; bearer values
remain in mode-600 files under `/etc` and enter through systemd credentials.
`concierge-capture.conf` creates the dedicated service identity. Deploy builds
a root-owned runtime bundle under `/usr/local/lib/slack-concierge`, verifies
the separately installed `chat:write`-only token from
`capture-slack-app-manifest.json`, and requires the local `/health` probe to
pass. The unit uses `ProtectSystem=strict` and can write only its private state
directory and the legacy audio directory. `TimeoutStopSec=infinity` and Bun's
non-destructive server stop preserve long-running Watch uploads across deploys;
the request idle timeout prevents a dead connection from holding shutdown.

The first rollout from a version without turn ownership uses
`bot/scripts/bootstrap-deploy.sh` as documented in `AGENTS.md`. The bootstrap
waits for an empty legacy service cgroup, freezes and reinspects it to close
admission without a race, and only then stops it and changes the checkout.
Normal releases use `bot/scripts/deploy.sh` and its database gate.

`concierge-bot.service` uses `KillMode=mixed`, so SIGTERM reaches only the main
bot during graceful drain. Provider children remain alive until the bot has
waited for them; explicit forced cleanup still targets the complete cgroup.

The repository copies of `monologue-poll.service`, `monologue-poll.timer`, and
`journalmaxx-ingest.service` remain stubs for the larger capture/ingest
requirements. AX41 currently has a separately installed Monologue poller that
posts to `#slack-inbox`; it is not installed or overwritten by Concierge deploy.
The mismatch is explicit here so a future migration does not mistake the stubs
for the live poller.
