---
failure: After a Claude account sign-in "switched", every agent on that account was refused file writes and commands until Tejas signed in by hand.
date: 2026-10-07
fix_commits: [f4383104]
cause_status: confirmed
---

# Switching Claude accounts left agents unable to write or run commands

## What was seen

On 2026-10-07, after a Claude account switch, every agent running on the new account was refused writes and
shell commands for about ten minutes, until Tejas signed in manually. Accounts showed the switch as successful.
Tejas: "if the login has changed, the agents are losing access to doing things, that ... never should happen."

## Cause

Confirmed from the commit. An extra Claude account home held its login plus only a link to conversation
history. Claude reads settings (the allowed-command list), instructions, hooks, skills and agents from the
folder it starts in, so a run from that home had no permissions configured and every write and command was
refused. The switch's verification probe asked Claude to reply "OK", which succeeds without any settings, so a
home missing its settings passed as healthy and automatic moves for room could send work to it.

## Fix

- f4383104 (`provider-activation.ts`, `provider-account-dispatch.ts`, `claude-account-login.ts`): an extra home
  keeps only per-login files and links every other entry of `~/.claude` by name (`sharedClaudeHome`). A home
  missing a link is never used and logs what it lacks. An explicit switch or sign-in sets private copies of
  shared entries aside, never deleting them.
- `claudeAccountWorks` now starts Claude the way agents run and requires both a Write and a Bash change
  outside its folder, read back by the owner with tool evidence, and names the failure (signed out, settings
  not in effect, wrong account, timeout).
- Automatic moves go only to a home proven by that check or by a finished turn; a failure is remembered for
  ten minutes; a refusal or newly filed login withdraws the proof.
- The account list answers from last known state with one shared background check so Accounts opens at once.

## Acceptance scenario

- **Seed:** a Claude account home containing only a login and a history link (no settings, hooks or allowed
  commands), and a second healthy account.
- **Action:** switch to the bare home (or let the automatic move consider it), then start an agent turn that must
  write a file and run a command.
- **Expected:** the check fails with "settings not in effect", the switch is refused or the home is never used
  for automatic moves, the previous selection and running processes are untouched; a fully linked home passes
  and its agent completes both the write and the command.
- **Replayable offline:** no (needs a real Claude login and the Claude Code settings/permission behavior; the
  link-completeness check alone can be replayed on a scratch directory)
