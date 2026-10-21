---
failure: In an Inbox thread, the reply To list offered only the router and the newest agent, not every agent that had worked the thread.
date: 2026-10-09
fix_commits: [343b1f54, 8df16a96]
cause_status: confirmed
---

# The thread reply list left out agents that had finished

## What was seen

In thnkr.ing, a thread whose agents had finished offered only the Inbox router and the newest agent as reply targets,
so Tejas could not address an earlier agent that had worked the thread.

## Cause

Two reads computed reply targets. The live read (`replyTargets` in `bot/src/session-topics.ts`) had been widened to every
agent that worked the thread; the prepared thread read the app actually uses (`bot/src/prepared-topic-values.ts`) kept its
own older copy of the rule, and stored threads carried targets computed under that copy.

## Fix

343b1f54 moves the rule into `bot/src/reply-target-rules.ts` and makes both reads call it. 8df16a96 recomputes each
stored thread's reply choices once under that rule in `bot/src/prepared-topics.ts`, so existing threads are corrected
without a full rebuild.

## Acceptance scenario

- **Seed:** A thread with three agent sessions that worked it in turn, all finished, and a prepared topic row computed
  under the old rule.
- **Action:** Start the presentation worker and read the thread through the prepared route.
- **Expected:** Reply targets list the router and all three agents, identical to the live read's targets.
- **Replayable offline:** yes (scratch ledger and presentation store)
