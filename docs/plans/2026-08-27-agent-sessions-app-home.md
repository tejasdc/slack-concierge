# Agent Sessions App Home dashboard

## Goal

Give the single Concierge operator a private Slack-native dashboard for seeing and managing the Agent Sessions that Concierge already owns. The dashboard complements Slack's native Agent Sessions list; it does not replace Slack's session record, provider continuity, or thread history.

## Complete delivery unit

- Enable the existing app's Home tab and subscribe to native session-title changes.
- Publish a personalized Block Kit view when the operator opens Home.
- Render active/queued work, recoverable failures, and recent completed sessions from bounded queries over the existing session and turn tables.
- Link every row to its exact Slack thread.
- Bind Stop to the exact live turn, expose Retry only after the existing replay-safety check, rename through Slack's Agent Sessions API, and fork only from a revalidated stable session boundary.
- Refresh on Home opens, dashboard actions, turn admission, and turn settlement. Do no idle polling and persist no per-user view cache.
- Recover interrupted title projections with the same monotonic projection pattern used for session status.
- Verify the feature with focused tests and an exact-source run in one claimed Slack sandbox lane.

## State and ownership

The existing `sessions`, `turns`, Agent progress, and Agent status records remain authoritative. App Home is a disposable per-user projection. The only new durable state is rename intent, because Slack rename delivery is non-atomic and must survive process interruption. Native `agent_session_title_changed` events reconcile user edits back into that projection.

Every interactive payload carries the session, thread, and turn identities visible when the view was rendered. The handler then re-resolves those identities for the interacting user and rejects stale controls before producing a side effect.

## Non-goals

- Recreating Slack's native pin or archive controls.
- Backfilling historical non-Agent turns.
- Adding polling, a second dashboard database, dashboard preferences, search, pagination, or a separate web service.
- Changing provider-session ownership or the turn queue.

## Activation and rollback

Sandbox lane manifests are reconciled through the sandbox provisioner. Production requires uploading the tracked manifest and reinstalling the existing app; no new OAuth scope is required. Rollback is the prior commit plus the prior manifest, leaving session and turn records untouched.
