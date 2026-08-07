# Concierge systemd units

`concierge-bot.service` is the source of truth for the primary service. Deploys
copy it to `/etc/systemd/system` before reloading systemd. Do not edit the
installed unit directly; the next deploy replaces it.

The first rollout from a version without turn ownership uses
`bot/scripts/bootstrap-deploy.sh` as documented in `AGENTS.md`. The bootstrap
waits for an empty legacy service cgroup, freezes and reinspects it to close
admission without a race, and only then stops it and changes the checkout.
Normal releases use `bot/scripts/deploy.sh` and its database gate.

`concierge-bot.service` uses `KillMode=mixed`, so SIGTERM reaches only the main
bot during graceful drain. Provider children remain alive until the bot has
waited for them; explicit forced cleanup still targets the complete cgroup.

`monologue-poll.service`, `monologue-poll.timer`, and `journalmaxx-ingest.service` are stubs for the larger capture/ingest requirements. They are intentionally explicit placeholders so systemd unit names and cadence are reserved without pretending the Monologue cursor or journalmaxx Linux port is complete.
