# Slack app administration

## Manifest-first changes

Every OAuth scope and Slack feature change is manifest-first. `slack-app-manifest.json` is the primary-app authority; `capture-slack-app-manifest.json` is the least-privilege capture-app authority. Never change scopes only in Slack's App Config UI because a later reinstall from the repository manifest would silently remove them.

For a primary-app change:

1. Edit and commit `slack-app-manifest.json`.
2. Upload it at <https://api.slack.com/apps/A0BNG0WHUNQ/app-manifest> and reinstall.
3. Copy replacement tokens from OAuth & Permissions to `/root/.config/concierge/slack.toml` on AX41.
4. Run `auth.test` and compare the `X-OAuth-Scopes` response with the manifest. Correct drift in the manifest and reinstall again.

Comparison and fork shortcuts are manifest-backed. Comparison requires no additional scope. Slack permalinks use the existing history scopes. Audio downloads use `files:read`; there is no audio-specific scope.

The external ingress never receives the primary app's broad token. Its separately installed capture app has exactly `chat:write`; deployment verifies its identity and exact granted scopes. See [capture ingress architecture](../architecture/CAPTURE-INGRESS.md).
