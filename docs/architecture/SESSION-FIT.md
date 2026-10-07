# Session fit: what the router sees, and the one decision it must state

Owner: `bot/src/session-fit.ts`. Design and its consultation and review:
[2026-10-07 session fit for routing](../plans/2026-10-07-session-fit-for-routing.md).

## What is recorded, and by whom

| Fact | Written by | When |
| --- | --- | --- |
| Context in use and window | `claude-code.ts` (main-thread `assistant` usage; `result.modelUsage[*].contextWindow`); `codex-session-observer.ts` (`thread/tokenUsage/updated`) | each result / each Codex report |
| Compactions | `claude-code.ts` on `compact_boundary`; the Codex observer on its compaction notice, once per turn | the moment it happens |
| Earlier compactions | `backfillSessionWorkload`, one pass a minute after start, sessions active in 14 days, into `compactions_before` | once |
| A request's topic thread | `ask()` stores `topic_root_input_id`: its Inbox thread, else the thread of the human message its work started from | at send |

Table `session_workload` (one row per session). Nothing here is computed from a transcript on a
read: search and context read one row and the session's last 300 work requests.

## What the router sees

`sessions search` and `sessions context` add `workload` to each local candidate, outside `view()`:
context (tokens, window, share), compactions (count, last, whether earlier history is counted),
execution, the open Inbox topics it holds, and `forTopic` for the caller's topic (its `--thread`, else
the topic of the message its own work started from): `holds`, `compactedSinceLastWork`, `needsFit`,
`because`. Labels and raw numbers, never a score.

## The one rule

A work request to an existing local session on a topic it does not hold, while it owns another open
topic or has compacted, needs `--fit "<why this session>"`. Without it the ask returns the facts and
the fresh-session command (`--provider … --consult <address>`). With it, the reason and the owner's
snapshot are stored on the request (`fit` in its payload) and put at the top of the receiving
session's input, which can return it failed as not its subject. Not judged: follow-ups, requests
with no Inbox topic, informational asks, new sessions, the Inbox and the messaging agent as targets
(`takesManySubjects` in `session-roles.ts`), peers, historical and consultation-only sessions,
ChatGPT. When Tejas named the session himself, the reason says so.

Logs: `session_fit_reason` (accepted with a reason, with the reason), `session_fit_reason_missing`,
`session_workload_backfilled`, `session_workload_record_failed`.
