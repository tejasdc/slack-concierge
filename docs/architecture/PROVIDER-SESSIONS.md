# Provider sessions, comparisons, and forks

This document describes how visible Slack threads bind to providers and how Concierge creates comparison and fork sessions. Executable aliases and state transitions live in source and focused tests.

## Selection and binding

`bot/src/aliases.ts` is the sole authority for text aliases, channel defaults, dispatch overrides, comparison defaults, models, and matching rules. Bare aliases omit a model so each provider CLI keeps its moving default. Selection happens only on a thread's first top-level message. Unknown or provider-invalid suffixes are complete non-matches and are not partially stripped.

Provider sessions are persisted in SQLite and locked for one admitted turn. Codex controllers and the Remote observer multiplex through one persistent Concierge client connected to the managed shared App Server daemon. Its Node bridge performs only the WebSocket-over-Unix transport that Bun lacks; it initializes once per connection and fans provider events out inside Concierge. Desktop and mobile Remote clients therefore see the same live thread and progress events. The clean Slack request is the real `turn/start` user input and carries a stable `clientUserMessageId`, preserving Codex's native preview and naming behavior. Dynamic skill, artifact, and response-fallback instructions travel in that turn's application-scoped `additionalContext`; they are not written into thread settings and cannot leak into a later loaded turn. A loaded project `AGENTS.md` suppresses the fallback only when Concierge can prove that it owns the cumulative `TL;DR:` response contract; otherwise every turn carries the fallback. Generated managed-project `AGENTS.md` is the durable owner. Claude Code uses stream JSON with replayed user messages, passes turn instructions through `--append-system-prompt`, and keeps stdin open while steering remains possible.

Once App Server accepts a turn, transport failure is not a terminal provider outcome. The controller retains the Slack session lock, reconnects, resumes the exact provider thread, and identifies the daemon-owned turn by provider turn ID or the stable user-message client ID. `thread/read(includeTurns=true)` replays completed items idempotently and proves whether the turn is still in progress or terminal. An inactivity boundary requests `turn/interrupt`, but an acknowledgment, timeout, or lost terminal event is not proof; the controller keeps reconciling exact history until App Server reports a terminal state. Only then does it release lifecycle ownership.

An uninitialized `single-persistent` channel uses one deterministic hidden session key independent of the triggering visible thread. Concurrent first messages contend on that lock, and the first provider UUID is bound with compare-and-set semantics. Once a visible Slack thread has an explicit session, that binding outranks the channel-wide default; comparison and fork children cannot fall back to the shared session.

## Codex Remote control surface

Slack remains the session-origin surface. A long-lived observer tracks only per-thread provider UUIDs with exactly one Slack-session mapping; it never starts a Codex thread and never creates a top-level Slack message. Because controllers and observation share one App Server subscription, removing a mapping only removes local tracking and must not send `thread/unsubscribe`, which could blind an active controller. Single-persistent channels have no unique visible-thread destination and are therefore not mirrorable. `#slack-inbox` is additionally excluded by default, and `CONCIERGE_CODEX_REMOTE_INCLUDE_CHANNELS` / `CONCIERGE_CODEX_REMOTE_EXCLUDE_CHANNELS` accept comma-separated channel names or IDs.

At process startup, the first subscription to an already-existing provider thread records its current item IDs as a no-post baseline. A Slack-created session persists its provider UUID immediately after thread start/resume and before turn admission. Unknown-thread notifications re-check that durable mapping, while every periodic subscription refresh rereads history; either path closes first-turn SQLite failures and notification gaps without replaying old sessions. A stale provider thread is isolated so healthy subscriptions continue. Slack-originated initial and steering inputs share the `slack-concierge:` client-message prefix and are ignored. Every external user item is durably classified and projected to the existing Slack thread with a deterministic Slack message ID. Text is preserved; image and audio inputs get explicit typed placeholders; skills and mentions retain their names; and an unknown future content kind also gets a fail-closed placeholder rather than disappearing. A monotonic observation sequence keeps the request ahead of its response in the delivery queue. Each item also stores the exact session row that authorized its destination; both claim and immediate pre-post delivery revalidate that the provider UUID still has exactly one eligible mapping, including the current channel include/exclude policy. Once Slack acknowledges a post, local delivery-state reconciliation retries without reposting; a restart recovers the `sending` claim and reuses the same Slack client ID. A final agent message is mirrored only for a turn that began outside Concierge; an unclassified final remains unobserved until history can first persist its external user input. The ordinary Slack turn lifecycle remains the sole owner of Slack-started results. Unmapped or ambiguously mapped provider sessions remain Codex-only.

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

Modal submission durably claims a request by Slack view ID before it creates the thread. Retries reuse the claim, and startup reconciles nonterminal requests against their provider turns. A request becomes `done` only after durable response delivery.

Authority: `bot/src/comparison.ts`, comparison transitions in `bot/src/state.ts`, shortcut handling in `bot/src/index.ts`, and `bot/tests/comparison.test.ts`.

## Provider-session forks

Slack slash commands are unavailable in a thread reply composer, so `/fork` is the channel-composer convenience and `Fork from here` is the point-in-time message shortcut. A successful fork posts a new top-level Slack anchor; replies continue the child provider session. A reply inside the source thread cannot be a fork anchor because Slack has no nested threads.

For Codex, each Concierge turn persists its App Server turn ID. A point-in-time fork passes the exact selected ID as inclusive `lastTurnId` to one-shot `thread/fork`. It never invokes the interactive `codex fork` TUI or a nonexistent `codex exec fork` command. Every explicit boundary must be proven. If later steering was accepted into the same Codex turn, the original request is no longer an exact boundary; the completed agent response is. Legacy backfill succeeds only when canonical replay text uniquely identifies one Codex turn. Forks set `deferGoalContinuation=true` so a cloned active goal cannot run before the user asks something in the child thread.

Claude Code exposes whole-session forking but no proven point-in-time boundary. Its message shortcut is rejected; bare `/fork` remains available for the latest complete session.

Fork creation follows the durable lifecycle:

```text
claimed -> forking -> forked -> delivering -> binding -> delivered
```

The request stores a unique recovery marker and deterministic Slack message ID before provider work, then records the child provider UUID before Slack delivery. `binding` persists Slack's top-level timestamp before session creation so a known anchor is never reposted. Transient Slack failures retry the same ID; permanent failures park without discarding the child.

Recovery first proves the previous process owner dead. Interrupted Codex recovery requires both the exact `forkedFromId` and recovery marker from App Server thread enumeration. `parentThreadId` identifies sub-agents and is not a fork-recovery key. Zero matches may retry only from a dead owner; multiple matches remain ambiguous. Claude interruptions remain ambiguous because its CLI has no equivalent marker. Only invalid-parameter JSON-RPC errors are definite rejection; internal errors enter ambiguous recovery.

Authority: `bot/src/fork-requests.ts`, fork transitions in `bot/src/state.ts`, `bot/src/codex.ts`, `bot/tests/fork-requests.test.ts`, and focused fork cases in provider/state tests.
