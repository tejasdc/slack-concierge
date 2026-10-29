---
failure: A continuing to-do agent was started in the Thinkering product project and loaded Thinkering's instructions instead of its own.
date: 2026-10-29
fix_commits: []
cause_status: confirmed
---

# Standing work entered a product project

## What was seen

The to-do agent's session was in the Thinkering product repository. Its ongoing job had no
independent agent instructions because the repository's AGENTS.md describes Thinkering itself.

## Cause

Concierge had no authoritative list connecting continuing agent roles to their own folders.
Other paths found the journal keeper by session number, the repair agent by title, and the
to-do agent by Inbox judgment. Recurring schedules and renewing watches admitted product
project sessions without a folder boundary.

## Fix

Concierge declares standing roles and their folders in one table. Addressing a role resolves
the newest active session in that folder or creates it there. Journal and repair delivery use
the same lookup, with a dated fallback to the existing repair session until it is moved. New
recurring schedules and renewing watches refuse product project folders; accepted work continues.

## Acceptance scenario

- **Seed:** A Thinkering session is active; a to-do agent project exists under workspace/agents/.
- **Action:** Request a new repeating schedule from Thinkering, then list standing agents and address the to-do role.
- **Expected:** The schedule is refused with the agent-project remedy; the list names the to-do folder and its current session, and the addressed request enters a session in that folder.
- **Replayable offline:** no (the read-only list and refusal must be exercised through the installed owner; no new production session or schedule is created during checking).
