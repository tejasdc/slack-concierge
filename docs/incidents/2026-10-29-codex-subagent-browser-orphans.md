---
failure: Codex subagent browsers lacked the 20-minute idle shutdown and escaped end-of-turn cleanup.
date: 2026-10-29
fix_commits: [5ab97c62]
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
On the Mac, the npm-owned `agent-browser` was also 0.16.3. That version predated its
idle-shutdown setting, so a native child could inherit the timeout without the
browser daemon honoring it.

## Fix

Install the 20-minute idle timeout in Codex's machine config, which new root threads and their
spawned descendants read. Register the existing exact-thread browser cleanup hook for Codex
`SubagentStop` as well as `Stop`. Keep the ChatGPT browser outside Codex config and do not
restart the shared App Server for this change.
The Mac's unattended updater also sets the timeout in its user's Codex config and checks
whether the administrator-installed `SubagentStop` hook is present; an older hook must not
be accepted as current merely because it has the earlier per-run wrapper.
The Mac updater pins its npm-owned browser CLI to a version with working idle shutdown;
the package is upgraded separately from the shared Codex App Server.
The first Mac child probe exposed a further cleanup gap: the hook returned immediately on macOS because
its process scan used Linux `/proc`. A Mac controller in the upgraded 0.27.0 probe exposed
its Codex thread ID through `ps eww`, while its direct Chrome child did not. The hook now
matches that controller by executable and exact thread/run identity, then closes its
recorded descendants. The administrator-installed hook still needs `sudo`.
The first server child probe also showed that its Stop was blocked by the parent's open
request. Codex's hook input gives `session_id` for the parent and `agent_id` for the child;
using the parent resolved the parent's running turn and could close the parent's browser
while that turn was still active.
The corrected child hook uses only the child agent ID for its owner query and browser match.

## Acceptance scenario

- **Seed:** A new Concierge Codex thread spawns a child that opens an agent-browser session.
- **Action:** Inspect the child's controller environment, then let the child finish while its
  parent remains active.
- **Expected:** The child controller carries `AGENT_BROWSER_IDLE_TIMEOUT_MS=1200000`, then
  closes at child turn end. A different thread's controller and the ChatGPT browser remain.
- **Replayable offline:** the config merge and hook registration are; inherited child shell
  environment and hook execution need a live App Server check.
- **Mac package check:** A disposable session with a six-second idle setting must appear
  while active and disappear after twelve seconds. A native child must pass its inherited
  20-minute setting and own thread ID to the browser controller.
