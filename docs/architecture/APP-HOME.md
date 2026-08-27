# Agent Sessions App Home

Concierge's Home tab is a private, per-user operational projection over the existing Slack Agent Sessions and provider-turn lifecycle. It shows at most twelve relevant sessions, prioritizing running work, recoverable failures, queued work, and then recent history. The bounded view stays below Slack's 100-block Home limit.

## Source of truth

App Home owns no independent session lifecycle. `sessions` owns provider continuity, `turns` owns work and retry safety, Agent progress owns current activity, Slack Agent status projections own the native processing/active state, and `deployment_turn_reactions` owns the deployment lifecycle state mirrored by 📦, 🛠️, 🚀, and 🛑. `listAgentSessionDashboardRows` assembles session records only when Home is opened or an in-scope event requests a refresh; the publisher joins the latest deployment reaction state for each session without copying it into dashboard-owned storage.

The service remembers which users opened Home only for the current process. Turn admission, settlement, and deployment-reaction settlement refresh those users; a restart loses that ephemeral awareness harmlessly because the next `app_home_opened` event republishes the complete view. There is no timer, poller, per-user cache, or background dashboard worker.

## Controls

Every row carries exact `session_id`, channel, thread, and representative `turn_id` identities. Every action re-resolves the row for the acting Slack user before doing work.

- **Open in main pane** is an exact canonical workspace permalink with the root `thread_ts`, rendered inside Home rather than as a Block Kit URL button. In Slack Web this route is intercepted by the existing client: the selected thread replaces the main pane, the Home dashboard remains in split view, and no browser tab is created. The authenticated workspace URL comes from `auth.test`, with `team.info` as a startup fallback; only if Slack supplies neither does the link fall back to the generic client URL.
- **Stop** is rendered only for a live turn and persists the same exact-turn stop request used by native Agent Stop before asking the active provider cancellation controller to stop.
- **Retry** is rendered only for a parked turn that passes the existing replay-safety conditions. `resumeParkedSessionTurn` remains the final authority at click time.
- **Rename** opens a modal and records a monotonic durable title projection before calling `agents.sessions.rename`. The `agent_session_title_changed` event reconciles native Slack renames into the same record.
- **Fork** enters the existing durable fork-request workflow. A completed session remains forkable as before. A running Codex session is also forkable once it has at least one completed provider turn: the button carries that exact completed `lastTurnId`, and the handler proves the boundary still belongs to the same session before forking. The partially executing turn is never copied. Claude Code exposes no point-in-time fork boundary, so its Fork control remains unavailable until the active turn settles.

Each row renders the latest session-owned deployment state using the same vocabulary as the durable Slack reaction projection: **📦 Deploying**, **🛠️ Repairing**, **🚀 Deployed**, or **🛑 Deployment parked**. The dashboard reads the reaction authority; it does not scrape emoji from Slack messages.

Slack's native Agent Sessions UI continues to own pinning and archiving; Concierge does not simulate controls Slack does not expose through the Agent Sessions API.

Slack also owns global navigation. Concierge cannot register its Home view as a new top-level navigation tab or programmatically place itself in a member's sidebar. The Agent feature supplies the supported top-bar split-view entry point, and members may place the Concierge app in a custom sidebar section through their own Slack preferences.

## Failure and recovery

Home publication is replaceable and can be retried by reopening or refreshing Home. It therefore needs no durable delivery record. A rename is an external side effect and uses `slack_agent_session_title_projections`, whose desired and projected revisions prevent an old completion from overwriting a later title. Interrupted claims return to pending during startup and the existing projection retry sweep handles transient Slack failures.
