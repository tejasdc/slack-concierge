# Why the Thinkering sidebar feels overwhelming — measured from the production ledger

Read-only investigation. Database opened with `sqlite3 -readonly` / Python `sqlite3.connect(..., uri=True)`
against `file:/root/.local/state/concierge/state.db?mode=ro`. No writes were made. Snapshot taken
2026-09-25 ~23:51 UTC. WAL file present but query connections were read-only.

Source code read (not modified):
- `/root/workspace/thinkering/apps/web/src/session-filters.ts` — the sidebar's filter/sort logic.
- `/root/workspace/thinkering/apps/web/src/native-session-workspace.tsx` — where the filter is applied to the session list (line ~254) and where the Inbox session is excluded from that list (`session.id!==inbox?.id`).
- `/root/workspace/thinkering/packages/adapters/src/session-owner-views.ts` — `SessionView` shape.
- `/root/workspace/slack-concierge/bot/src/session-owner.ts` (`view()`, ~line 575-615) — how `archived`, `outcome`, `catalogueKind`, `origin`, `execution`, `needsAttention` are actually computed server-side.
- `/root/workspace/slack-concierge/bot/src/session-turn-outcome.ts` (`needsAttention`) — attention computation.
- `/root/workspace/slack-concierge/bot/src/session-inputs.ts` (`sessionInputProvenance`, `humanAuthored`) — the provenance/origin-chain logic that `originatingHuman` comes from; reimplemented in Python against the raw tables rather than imported, because it's TypeScript.
- `/root/workspace/slack-concierge/bot/src/session-communication.ts` (~line 660-725) — how a session-to-session request creates a new worker session and records `session_communication_requests` (source_session_id, target_session_id, request_id) plus a `kind='input', origin='agent', request_id=<id>` row on the new session.

Inbox session identified once: `id=3172`, `native_metadata_json.inboxRole='project-router'`, project `slack-inbox`, created 2026-09-16. The sidebar excludes this session from the ordinary list entirely and shows it as its own surface.

All queries/analysis code: `/root/workspace/agent-scripts/sidebar_analysis.py` (primary) plus several ad-hoc verification snippets quoted inline below with their output. The full annotated stdout of the primary script is `/root/workspace/agent-scripts/sidebar_out.txt`.

---

## 1. What the sidebar shows right now

The default filter is `'active'` (`sessionFilters[0]` in `session-filters.ts`). `matchesFilter` for `'active'`:

```
!archived && !isHistoricalEvidence(session) && (outcome==='open' || needsAttention || sessionInProgress(session))
```

with `archived = session.status==='archived'`, `isHistoricalEvidence = origin==='imported' && !nativeBinding`,
`outcome = metadata.outcome ?? 'open'` (defaults to **open** when never set), `sessionInProgress = execution in
{running,queued,waiting}`, and `execution` derived from the session's `turns` rows (latest/active turn status).
The Inbox session (3172) is additionally excluded by the workspace component, not by this filter.

Replicated this exactly against `sessions` + `turns` + `native_metadata_json` (1,020 total session rows in the ledger).

**Sidebar shows 303 sessions right now.**

Of those 303, classified by the *earliest* `session_inputs` row for each session (its creating input) —
`origin` is a hard column (`human`/`agent`/`service`); for `agent`-origin creators, `request_id` was joined to
`session_communication_requests.request_id` to get the dispatching `source_session_id`:

| Started by | Count |
|---|---|
| Tejas himself (earliest input `origin='human'`) | 10 |
| The Inbox dispatching his request (`origin='agent'`, source session = Inbox 3172) | 52 |
| Another agent, non-Inbox (agent-to-agent / subagent / worker-asking-worker) | 31 |
| Agent-origin but the source request row could not be resolved | 8 |
| **No `session_inputs` row at all** | **202** |

**Critical finding on that last row.** 202 of the 303 sessions the sidebar calls "active" — two-thirds of the list —
have *zero* rows in `session_inputs` at all. Checked every one: all 202 have a non-null `slack_channel_id`, all
were created between 2026-08-07 and 2026-09-15 (the day before Slack was deprecated per this project's `CLAUDE.md`),
191 are `codex` and 11 `claude-code`. They predate the native input-provenance ledger entirely. Because
`metadata.outcome` was never set on them, the filter's `outcome ?? 'open'` default keeps every single one of them
permanently in the "active" bucket — they can never leave "Active" unless something explicitly gives them an
outcome or archives them. Verification:

```sql
-- sessions with no session_inputs row at all
SELECT count(*) FROM sessions WHERE id NOT IN (SELECT DISTINCT session_id FROM session_inputs);  -- 873 (all-time)
```
```python
# of the 303 active-sidebar sessions, cross-referenced against that set: 202
# all 202: slack_channel_id IS NOT NULL; created_at BETWEEN 2026-08-07 and 2026-09-15
```

So of the 303 rows the sidebar renders as "active" right now, only **101** are post-convergence sessions with any
recorded provenance at all, and only those 101 can be meaningfully attributed to a human, the Inbox, or another
agent. The other 202 are Slack-era debris that never got closed out.

**Ever received a direct human message.** Across the 303 active-sidebar sessions, 67 have at least one
`session_inputs` row with `origin='human'` (any kind — includes read-marks; see §3 for the stricter "actual chat
message" cut).

**Active in the last 7 days.** Using `last_turn_at` (falling back to `created_at`) against 2026-09-25 23:51 UTC:
**58** of the 303 active-sidebar sessions were touched in the last 7 days. In other words, of what the sidebar
currently shows as "active," roughly 4 in 5 (245/303) have not moved in a week — mostly the 202 pre-convergence
Slack sessions above, plus older agent-dispatched sessions whose owning request settled long ago without an
explicit outcome change.

## 2. Agent-started sessions: do they trace back to a human?

Scoped to the 91 agent-started sessions inside the currently-active sidebar set (52 Inbox + 31 other-agent + 8
unresolved), walked the `session_inputs.source_input_id`/`source_run_id` chain backward (mirroring
`sessionInputProvenance()` in `bot/src/session-inputs.ts`, reimplemented directly against the tables) until
hitting a `humanAuthored` input or a broken link:

- **83 of 91** (91%) trace back to a human-authored input somewhere upstream — i.e. could in principle be nested under the request/thread that caused them.
- **8 of 91** do not resolve to any human origin in the chain (either the chain breaks, or it's genuinely agent-initiated with no traceable human ancestor — e.g. a research subagent spawned by another subagent whose own request row wasn't found).

All-time (not scoped to the current sidebar), the same walk over every session in the ledger:

- **130** sessions total have an agent-origin creating input.
- **121 of 130** (93%) trace back to a human-authored input upstream.
- **9 of 130** do not.

Either way, roughly 9 in 10 agent-started sessions have a traceable human ancestor — nesting under "the
thread/request that caused it" would apply to nearly all of them, not just a subset.

## 3. Inbox threads (topics)

```sql
SELECT state, count(*) FROM inbox_topics GROUP BY state;
SELECT state, count(*) FROM inbox_requests GROUP BY state;
```

- **411** rows in `inbox_topics` total: **54 open**, **357 closed**.
- **432** rows in `inbox_requests` total: **53 open**, **379 closed**.

**Dispatches per request/topic.** `inbox_requests.dispatches_json` records, per request, the worker sessions the
Inbox dispatched for it (`{requestId, targetSessionId, targetTitle, outcome, state}`):

- **509** total dispatch entries across all 432 `inbox_requests`.
- **312 of 432** requests (72%) have at least one dispatch; the rest were answered by the Inbox directly with no
  worker spawned.
- Dispatches per request (for the 312 with ≥1): min 1, mean 1.63, max 21.
- **200 of 411** topics (49%) have at least one dispatched worker session anywhere among their requests.
- Top 10 topics by total dispatch count: 53, 34, 25, 21, 14, 13, 12, 12, 10, 8 — one topic alone accounts for 53
  dispatched worker sessions; a long tail of topics have 0.

**Where do his thread replies actually go — confirmed NOT "always the Inbox."** The assumption in the brief
("today they all go to the Inbox") does not hold. Restricted to `kind='input'` rows (actual composed chat
messages; excludes read-marks, stops, etc. — see below for why that distinction matters) and to the precise set of
sessions whose *creating* input was a dispatch from the Inbox (82 sessions, all-time) or from another non-Inbox
agent (39 sessions, all-time):

| | Human chat messages (kind='input', origin='human') |
|---|---|
| Sent to the Inbox session (3172) itself, all-time | **740** |
| Sent directly into an Inbox-dispatched worker session, all-time | **111**, spread across **28 of 82** such workers |
| Sent directly into a non-Inbox-dispatched worker session, all-time | not separately tallied by volume; **10 of 39** such workers got at least one |

So **~87% (740/851)** of Tejas's chat messages that reach either the Inbox or an Inbox-spawned worker go to the
Inbox as designed, but **~13% (111/851)** go straight into a worker session, and over a third of Inbox-dispatched
workers (28/82) have received at least one such direct message from him at some point. This is a real, standing
exception to "they all go to the Inbox," not a hypothetical — Thinkering lets him open any session (including a
dispatched worker) from the sidebar and type into it directly, and he has done so repeatedly.

*Why the `kind` filter matters:* an unfiltered `origin='human'` count on the same worker-session set was 64/82
workers and included things like `{"action":{"kind":"read","generation":N}}` rows — UI read-receipt bookkeeping
generated just by opening the session, not an actual message. Filtering to `kind='input'` (has real `text`) is what
separates "he looked at it" from "he typed something into it."

`session_owner_events` has 35 rows with `kind='thread_link'` (a capture explicitly placed into a thread as an
answer) — confirms that mechanism exists and is used, but is two orders of magnitude smaller than ordinary message
volume, i.e. it's the exception-handling path, not the main flow either.

## 4. Sidebar ordering, grouping, and thread linkage

From `session-filters.ts` (`sessionListOrder`) and its use in `native-session-workspace.tsx` line ~254:

1. **Sort key 1:** sessions with `execution==='running'` right now float to the top.
2. **Sort key 2:** `pinned` sessions next.
3. **Sort key 3:** `updatedAt` (i.e. `last_turn_at`, falling back to `created_at`) descending — most-recently-touched first.

There is **no grouping** by project, by thread, or by anything else — `matchesFilter` + `.sort(sessionListOrder)`
produces one flat list. `needsAttention` sessions are *not* hoisted (deliberately, per a comment in the source
citing a 2026-09-24 correction from Tejas: attention gets "its own filter, its own count and a mark on the row,"
not reordering).

The Inbox session (3172) is filtered out of this list by identity (`session.id!==inbox?.id`) before the sort even
runs, and shown as a separate top-level surface instead.

**Nothing in the sidebar's data model links an ordinary session back to the Inbox thread/topic that caused it.**
The only connection that exists anywhere in the system is one level removed and not surfaced in this view:
- `session_communication_requests.target_session_id` (who dispatched this session and why), and
- `inbox_requests.dispatches_json[].targetSessionId` (the Inbox's own bookkeeping of which sessions it spawned for
  a given request/topic).

Neither is read by `session-filters.ts` or `native-session-workspace.tsx`'s list rendering; a session sitting in
the flat "Active" list carries no visible thread/topic/parent-request field, so from the sidebar alone there is no
way to tell that session 3585 belongs to the same conversation as topic X without cross-referencing the ledger by
hand (which is what this investigation did).

---

## Caveats / what was not fully verified

- `needsAttention` was reimplemented from `bot/src/session-turn-outcome.ts` (`(meta.needs??[]).some(need.generation > dismissedGeneration)`) directly against `native_metadata_json`, not exercised through the live TypeScript code — should match exactly since it's a pure function over stored JSON, but not independently unit-tested here.
- `execution` was reimplemented from the `turns` table per the formula in `session-owner.ts` `view()`; it omits the `external` (Codex lifecycle) branch for sessions whose `codexLifecycle.threadId` diverges from data already captured in `turns` — a small number of sessions could be misclassified as `idle` when the live view would show `running`/`uncertain` from external provider state. This does not appear to affect the 303 count materially since only 2 turns are `running` and 8 `queued` right now.
- `session_input_author_corrections` (cases where an input recorded as `origin='human'` was later corrected to an agent's test capture) was not applied — `humanAuthored()` in the real code checks this table and this analysis didn't join it. Given only a handful of such corrections are known to exist project-wide, this is unlikely to change the counts by more than one or two.
- The "9 of 91 unresolved" and "9 of 130 unresolved" agent-started sessions were not traced further into `session_peer_requests`, `fork_requests`, or `comparison_requests` (only `session_communication_requests` was joined for the `originatingHuman` chain and for source classification); some of the 8-9 unresolved cases may actually resolve via those tables and were left "unknown" rather than force-guessed.
- "Active in the last 7 days" uses `last_turn_at`/`created_at` as a proxy for "session was active," not a stricter definition tied to actual turn/message activity; this is a reasonable proxy but not identical to counting turns in the window.
