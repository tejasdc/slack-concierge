# Agent Sessions App Home

Concierge's Home tab is a private, per-user operational projection over the existing Slack Agent Sessions and provider-turn lifecycle. It shows at most twelve relevant sessions, prioritizing running work, recoverable failures, queued work, and then recent history. The bounded view stays below Slack's 100-block Home limit.

## Source of truth

App Home owns no independent session lifecycle. `sessions` owns provider continuity, `turns` owns work and retry safety, Agent progress owns current activity, and Slack Agent status projections own the native processing/active state. `listAgentSessionDashboardRows` assembles those records only when Home is opened or an in-scope event requests a refresh.

The service remembers which users opened Home only for the current process. Turn admission and settlement refresh those users; a restart loses that ephemeral awareness harmlessly because the next `app_home_opened` event republishes the complete view. There is no timer, poller, per-user cache, or background dashboard worker.

## Controls

Every row carries exact `session_id`, channel, thread, and representative `turn_id` identities. Every action re-resolves the row for the acting Slack user before doing work.

- **Open thread** is an exact Slack deep link.
- **Stop** is rendered only for a live turn and persists the same exact-turn stop request used by native Agent Stop before asking the active provider cancellation controller to stop.
- **Retry** is rendered only for a parked turn that passes the existing replay-safety conditions. `resumeParkedSessionTurn` remains the final authority at click time.
- **Rename** opens a modal and records a monotonic durable title projection before calling `agents.sessions.rename`. The `agent_session_title_changed` event reconciles native Slack renames into the same record.
- **Fork** is rendered only for completed provider-bound sessions. The click revalidates a stable exact session boundary and enters the existing durable fork-request workflow.

Slack's native Agent Sessions UI continues to own pinning and archiving; Concierge does not simulate controls Slack does not expose through the Agent Sessions API.

## Failure and recovery

Home publication is replaceable and can be retried by reopening or refreshing Home. It therefore needs no durable delivery record. A rename is an external side effect and uses `slack_agent_session_title_projections`, whose desired and projected revisions prevent an old completion from overwriting a later title. Interrupted claims return to pending during startup and the existing projection retry sweep handles transient Slack failures.
