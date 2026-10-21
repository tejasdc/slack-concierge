---
failure: After an update, Concierge froze for 12.5 seconds while picking up running Codex conversations, and those conversations collected duplicate copies of earlier messages.
date: 2026-10-12
fix_commits: [0fb00f5f]
cause_status: confirmed
---

# Adopting Codex turns re-recorded their whole history

## What was seen

On October 12, eleven Codex turns adopted after a restart produced 2,726 ledger writes in one 12.5 s owner freeze, and the
conversations gained duplicate copies of messages they already had.

## Cause

After a restart each adopted Codex turn re-read its full thread history (`bot/src/codex.ts`) and re-recorded every
message. The adopting run labelled messages with a different model or effort than the original, which changed each
message's digest, so `bot/src/session-projection.ts` saw every message as new. All of it ran in one synchronous pass.

## Fix

0fb00f5f keeps a replayed message only when its provider content differs from every recorded version, and records
recovered items in steps of 50 with a yield between steps.

## Acceptance scenario

- **Seed:** A ledger with eleven live Codex executions, each with 250 recorded messages; a stub App Server returning the
  same history with a different model label.
- **Action:** Restart the owner so it adopts them.
- **Expected:** No new message rows are written for unchanged content; no single loop tick exceeds a few hundred ms.
- **Replayable offline:** yes (stub App Server)
