---
failure: A standing agent could not schedule its follow-up because the selected runner rejected its declared project folder.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# The repair agent's scheduled wake was refused

## What was seen

On November 6, a one-time follow-up for the bound Concierge repair agent was refused before
any saved work was created. The owner reported that runner AX41 did not register the requested
project location. The role remained bound to its existing session; the intended follow-up to
PR #632 was left open.

## Cause

The role declares `agents/concierge-repair`, its location relative to the workspace. The
runner's project catalogue registers the same Git repository as `concierge-repair`. Its
location lookup accepted project names and absolute paths but did not recognize an exact
workspace-relative path to a registered nested project. The owner asked the runner to
resolve the declared path before looking up the bound session, so the request stopped there.

## Fix

The runner now recognizes the exact workspace-relative path of a project in its own
registered catalogue. It still refuses a missing or unregistered folder. Concierge can
then resolve the existing role binding and save the scheduled input in that session.

## Acceptance scenario

- **Seed:** A runner workspace has an `agents/concierge-repair` Git project with agent
  instructions, and the Concierge repair role is bound to its existing session.
- **Action:** Schedule a future one-time wake with `sessions schedule --role concierge-repair`.
- **Expected:** The runner resolves the declared folder to its registered project; Concierge
  saves a wake targeting the bound session and creates no second repair session.
- **Replayable offline:** yes, with a grouped project fixture for the runner lookup and a
  scheduled-role owner fixture for the saved target.
