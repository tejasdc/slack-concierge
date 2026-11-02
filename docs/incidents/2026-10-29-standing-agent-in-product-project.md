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

Concierge declares standing roles and their folders in one table. The first fix addressed a
role by the newest active session in its folder. The follow-up
[binding correction](2026-10-29-standing-role-selected-neighbor-session.md) replaced recency
with an explicit session binding. New recurring schedules and renewing watches refuse product
project folders; accepted work continues.

## 2026-11-02 placement revision

The folder-category refusal above was the initial safeguard. It is superseded for new
repeating schedules and renewing watches: any registered project may own them, including a
grouped Canvas project and a product project. The workspace organizer now chooses new
project placement, so folder names cannot determine whether the project may schedule work.
A declared standing role still binds only to its exact declared project and session; the
to-do role cannot silently bind to a Thinkering session. Ordinary project schedules remain
owned by their named project.

## Acceptance scenario

- **Seed:** A Thinkering session is active; a to-do agent project exists under workspace/agents/.
- **Action:** Request a new repeating schedule from Thinkering, then list standing agents and address the to-do role.
- **Expected:** The ordinary project schedule is allowed if Thinkering is registered; the standing-agent list names the to-do role's folder and bound session, and a role-addressed request enters only that session. Grouping a registered project under `canvases/` does not change schedule eligibility.
- **Replayable offline:** no (the role binding and project status must be exercised through the installed owner; no new production schedule is created during checking).
