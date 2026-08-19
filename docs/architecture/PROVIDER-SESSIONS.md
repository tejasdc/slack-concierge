# Provider sessions, comparisons, and forks

This document describes how visible Slack threads bind to providers and how Concierge creates comparison and fork sessions. Executable aliases and state transitions live in source and focused tests.

## Selection and binding

`bot/src/aliases.ts` is the sole authority for text aliases, channel defaults, dispatch overrides, comparison defaults, models, and matching rules. Bare aliases omit a model so each provider CLI keeps its moving default. Selection happens only on a thread's first top-level message. Unknown or provider-invalid suffixes are complete non-matches and are not partially stripped.

Provider sessions are persisted in SQLite and locked for one admitted turn. Codex uses its bidirectional App Server protocol. Claude Code uses stream JSON with replayed user messages and keeps stdin open while steering remains possible.

An uninitialized `single-persistent` channel uses one deterministic hidden session key independent of the triggering visible thread. Concurrent first messages contend on that lock, and the first provider UUID is bound with compare-and-set semantics. Once a visible Slack thread has an explicit session, that binding outranks the channel-wide default; comparison and fork children cannot fall back to the shared session.

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
