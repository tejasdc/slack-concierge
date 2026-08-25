# Provider sessions, comparisons, and forks

This document describes how visible Slack threads bind to providers and how Concierge creates comparison and fork sessions. Executable aliases and state transitions live in source and focused tests.

## Selection and binding

`bot/src/aliases.ts` is the sole authority for text aliases, channel defaults, dispatch overrides, comparison defaults, models, and matching rules. Bare aliases omit a model so each provider CLI keeps its moving default. Selection happens only on a thread's first top-level message. Unknown or provider-invalid suffixes are complete non-matches and are not partially stripped.

Provider sessions are persisted in SQLite and own at most one `running` or
`delivering` turn. Additional accepted inputs for the same `session_id` remain
ownerless durable turns and are promoted in admission order; different sessions
remain independently runnable. Codex controllers and the Remote observer
multiplex through one persistent Concierge client connected to the managed
shared App Server daemon. Its Node bridge performs only the WebSocket-over-Unix
transport that Bun lacks; it initializes once per connection and fans provider
events out inside Concierge. Desktop and mobile Remote clients therefore see
the same live thread and progress events. The clean Slack request is the real
`turn/start` user input and carries a stable `clientUserMessageId`, preserving
Codex's native preview and naming behavior. Dynamic skill, artifact, and
response-fallback instructions travel in that turn's application-scoped
`additionalContext`; they are not written into thread settings and cannot leak
into a later loaded turn. A loaded project `AGENTS.md` suppresses the fallback
only when Concierge can prove that it owns the cumulative `TL;DR:` response
contract; otherwise every turn carries the fallback. Generated managed-project
`AGENTS.md` is the durable owner. Claude Code uses stream JSON with replayed user
messages, passes turn instructions through `--append-system-prompt`, and keeps
stdin open while steering remains possible.

Once App Server accepts a turn, transport failure is not a terminal provider outcome. The controller retains the Slack session lock, reconnects, resumes the exact provider thread, and identifies the daemon-owned turn by provider turn ID or the stable user-message client ID. `thread/read(includeTurns=true)` replays completed items idempotently and proves whether the turn is still in progress or terminal. An inactivity boundary requests `turn/interrupt`, but an acknowledgment, timeout, or lost terminal event is not proof; the controller keeps reconciling exact history until App Server reports a terminal state. Only then does it release lifecycle ownership.

An uninitialized `single-persistent` channel uses one deterministic hidden
session key independent of the triggering visible thread. Concurrent first
messages share that session: the first owns provider execution, later messages
queue durably with their own visible reply threads, and the first provider UUID
is bound with compare-and-set semantics before a successor reloads it. Once a
visible Slack thread has an explicit session, that binding outranks the
channel-wide default; comparison and fork children cannot fall back to the
shared session. Comparisons force a fresh session and therefore remain outside
the contention queue. Deployment-verification wakes yield to every accepted
queued or live Slack turn on the session. Archiving a session terminalizes its
already-accepted queued turns atomically, without creating a restart-visible
live owner, entering the provider, or reopening the archived session.

Provider rejection does not erase an accepted input. Concierge classifies a
confirmed terminal failure only before tool or artifact activity: 429/5xx,
rate-limit, overloaded, and temporary failures retry the same durable turn with
bounded exponential backoff; authentication, entitlement, subscription,
API-key, billing, and other definite failures park it with a visible resumable
turn ID. Unknown setup failures park rather than guess that replay is safe.
Queued retries and parked turns retain their place in the session FIFO, survive
restart and deployment drain, and use a new fenced attempt identity on resume.
An operator resumes an exact parked turn with
`bun run bot/scripts/session-turn-queue.ts resume --turn-id <id>`.
Post-admission outcomes without confirmed terminality, compatible provider
identity, or complete steering history are parked as ambiguous and preserved,
but that command refuses to replay them. Resume also proves the persisted
artifact reservation is absent or empty before changing queue state.

## Codex Remote control surface

Slack remains the session-origin surface. A logical observer shares Concierge's App Server transport and never starts a Codex thread or creates a top-level Slack message. At process start and after a real connection loss, it enumerates active per-thread provider UUIDs with exactly one Slack-session mapping and calls `thread/resume(excludeTurns: true)` once for each. Resume subscribes that connection to subsequent provider events without loading transcript history. A stale provider thread is isolated so healthy subscriptions continue. The observer never sends `thread/unsubscribe`, because that would also blind controllers sharing the connection. A newly Slack-created session needs no mapping poll: turn execution emits an in-process session-bound event after the UUID is durable, and the observer resumes that exact thread on the shared connection. Single-persistent channels have no unique visible-thread destination and are not mirrorable. Archived sessions are ineligible, although the repository does not currently expose a general operator archival flow. `#slack-inbox` is excluded by default, and `CONCIERGE_CODEX_REMOTE_INCLUDE_CHANNELS` / `CONCIERGE_CODEX_REMOTE_EXCLUDE_CHANNELS` accept comma-separated channel names or IDs.

The observer consumes pushed `item/completed` notifications directly. It does not establish a history baseline, call `thread/read`, rescan mapped threads, or run an idle repair timer. Relevant notifications are serialized in arrival order. A transient SQLite failure retries that same in-memory notification with capped backoff, holding its later final behind it rather than rereading unrelated transcripts. Provider-thread-keyed indexed queries resolve eligibility; the startup fleet query is never used on the event or delivery path. Slack-originated initial and steering inputs share the `slack-concierge:` client-message prefix and are ignored.

The first external user item durably binds its provider turn to the exact authorizing session and Slack destination. Every later external item in that turn must match the same binding. Mapping drift, archive, deletion, ambiguity, or channel-policy exclusion suppresses or parks later work instead of rerouting part of one turn to another Slack thread. Text is preserved; image and audio inputs get explicit typed placeholders; skills and mentions retain their names; and an unknown future content kind gets a fail-closed placeholder rather than disappearing. The pushed provider item ID and a monotonic observation sequence provide idempotency and keep each request ahead of its response. Claim and immediate pre-post delivery both revalidate the binding. Once Slack acknowledges a post, local delivery-state reconciliation retries without reposting; a restart recovers the `sending` claim and reuses the deterministic Slack client ID.

Delivery is wake-driven: startup recovery and a newly persisted event wake the durable queue, while a real Slack retry owns one timer for its due time. With no event or retry pending, the observer performs zero delivery claims and zero recurring work. The mirror table retains one delivery/idempotency row per mirrored external item, and the turn table retains one binding row per external turn; it does not copy every App Server transcript item. The retired history-baseline subscription and observed-item tables remain untouched for safe schema compatibility but receive no new writes. A final agent message is mirrored only for a turn that began outside Concierge. The ordinary Slack turn lifecycle remains the sole owner of Slack-started results. Unmapped or ambiguously mapped provider sessions remain Codex-only.

Startup upgrades the pre-sequence mirror table transactionally when encountered: it copies every legacy row in SQLite `rowid` observation order, verifies row counts and foreign keys, then atomically replaces the old table. Unexpected legacy shapes fail closed without replacing either table.

Remote finals are visible thread replies but never advance the canonical cumulative summary: an app-originated turn does not inherit Concierge's application-scoped cumulative context, so its answer cannot prove that it summarizes the full Slack thread. Comparison and fork follow provider-thread identity across session rebinding and reject any Codex provider history containing external Remote input instead of replaying incomplete history.

Authority: `bot/src/codex-remote-observer.ts`, replay rejection in `bot/src/provider-replay.ts`, Remote tables and mapping queries in `bot/src/state.ts`, and `bot/tests/codex-remote-observer.test.ts`.

## Agent comparisons

`Compare w another agent` is the A/B surface. Its modal offers only `codex` or `claude-code`, defaults to the other provider, and resolves each through its bare alias default. A comparison always starts a fresh provider session in a new top-level Slack thread, including in `single-persistent` channels.

Concierge resolves the selected Slack message to its exact owning turn, including final delivery chunks. Selecting the cumulative-summary anchor resolves through its current durable summary cursor. The comparison input is persisted canonical user history through that boundary:

- Earlier entries are context and the last is the active request.
- Agent responses are excluded.
- Hydrated Slack links and completed audio transcripts are retained.
- A turn is replayable only after canonical input is stored and provider start is proven; raw Slack text is never a fallback.
- In-flight, preprocessing-failed, provider-unstarted, acknowledgement-ambiguous, and pre-canonical history is rejected.
- Histories with non-audio files are rejected because deleted temporary contents cannot be reproduced.

The new comparison thread's root identifies the source and target providers and displays the selected original Slack prompt or transcript in plain-text blocks. Earlier user prompts remain available to the comparison agent as context but are not repeated into the visible anchor.

The prebuilt wrapper bypasses ordinary mention stripping, skill selection, inline capture, and link hydration. It is sent over stdin to avoid host argument limits. Comparison agents retain normal tool permissions and can modify the project. Starting fresh, rather than resuming or forking, prevents the original provider's hidden state from contaminating the comparison.

Modal submission durably claims a request by Slack view ID before it creates the thread. Turn admission atomically attaches that request to the accepted turn, retries reuse the claim, and startup reconciles interrupted nonterminal requests against their provider turns. Provider retry and parked outcomes keep the comparison request nonterminal; durable response delivery marks it `done` in the same terminal transaction.

Authority: `bot/src/comparison.ts`, comparison transitions in `bot/src/state.ts`, shortcut handling in `bot/src/index.ts`, and `bot/tests/comparison.test.ts`.

## Provider-session forks

Slack slash commands are unavailable in a thread reply composer, so `/fork` is the channel-composer convenience and `Fork from here` is the point-in-time message shortcut. A successful fork posts a new top-level Slack anchor; replies continue the child provider session. For a point-in-time fork, that anchor links to the exact source Slack message and quotes a bounded plain-text preview captured with the durable request, so retries and recovery retain the same human-readable breadcrumb. A reply inside the source thread cannot be a fork anchor because Slack has no nested threads.

For Codex, each Concierge turn persists its App Server turn ID. A point-in-time fork passes the exact selected ID as inclusive `lastTurnId` to one-shot `thread/fork`. It never invokes the interactive `codex fork` TUI or a nonexistent `codex exec fork` command. Every explicit boundary must be proven. If later steering was accepted into the same Codex turn, the original request is no longer an exact boundary; the completed agent response is. Legacy backfill succeeds only when canonical replay text uniquely identifies one Codex turn. Forks set `deferGoalContinuation=true` so a cloned active goal cannot run before the user asks something in the child thread.

Claude Code exposes whole-session forking but no proven point-in-time boundary. Its message shortcut is rejected; bare `/fork` remains available for the latest complete session.

Fork creation follows the durable lifecycle:

```text
claimed -> forking -> forked -> delivering -> binding -> delivered
```

The request stores a unique recovery marker and deterministic Slack message ID before provider work, then records the child provider UUID before Slack delivery. `binding` persists Slack's top-level timestamp before session creation so a known anchor is never reposted. Transient Slack failures retry the same ID; permanent failures park without discarding the child.

Recovery first proves the previous process owner dead. Interrupted Codex recovery requires both the exact `forkedFromId` and recovery marker from App Server thread enumeration. `parentThreadId` identifies sub-agents and is not a fork-recovery key. Zero matches may retry only from a dead owner; multiple matches remain ambiguous. Claude interruptions remain ambiguous because its CLI has no equivalent marker. Only invalid-parameter JSON-RPC errors are definite rejection; internal errors enter ambiguous recovery.

Authority: `bot/src/fork-requests.ts`, fork transitions in `bot/src/state.ts`, `bot/src/codex.ts`, `bot/tests/fork-requests.test.ts`, and focused fork cases in provider/state tests.
