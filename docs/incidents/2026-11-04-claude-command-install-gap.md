---
failure: A fresh agent-started Claude Code review was refused while its installed command was being replaced.
date: 2026-11-04
fix_commits: []
cause_status: confirmed
---

# Claude Code review refused during command installation

## What was seen

At 12:06:07 ET, another agent's `claude --help` received the missing-executable refusal. At 12:07:01 ET, an agent in the `dropped-task-recovery` worktree started a fresh Claude Code review and received the same refusal. A retry with an explicit installed path launched the review.

## Cause

The agent's retained transcript (`/root/.codex/sessions/2026/11/04/rollout-2026-11-04T10-34-30-01a1a732-8ca6-72f1-9c44-ae80f5c7ff48.jsonl`, entries 4034–4037) records the refusal at 17:07:01 UTC. Entry 4043 records that `/usr/bin/claude` was still absent at 17:07:06 UTC. The current `/usr/bin/claude` link has a creation time of 17:07:08.606 UTC, and its target has a modification time of 17:07:08.595 UTC. Entry 4061 then sees the link. The launcher searched PATH only once and threw when every candidate was missing. This is the confirmed immediate cause. The coincident package installation is the best explanation for why the link was absent. The exact installer command and its process identity were not retained, so this record does not assign ownership of that update. Future launcher waits log their start, recovered path and elapsed time, or their checked paths on refusal; that makes its own failure mode observable even if the installer remains unidentified.

The package directory was created at 17:05:59.83 UTC and the command link at 17:07:08.61 UTC, a roughly 69-second installation. A current `claude --version` through the installed launcher returned `2.1.318 (Claude Code)` after the incident; the command is usable now, but the one-shot lookup would still fail during a future replacement. A scan of the November 4 retained Codex command records found the two execution refusals within this window and no later execution refusal after the link appeared; other matches quoted or inspected the error.

## Fix

The launcher now watches the PATH command directories and broken-link targets for up to two minutes after an initial miss. A command that appears in that window is launched immediately, with the elapsed wait recorded on stderr. A lasting miss reports the checked paths. Account selection still happens only after the executable exists, so a delayed launch cannot skip the selected-account check. The watch is event driven rather than a timed retry loop. The two-minute bound exceeds the measured installation while refusing a genuinely absent installation instead of hanging indefinitely.

The first installed check exposed a second command-discovery defect. This agent shell retained a prior Concierge release's `bot/scripts` directory ahead of `/usr/bin` in PATH. The new release excluded only its own wrapper path, so it chose the prior release's `claude` wrapper. That wrapper used `CONCIERGE_ROUTER_BOT_DIR` to restart the current release's launcher, recursively. The test's process chain ended without reaching Claude Code. Discovery now skips any resolved Concierge `bot/scripts/claude` path across releases, and an immediate-parent guard refuses recursion if a future wrapper layout escapes that filter. The isolated replay puts an older-release wrapper before the actual executable and requires the latter's version.

## Acceptance scenario

- **Seed:** Build the launcher into a temporary release directory with its companion `claude` wrapper. In a temporary PATH directory, start with no `claude` command; repeat with a broken `claude` link, including a link whose target parent folders are absent. Put an older-release wrapper ahead of a real executable in another fixture, and an unfamiliar recursive wrapper in a third.
- **Action:** Start the launcher with `--version`, creating the absent command or target after it reports that it is waiting.
- **Expected:** The same launcher invocation runs the newly installed command and returns its version; an older release is skipped; an unfamiliar recursive wrapper is refused once. No account or live ledger is accessed.
- **Replayable offline:** yes (`bun run bot/scripts/claude-launch-install-gap-check.ts <built-launcher-path>` through the private-code entrance). The test suite entrance is intentionally disabled; this standalone fixture is the isolated check for the runtime command.
