# Turn lifecycle and durable projections

This document describes the current Concierge turn lifecycle. Source and focused tests remain authoritative for executable state transitions and constants.

## Runtime ownership

Concierge accepts Slack events, binds each visible Slack thread to a provider session, prepares canonical provider input, runs Codex or Claude Code, and durably projects the result back to Slack.

- `bot/src/index.ts` owns Slack ingress, admission, command and shortcut registration, and routing.
- `bot/src/turn-execution.ts` coordinates an admitted turn through context preparation, provider execution, response delivery, and durable completion.
- `bot/src/turn-status-controller.ts` owns the current turn's ephemeral heartbeat and terminal status.
- `bot/src/thread-status.ts` and its state transitions own the visible thread's cumulative status projection.
- `bot/src/turn-list-effects.ts` owns Slack List collaboration around a turn.
- `bot/src/state.ts` owns persisted transitions, leases, recovery identity, and the SQLite schema.

Extend the responsible component instead of adding another lifecycle branch to `handleUserMessage` in `index.ts`.

## Responses and status projections

Every final provider response begins with `TL;DR:`. The summary is cumulative for its visible Slack thread. Concierge injects the prior durable summary into the next provider turn and enforces the prefix before delivery. Codex output is accepted only from its `final_answer` phase; Claude Code output is accepted from its terminal result, so progress commentary cannot become the final response.

Every admitted turn immediately posts a status reply. It receives elapsed time, provider-activity age, and tool-count heartbeats every 30 seconds, then becomes the turn's terminal status. A later request gets a new status reply. The hourglass reaction on the triggering message is a separate processing indicator whose removal is durably retried.

The first turn's status reply is also the thread's durable cumulative-summary anchor. Later turns have their own status messages while that first reply retains the last delivered cumulative `TL;DR:`. The summary cursor advances only after response delivery is durable. If Slack proves the shared anchor was deleted, the turn and thread projections clear their pointers atomically and recreate one shared message.

Terminal turn status and cumulative summary are durable ordered projections with persisted desired revision, `pending`/`sending`/`delivered`/`parked` state, and message generation. Heartbeats are intentionally lossy. Terminal projections must be delivered, retried, or parked before the provider-session lock is released. Projection bookkeeping must never replace a turn's `slack_bot_msg_ts` with the cumulative-summary timestamp.

Response delivery is monotonic. After Slack delivery is durably confirmed, later status or summary failure can park only its own projection and cannot demote the response. Before confirmation, unexpected failures relinquish pending delivery for recovery; only an explicit permanent Slack outcome parks it. Deterministic `client_msg_id` values make ambiguous creates retry the same generation, while a proven deletion advances to a fresh generation. Permanent response failure does not advance the cumulative summary.

Legacy threads lazily adopt their earliest status reply and synthesize request/outcome pairs on their next turn. Adoption uses Slack timestamps to prove visible-thread ownership. In a `single-persistent` channel, unresolved legacy turns never fall back to the shared provider-session anchor; losing an ambiguous old summary is safer than contaminating another thread.

## Recovery and liveness

Every provider, Slack, process, and SQLite boundary is non-atomic. Persist intent before side effects, use stable identities for retries, preserve ambiguous outcomes, and prove the exact previous process owner dead before reclaiming work.

Provider children have inactivity boundaries so a silent process cannot retain a session lock or block drain forever. Codex JSON-RPC admission calls time out after 30 seconds. Both transports terminate after 30 minutes without a parsed provider protocol event; malformed stdout and stderr chatter do not renew the lease. Claude's valid `keep_alive`, `tool_progress`, `tool_use_summary`, and `stream_event` frames renew it without changing output or steering state.

Claude succeeds only after exact initial-prompt replay and a final non-aborted result. Partial output followed by process exit is an error. Graceful closure escalates from `SIGTERM` to `SIGKILL` when necessary, and transport completion waits for proven child exit. These are inactivity limits, not total turn-duration caps.

Process heartbeats serialize and retry transient SQLite contention. Timer callbacks catch terminal failures so an interval rejection cannot crash the bot while durable ingress is still being persisted. Scheduled Canvas refreshes likewise catch asynchronous failures.

## Focused authority

- Turn coordination: `bot/src/turn-execution.ts`
- Turn and thread projections: `bot/src/turn-status-controller.ts`, `bot/src/turn-status.ts`, `bot/src/thread-status.ts`, `bot/src/thread-summary.ts`, `bot/src/turn-status-projection.ts`
- Delivery and recovery: `bot/src/delivery-worker.ts`, `bot/src/turn-reaction-cleanup.ts`, `bot/src/turn-recovery.ts`
- Focused tests: `bot/tests/turn-execution.test.ts`, `bot/tests/turn-status-controller.test.ts`, `bot/tests/thread-status.test.ts`, `bot/tests/thread-summary.test.ts`
