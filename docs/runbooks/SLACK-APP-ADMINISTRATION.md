# Slack app administration

## Manifest-first changes

Every OAuth scope and Slack feature change is manifest-first. `slack-app-manifest.json` is the sole Slack-app authority. Never change scopes only in Slack's App Config UI because a later reinstall from the repository manifest would silently remove them.

For a primary-app change:

1. Edit and commit `slack-app-manifest.json`.
2. Upload it at <https://api.slack.com/apps/A0BNG0WHUNQ/app-manifest> and reinstall.
3. If Slack rotates either token, copy the replacement from OAuth & Permissions to `/root/.config/concierge/slack.toml` on AX41.
4. Run `auth.test` and compare the `X-OAuth-Scopes` response with the manifest. Correct drift in the manifest and reinstall again.

## Agent-session feature activation

Agent sessions are an ordinary feature of the existing Concierge app. Do not clone the app, create a pilot app, backfill historical threads, or add a second production configuration.

The repository manifest declares Agent view, enables the writable App Home Messages tab, includes `assistant:write`, and subscribes to Slack's required `app_home_opened` event plus `agent_session_stopped`. Activate those changes with the primary-app reinstall above before deploying code that admits new turns in Agent mode.

After reinstall and the normal `bot/scripts/deploy.sh` deployment, use the existing app for the live smoke check:

1. Start a harmless request in one managed public channel. Confirm Concierge joins the channel, creates one timeline stream in the correct thread, and shows a native Agent session.
2. Start two turns in different threads. Confirm their status, progress cards, and Stop controls remain isolated.
3. Stop one harmless long-running turn. Confirm only that exact provider turn is cancelled and no final reply is manufactured.
4. Complete a turn. Confirm the progress stream stops, a separate final reply arrives, and the root changes to the labeled cumulative TL;DR only after final delivery.
5. Confirm an automatic retry creates no mention, while a failure requiring user action creates one durable tagged reply.

Persisted turns keep the `projection_mode` recorded when they were admitted. A turn already running at deploy time therefore finishes with its previous hourglass/status projection; newly admitted ordinary turns use Agent sessions. This is a single-deployment compatibility invariant, not a migration phase.

Comparison and fork shortcuts are manifest-backed. Comparison requires no additional scope. Slack permalinks use the existing history scopes. Audio downloads use `files:read`; there is no audio-specific scope.

Pebble capture requires no separate Slack app or additional OAuth scope. The
Internet-facing ingress receives no Slack token. It persists accepted captures,
and the trusted Concierge service posts them with its existing user token over
the private queue handoff. See [capture ingress architecture](../architecture/CAPTURE-INGRESS.md).
