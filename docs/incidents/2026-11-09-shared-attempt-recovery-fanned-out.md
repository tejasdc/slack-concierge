---
failure: One stalled agent attempt shared by many Inbox requests came back as a separate recovery per request, so the router sent the same agent about a dozen near-identical requests.
date: 2026-11-09
fix_commits: []
cause_status: confirmed
---

# One agent received a dozen copies of the same continuation

## What was seen

On 2026-11-09 the Gemini Inbox router (concierge:9305) sent concierge:3425 about a dozen work
requests, each opening with "Continue …" and repeating the same instructions. Each came from its own
router turn started by a thread-upkeep recovery input. Several of the requests were for different
threads (topics ffca215e, 19e74029, 9f818cdc, 5658be1b, b034b49b), but each named the same prior attempt
(`1eb6fec9`). 3425 asked the router twice to batch them. The router agreed once and then continued,
and its Gemini allowance ran out around 03:40 UTC. The reporter described these as one thread. The
recorded inputs show they were one shared attempt across several threads.

## Cause

Thread upkeep admitted one recovery input per stuck request. When one dispatch was linked to many
requests and then stalled, each request became its own router turn. A fresh turn has no memory of
the previous turn's ask, so each turn sent the remaining work to the same agent again. Batching
depended on the router noticing, so it did not hold.

## Fix

Upkeep now groups stuck requests by their latest attempt. Requests that share one dispatch get one
recovery input that lists all of them. It tells the router to send the remaining work as one
request and to link that dispatch to each of them. A request alone in its group keeps its earlier
input identity and wording. A request with no attempt is never grouped.

## Acceptance scenario

- **Seed:** three open human requests in three threads, all linked to one dispatch to one agent;
  that dispatch stalls without a final reply.
- **Action:** the thread-upkeep pass runs.
- **Expected:** exactly one `thread-upkeep:` input reaches the Inbox router. Its text names all three
  requests and the one attempt, and each request gets a `topic-recovery:<request>:0` flag pointing at
  that one input. Before the fix, there were three inputs and three router turns.
- **Replayable offline:** yes (owner ledger fixture; no provider needed)
