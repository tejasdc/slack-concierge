---
failure: An agent repairing canvas voice while Tejas waited ran a build in the foreground and could not act or read his message for ten minutes.
date: 2026-11-01
fix_commits: []
cause_status: confirmed
---

# The voice repair went silent for ten minutes

## What was seen

At 10:28:31 PM ET the canvas voice repair session (concierge:7325, Claude Code) ran
`node scripts/build.mjs` in thnkr.ing's worktree with a 600-second tool limit. Claude Code moved it
to the background only at 10:38:32. Tejas's message at 10:48 asked what it had been doing.

## Cause

The build log shows `Waiting for one of 3 host build slots` then `Build slot acquired for build
after 366 s`, and a Vite stage of 2 min 13 s; it finished at 10:39:14. Seven agent sessions'
builds held and queued for the three shared slots in that window (their own transcripts record
acquisitions after 154 to 331 s). The agent ran the command in the foreground, so the whole wait
blocked it. Claude Code offered a background run; nothing refused the foreground one.

## Fix

The command guard refuses a Claude Code command that waits on a shared host build slot unless
`run_in_background` is set (`bot/src/foreground-build-policy.ts`). thnkr.ing's slot entrance
also now names the slot holders while waiting and logs every wait to the journal.

## Acceptance scenario

- **Seed:** a thnkr.ing checkout whose `scripts/build.mjs` imports `host-build-slot.mjs`.
- **Action:** a Claude Code PreToolUse input for Bash `node scripts/build.mjs` without `run_in_background`.
- **Expected:** the guard answers `permissionDecision: deny` asking for a background run; the same input with `run_in_background: true` is allowed.
- **Replayable offline:** yes
