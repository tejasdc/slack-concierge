# Session fit: what the router sees, what a receiving session is told, and its hand-back

Owner: `bot/src/session-fit.ts`. Design, consultation, reviews and Tejas's revision:
[2026-10-07 session fit for routing](../plans/2026-10-07-session-fit-for-routing.md).

Concierge records facts and never judges fit. The router chooses where work goes; the session that
receives it judges whether it fits and may hand it back [decision: router-decides-session-reuse] [decision: receiving-session-judges-fit].

## What is recorded

| Fact | Written by | When |
| --- | --- | --- |
| Context in use and window | `claude-code.ts` (main-thread `assistant` usage; `result.modelUsage[*].contextWindow`); `codex-session-observer.ts` (`thread/tokenUsage/updated`) | each result / each Codex report |
| A request's topic thread | `ask()` stores `topic_root_input_id`: its Inbox thread, else the thread of the human message its work started from | at send |

Table `session_workload`, one row per session. Nothing is computed from a transcript, and nothing counts compactions: Tejas rejected them as a signal [decision: receiving-session-judges-fit], and the count and its startup file scan were removed. `backfillRequestTopics` fills older requests' topic thread from the ledger once a minute after start.

## What the router sees

`sessions search` and `sessions context` add `workload` to each local candidate, outside `view()`:
context (tokens, window, share), execution, the open Inbox topics it handles, and `forTopic` for the
caller's topic (`--thread`, else the topic of the message its own work started from): `holds` and
the titles of the other open topics it is on. No score, no rule.

## What a receiving session is told, and how it pushes back

A work request to an existing session on a topic it does not handle yet opens with a factual note:
the topic, the other open topics it is on, and that it may hand the request back. The request
protocol (`REQUEST_PROTOCOL`) teaches every agent the same: `sessions reply <id>
--work-disposition failed --hand-back not-my-subject|too-loaded -- <what context it can give>`. The
request closes as failed (so dependents and Inbox topic requests treat it as not done), and the
requester's answer opens with `Handed back (…)` and a ready fresh-session command with `--consult`
pointing at the session that handed it back. A handed-back request no longer counts as that session
holding the topic.

`--consult <address>` on a new session puts a pointer to the earlier session at the top of its first
input.
