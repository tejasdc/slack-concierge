---
failure: The usage report counted every Claude response three times because three account homes link to one transcript folder.
date: 2026-11-12
fix_commits: []
cause_status: confirmed
---

# Every Claude call appeared three times in the usage report

## What was seen

During the implementation-handoff live check, one Claude Opus session had nine distinct
provider response IDs, but the installed usage report showed 27 calls for it.

## Cause

On the server, the hey-tejas-nyc, tejas-chann-app and tejastej-dc-gmail-com account homes
each link `projects/` to the one shared `/root/.claude/projects` folder. The runner's usage
reader walked every configured home, so it read each transcript file through three paths and
cached each response under each path. The live cache held 90,411 Claude rows for 29,983
distinct response IDs that week: Claude calls, tokens and weighted allowance shares were all
roughly tripled, not only this session's. Separately, 71 responses had a genuine copy in the
`second` home's own folder. No response appeared under two different conversations, and Codex
had no repeats.

## Fix

The reader resolves each home's transcript folder to its real path and scans each real folder
once. The report also counts a provider, conversation and response ID once, which covers
genuine copies. Account attribution still comes from the ledger's per-turn account.

## Acceptance scenario

- **Seed:** One runner has a home, a second home whose `projects/` links to the first, and a
  third home holding a real copy of part of the same conversation.
- **Action:** Read the per-session and total usage breakdown.
- **Expected:** Calls, tokens and edits match the single-home counts.
- **Replayable offline:** yes (runner usage-report fixture,
  `bot/scripts/runner-provider-usage-report-check.ts`).
