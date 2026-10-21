---
failure: Browsers agents opened stayed running after their turns ended, leaving hundreds of Chrome processes on the server.
date: 2026-10-11
fix_commits: [bf9071de]
cause_status: confirmed
---

# Finished agent turns left hundreds of Chrome processes

## What was seen

By October 11 the server had hundreds of leftover Chrome processes from agent-browser sessions of completed turns,
adding to host overload. The new host overload alert also had no route into the repair queue.

## Cause

agent-browser detaches its controller from the tool command, so the controller and its Chrome stayed in the shared Codex
daemon's cgroup (or the execution host's) after the turn finished. Nothing at turn end closed them.

## Fix

bf9071de makes the trusted Stop hook (`bot/scripts/owed-reply-stop-hook.ts`) close agent-browser processes whose
environment carries the completing run's identity (Claude native run) or Codex conversation, only after the turn is allowed
to finish; blocked and background turns keep their browsers. `bot/src/grafana-webhook.ts` admits the new overload condition
into the standing repair queue.

## Acceptance scenario

- **Seed:** Two turns in different sessions, each with an agent-browser controller carrying its run identity.
- **Action:** Turn A ends normally; turn B's Stop is blocked by an owed reply.
- **Expected:** A's controller and Chrome children are gone; B's remain.
- **Replayable offline:** yes on Linux (stand-in processes named like the agent-browser binary with the identity env)
