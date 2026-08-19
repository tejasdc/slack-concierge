# Codex Remote and canonical TODO synchronization

Status: implementation contract

## Product boundary

- Slack remains the only supported session-origin surface. Codex desktop and mobile visualize and steer Slack-created Codex sessions.
- A Codex Remote user message is mirrored only when its provider thread already maps uniquely to a Slack session. Unmapped provider threads never create Slack messages or threads.
- `#slack-inbox` is excluded from Remote mirroring by default. Operators can configure channel-name or channel-ID allow and deny sets.
- `notes/TODOS.md` is the canonical project todo document. Slack Lists is an editable synchronized surface, not provider prompt context.

## Codex transport state machine

The managed Codex daemon owns provider threads. Concierge turn controllers and the observer are disposable logical subscribers multiplexed through one persistent client connection.

`disconnected -> connecting -> initialized -> subscribed -> disconnected`

- Concierge owns one persistent logical App Server client. A small Node bridge performs the WebSocket upgrade over the managed Unix control socket because Bun's WebSocket client does not support that transport; all turn control and observation multiplex through that single initialized connection.
- Clean user text is the sole `turn/start.input`; per-turn Concierge instructions use application-scoped `additionalContext`, so loaded sessions neither inherit stale instructions nor lose new skill or artifact context.
- The Slack session binding is persisted as soon as `thread/start` or `thread/resume` returns, before `turn/start`. The observer resumes every eligible mapped thread with `excludeTurns: true`, then remains subscribed.
- Reconnect enumerates current mappings and re-subscribes. It never starts a provider thread.
- Once a provider turn is accepted, disconnect and interrupt outcomes are reconciled by exact provider turn ID or stable user-message client ID. The Slack session lock remains held until `thread/read` proves a terminal turn.
- Threads that predate observer startup establish a no-post item baseline; mappings created afterward process their history. Unknown-thread notifications re-check durable mappings, and every periodic refresh rereads subscribed history, so first-turn persistence failures and notification gaps converge without replaying old sessions.
- Server-initiated requests are never answered by the observer; the controlling Codex client retains interactive ownership.

## Remote mirror state machine

Each provider item is identified by `(provider_thread_uuid, provider_item_id)` and is persisted before Slack delivery.

`observed -> pending -> sending -> delivered`

`sending -> pending` on ambiguous restart; `sending -> parked` only after terminal failure policy.

- `userMessage.clientId` beginning with `slack-concierge:` is Slack-originated and ignored.
- An external `userMessage` is mirrored to the existing Slack thread.
- If its provider turn is already a Concierge-owned turn, Concierge's normal turn lifecycle owns the final response.
- Otherwise, the external turn's final `agentMessage` is mirrored to the same Slack thread.
- Stable Slack `client_msg_id` values and the unique provider-item key prevent duplicate projection and loops. A database observation sequence preserves user-before-agent delivery even when provider IDs and timestamps do not sort that way. After Slack acknowledges a post, local state retries in place without reposting; crash recovery reuses the same client ID.
- Every queued item retains the exact session row that authorized its destination. Claim and post both revalidate that the provider UUID still has one per-thread Slack mapping; a duplicate, rebind, or deletion parks the item rather than guessing. One stale provider thread is isolated and cannot stop refresh of healthy mappings.
- A Remote final is mirrored as a visible thread reply but never updates the canonical cumulative summary because an app-originated turn does not inherit Concierge's per-turn cumulative context.
- Comparison and fork fail closed for a session after external Remote input, because that input is not yet representable in Concierge's canonical Slack replay history.

## TODO synchronization state machine

Reconciliation is serialized per channel. The durable base snapshot represents the last state known to be present on both surfaces.

`idle -> reading -> merging -> projecting -> committed`

`reading|projecting -> retryable` for transient failures; `merging -> conflict-notice-pending` for same-field conflicts.

- Rows use Slack row IDs in HTML comments: `- [ ] title <!-- Rec... -->`.
- File rows without a Slack ID are created in Slack and rebound to the returned ID.
- A one-sided title, completion, addition, or deletion is projected to the other side.
- Independent title/completion changes merge.
- If both sides change the same field differently, the file value wins. The deduplicated notice intent is persisted before the first external projection and activated with the stable merge base. Recovery preserves that intent across every crash gap. After Slack acknowledges it, local acknowledgement retries without reposting; a Slack delivery failure follows the normal retry-or-park policy.
- On first sync, the union is preserved; IDs win, then normalized titles deduplicate unbound rows.
- A Slack read or malformed response fails closed without changing the file or common base. Historical `[note]` and `[agent]` capture rows are excluded from the initial todo import.
- Reconciliation rewrites only top-level checklist lines and preserves headings, prose, fenced or indented code, blockquotes, HTML blocks, nested details, mixed line endings, and unrelated Markdown. Existing files use Linux atomic rename-exchange with a durable journal, so the canonical path is never absent; new files use a create-only link. Recovery distinguishes pre-exchange, post-exchange, and concurrent-edit states by content hashes, preserves ambiguous sides for inspection, and reruns from fresh state when an edit races projection. Shutdown drains all queued reconciliations.
- Scaffold adoption moves a legacy root `TODOS.md` byte-for-byte to `notes/TODOS.md` and archives the source. A divergent destination or archive collision is an explicit no-write ambiguity.
- Polling is the primary Slack-change detector because Slack documents List CRUD but exposes no public List-item Events API contract.
