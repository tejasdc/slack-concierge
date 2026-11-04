---
failure: Agent-started Claude reviews reached an exhausted default login while another account had room.
date: 2026-11-04
fix_commits: [e54399ae, 99bed314]
cause_status: best-explanation
---

# Agent-started Claude reviews used the default login

## What was seen

On November 4, the fresh Claude Code reviews for a separate thnkr.ing release repeatedly returned a weekly limit said to reset November 8. Those invocations were bare `claude -p` commands from an agent shell. Their individual process environments and authenticated identities were not retained, so the exact account that rejected each historical attempt is unknown.

## Cause

The current unbound Claude Code command on the server authenticates as `tejas@chann.app`, the account whose weekly allowance is exhausted. An explicit account home authenticates as `hey@tejas.nyc`, which the local Concierge account view shows with room. Managed Concierge turns already select account homes, but agent-started CLI children used the ambient command path. The server shell's `claude` alias pointed directly to `/usr/bin/claude`, bypassing any path-based account choice. This is the proven source-level launch gap and the best explanation for those historical refusals; it is not a recovered credential trace for the failed processes.

## Fix

The correction routes fresh agent-shell commands through the local owner’s existing account chooser, verifies Claude Code’s effective subscription login before the model request, and preserves explicit pins and continued conversations. The server's live shell alias and its one-shot provisioning template now resolve `claude` through the command path. The Mac's alias already does so. The launcher is included in immutable server releases and Mac pinned helpers. A missing owner or competing credential refuses before launch. A provider limit after work may have begun is never blindly replayed on another account.

## Acceptance scenario

- **Seed:** On the server, the default Claude login has an exhausted weekly allowance and a separate signed-in account home has room. Start new Codex and Claude agent shells on the installed Concierge release.
- **Action:** Each agent starts a fresh, harmless `claude -p` marker request through its normal shell command.
- **Expected:** Each command resolves the versioned Concierge launcher, selects the account with room, confirms that exact Claude Code login, completes the marker, and leaves the caller's account binding intact. A resumed Claude conversation keeps its original account.
- **Replayable offline:** no (the last boundary depends on Claude Code's actual authenticated subscription and current allowance; the owner and launcher paths can be checked with local fixtures).

## Installed acceptance, November 4

The first server installation reached the new owner route but returned `chooseClaudeDispatch is not defined` before any Claude child ran. The follow-up import in `99bed314` corrected that wiring. After the `hey@tejas.nyc` five-hour window reset at 09:00 UTC, the installed server route selected that account for Opus. A fresh Codex agent shell resolved its ordinary `claude` command to the installed launcher; the launcher verified the first-party Claude Code login for `hey@tejas.nyc`, and a read-only marker completed on `claude-opus-5-5` with the expected response. A separate fresh Claude Code review on the same route returned **SHIP** (session `9749e0c6-200a-45e4-96ad-532ccdcb1d74`). Its duplicate-import observation concerned an abandoned, closed branch; the installed source has one import.

The Mac's installed agent-shell command resolved to its pinned helper at the installed revision. A fresh Codex agent there ran a read-only Opus marker through that command. The child used the `hey-tejas-nyc` home, Claude Code reported a first-party `hey@tejas.nyc` login, and the marker completed on `claude-opus-4-7`. The Codex parent remained on GPT-6 Luna with the same binding generation. The two hosts' `opus` aliases resolved to different model versions in these checks; account routing was the acceptance target. Neither probe changed project files, account settings, or the protected release review.

These checks establish the ordinary agent-shell launch path on both machines. The failed historical reviewers did not retain effective account identity, so their exact rejected account remains unknown. Direct absolute-path invocation of Claude Code remains outside the shell command entrance; the production Concierge source has no such launch call.
