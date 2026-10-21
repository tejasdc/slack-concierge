---
failure: A side question on the Mac waited three minutes and then failed, with nothing recorded about why.
date: 2026-10-13
fix_commits: [2ceba826, e0d4b7f5]
cause_status: best-explanation
---

# A side question on the Mac hung for three minutes with no trace

## What was seen

On 2026-10-13, shortly after side questions shipped, Tejas asked one about a session on his Mac and waited the full
three-minute deadline. It ended with "The side question took longer than three minutes." The log held nothing about
what the copy had been doing, and the copy was only sent SIGTERM, so a copy ignoring it could live on.

## Cause

Best explanation (GPT-6 Sol second opinion, recorded in the e0d4b7f5 message): the forked `claude -p --resume
--fork-session` copy was stuck starting an MCP server from the Mac's configuration, because `--tools ""` does not stop
MCP servers loading (found the same morning, see
[the empty-answer record](2026-10-13-side-question-mac-empty-answer.md)). Not observed: `run` in
`bot/src/session-asides.ts` captured stdout/stderr but on the deadline only killed the child and rejected, logging
nothing, so which step the copy was in is unknown. The missing evidence and the SIGTERM-only stop are confirmed in the
diff.

## Fix

- 2ceba826: adds `--strict-mcp-config` with no MCP config, so the copy loads no MCP servers, removing the likely
  cause.
- e0d4b7f5: on the three-minute deadline, logs `session_aside_timed_out` with elapsed time, stdout byte count and the
  last 300 characters of stdout and stderr; sends SIGTERM and, if the process is still alive five seconds later,
  SIGKILL; and tells him "No answer came within three minutes, so that copy was stopped. Ask again."
Whether the stall recurs without MCP servers has not been observed.

## Acceptance scenario

- **Seed:** A stub `claude` executable that prints a partial line, ignores SIGTERM and never exits; and a second stub
  that hangs only when an `--mcp-config` or no `--strict-mcp-config` is passed.
- **Action:** Ask a side question against each stub.
- **Expected:** With the first, after three minutes a `session_aside_timed_out` log carries the partial output, the
  process is gone within five more seconds (SIGKILL), and the answer says to ask again. With the second, the copy
  answers promptly because `--strict-mcp-config` is passed.
- **Replayable offline:** yes for the deadline behavior (stub CLI and a shortened clock); no for confirming the
  original cause (needs the Mac's real MCP configuration)
