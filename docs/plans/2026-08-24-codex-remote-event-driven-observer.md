# Event-driven Codex Remote observer

Status: approved implementation design after independent review (`SHIP`)

## Operating profile and evidence

Slack Concierge is a personal, single-operator service. It currently has 63 eligible Slack-to-Codex mappings and shares one physical App Server connection across normal turn controllers and the Remote observer. App Server pushes subscribed `item/completed` events. The current observer additionally rereads every mapped thread's full history every ten seconds; no observed healthy-connection notification-loss incident justifies that recurring fleet scan.

Two concrete requirements remain:

- activity initiated in another Codex client must project into the uniquely mapped Slack thread;
- a received external user item must be durably ordered before its external final, including when local SQLite persistence is temporarily unavailable.

## Design

The observer remains a logical subscriber on Concierge's shared App Server connection.

- On process start and App Server reconnect, enumerate eligible mappings once and call `thread/resume(excludeTurns: true)` once per mapping. Isolate a stale thread so it cannot block the rest.
- Do not read thread history to subscribe, establish a baseline, reconcile notifications, or repair an idle connection.
- New Slack-created sessions need no mapping poll: their controller starts or resumes the provider thread on the same physical connection and persists the mapping before provider item completion. The observer resolves the current durable mapping when the pushed item arrives.
- Serialize relevant pushed notifications in arrival order. Persist the notification's authoritative completed item directly. If local persistence fails, retry that same in-memory item with capped backoff while the process remains alive; do not scan unrelated history.
- Resolve event eligibility with an indexed provider-thread-keyed query, never the startup fleet-list query. The first external user item durably binds its provider turn to the authorizing session and Slack destination. A later final must use and revalidate that same binding; a rebind, archive, deletion, ambiguity, or channel-policy change suppresses or parks the final instead of rerouting half of the turn.
- Replace the 500 ms delivery claim loop with a wake latch. Wake it once after startup claim recovery and after a durable observation. A Slack retry owns one timer for its actual due time; when no delivery or retry is pending, the loop performs no work.
- Archived Concierge sessions are not eligible subscriptions. The repository does not currently expose a general operator retirement flow, so this change does not pretend archival already bounds the mapping population or add a speculative retention system.
- Keep durable provider-item identity, mapping revalidation before Slack delivery, deterministic Slack client IDs, and the durable delivery queue. Stop writing the history-baseline subscription and observed-item ledgers; the mirror-event identity is sufficient when history is never replayed. Leave their existing tables untouched rather than introducing a destructive cleanup migration.

## Work budget

- Healthy idle: zero history RPCs, zero delivery claims, and zero timer-driven observer work.
- Startup/reconnect: `O(M)` summary-free resume requests for `M` eligible, non-archived mappings; at the current cardinality, 63 or fewer.
- Relevant provider event: one indexed lookup by provider thread plus one local durable observation; retries touch only that event.
- Persistent growth: one durable mirror row per mirrored external item and one binding row per external turn. These are the delivery/idempotency ledger, not a copy of every App Server transcript item. They remain until measured database pressure justifies a concrete retention requirement.

## Acceptance criteria

1. No ten-second timer, periodic subscription refresh, or observer `thread/read(includeTurns: true)` remains.
2. Startup and reconnect subscribe each eligible mapping once and continue past stale mappings.
3. New mapped sessions are discovered from pushed events without polling.
4. Relevant events use their pushed item identity and are persisted in FIFO order; a transient local write failure retries only that item.
5. The first external item binds its provider turn to one authorizing session/destination. Current mapping and channel policy are applied at observation time and again before delivery; a rebind between request and final cannot split the turn across destinations.
6. Archived sessions are excluded from the eligible mapping query.
7. Provider-event and delivery validation use provider-thread-keyed indexed lookups, not the startup fleet-list query.
8. A focused test proves multiple idle intervals cause zero history reads and zero delivery claims, while startup/reconnect and one event have the bounded call counts above.

## Non-goals

- No new broker, cursor store, scheduler, cache, webhook, or generalized sync engine.
- No speculative active-set policy beyond the session archival state Concierge already owns.
- No history recovery for an unobserved notification gap until App Server exposes a concrete lag signal or production evidence demonstrates the gap.
