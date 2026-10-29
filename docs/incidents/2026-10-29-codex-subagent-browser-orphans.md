---
failure: Codex subagent browsers lacked the 20-minute idle shutdown and escaped end-of-turn cleanup.
date: 2026-10-29
fix_commits: []
cause_status: confirmed
---

# Spawned Codex agents left detached browsers running

## What was seen

On October 29, an agent-browser controller in a Thinkering worktree had lived for 88 minutes
with an idle Chrome child. Its process environment had a Codex child thread ID but no
`AGENT_BROWSER_IDLE_TIMEOUT_MS` or `CONCIERGE_TURN_ID`. The child rollout identified it as a
`spawn_agent` worker of a Concierge-launched Codex conversation. Earlier that day, an aged
detached browser from a deleted worktree contributed to the host overload alert.

## Cause

Concierge gave the browser timeout to the root Codex thread as a per-thread shell setting.
The spawned child did not receive it. The managed cleanup hook registered Codex `Stop`, but
Codex emits `SubagentStop` for a spawned child, so cleanup did not run for that child either.
The child has its own `CODEX_THREAD_ID`, which cannot match the parent's Stop hook.

## Fix

Install the 20-minute idle timeout in Codex's machine config, which new root threads and their
spawned descendants read. Register the existing exact-thread browser cleanup hook for Codex
`SubagentStop` as well as `Stop`. Keep the ChatGPT browser outside Codex config and do not
restart the shared App Server for this change.

## Acceptance scenario

- **Seed:** A new Concierge Codex thread spawns a child that opens an agent-browser session.
- **Action:** Inspect the child's controller environment, then let the child finish while its
  parent remains active.
- **Expected:** The child controller carries `AGENT_BROWSER_IDLE_TIMEOUT_MS=1200000`, then
  closes at child turn end. A different thread's controller and the ChatGPT browser remain.
- **Replayable offline:** the config merge and hook registration are; inherited child shell
  environment and hook execution need a live App Server check.
