# Slack app administration

## Manifest-first changes

Every OAuth scope and Slack feature change is manifest-first. `slack-app-manifest.json` is the sole Slack-app authority. Never change scopes only in Slack's App Config UI because a later reinstall from the repository manifest would silently remove them.

For a primary-app change:

1. Edit and commit `slack-app-manifest.json`.
2. Upload it at <https://api.slack.com/apps/A0BNG0WHUNQ/app-manifest> and reinstall.
3. If Slack rotates either token, copy the replacement from OAuth & Permissions to `/root/.config/concierge/slack.toml` on AX41.
4. Run `auth.test` and compare the `X-OAuth-Scopes` response with the manifest. Correct drift in the manifest and reinstall again.

## Sandbox lane apps

The four `Concierge Sandbox` lane apps are persistent manifest-backed clones,
not production installations and not per-worktree apps. Create, update,
authorize, import credentials for, and verify them only through the [reusable
Slack sandbox runbook](SANDBOX-TESTING.md). Its provisioner derives each clone
from the tracked manifest, changes only the lane display/bot identity, verifies
the exported manifest digest, and keeps every lane's configuration and browser
profile separate from production and the other lanes.

A normal code change does not reinstall a lane. When this manifest changes,
reconcile the sandbox clones from the reviewed revision. For every lane Slack
marks `authorization_required`, use its native App Settings **Install App**
action. The OAuth URL returned by the App Manifest API failed in this Enterprise
sandbox because it carried an empty redirect URI; it is not the installation
authority. Generate any new app-level token from that lane's App Settings.
Never use the primary app's administration URL for a lane, copy a production
token into sandbox configuration, copy credentials between lanes, or use the
dedicated sandbox admin browser for feature testing.

## Agent-session feature activation

Agent sessions are an ordinary feature of the existing Concierge app. Do not clone the app, create a pilot app, backfill historical threads, or add a second production configuration.

The repository manifest declares Agent view, enables the writable App Home Messages tab, includes `assistant:write`, and subscribes to Slack's required `app_home_opened` event plus `agent_session_stopped`. Activate those changes with the primary-app reinstall above before deploying code that admits new turns in Agent mode.

After reinstall (when manifest changes require it) and a healthy automatic deployment,
use the existing app for this live smoke check in a later user-initiated turn:

1. Start a harmless request in one managed public channel. Confirm Concierge joins the channel, creates a native progress message in the correct thread, and shows a native Agent session. Keep it running beyond six minutes: activity and the current planning step must still update, with native Stop enabled.
2. Start two turns in different threads. Confirm their status, progress cards, and Stop controls remain isolated.
3. Stop one harmless long-running turn. Confirm only that exact provider turn is cancelled and no final reply is manufactured.
4. Complete a turn. Confirm progress and planning cards finish, a separate final reply arrives, and the root retains the original request above its labeled cumulative TL;DR only after final delivery.
5. Confirm an automatic retry creates no mention, while a failure requiring user action creates one durable tagged reply.
6. Exercise a payload-sized progress response. Confirm continuation replies remain in the same thread, preserve earlier text, carry the current planning card, and do not change which provider turn native Stop cancels. A task's age alone must never create a continuation.

Persisted turns keep the `projection_mode` recorded at admission. Legacy turns retain
their hourglass/status projection. Existing Agent streams retain compatibility
finalization; new Agent turns use durable native message pages. No historical
backfill or mid-turn transport switch is performed.

Comparison and fork shortcuts are manifest-backed. Comparison requires no additional scope. Slack permalinks use the existing history scopes. Audio downloads use `files:read`; there is no audio-specific scope.

Pebble capture requires no separate Slack app or additional OAuth scope. The
Internet-facing ingress receives no Slack token. It persists accepted captures,
and the trusted Concierge service posts them with its existing user token over
the private queue handoff. See [capture ingress architecture](../architecture/CAPTURE-INGRESS.md).
