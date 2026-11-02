---
failure: An agent's issue report reached the Inbox as a request but could not be dispatched into tracked work because it had no Inbox thread.
date: 2026-11-02
fix_commits: []
cause_status: confirmed
---

# An agent report had no thread for work

## What was seen

An agent noticed an issue outside its task and asked the Inbox to handle it. The Inbox could receive the request, but an onward work request needed a thread rooted in an Inbox message. The agent's coordination request supplied no such root, so the report had no place to route and track its outcome.

## Cause

Agent-to-Inbox requests are deliberately coordination messages, not prepared Inbox conversation roots. The dispatch command validates that its named thread is an accepted Inbox root. No report-specific intake path converted the agent's observation into a thread and open work item.

## Fix

The agent report command verifies the reporting run and retains the observation as an agent-authored Inbox capture. Capture admission creates its thread and open request atomically before the Inbox router runs. The router dispatches from that root, and its end-of-turn check refuses an open report that has neither linked work nor an explicit resolution. The existing request upkeep closes settled work and leaves uncertain work open. Mac reports use the authenticated peer link and are accepted as Mac-authored only when that link marks their provenance.

## Acceptance scenario

- **Seed:** An agent has a current accepted input and run on the server or Mac, and the Inbox router can accept a capture.
- **Action:** The agent invokes one issue report command with a stable action ID, a title and its observation, then retries the same command after an ambiguous response.
- **Expected:** Both invocations return the same Inbox capture, thread and open request. The report appears under the agent's authorship. The Inbox can dispatch work using that capture as its thread, and its turn cannot end with the request still unassigned and unresolved. The linked work's verified outcome closes the request and thread; an uncertain outcome leaves the request open for follow-up.
- **Replayable offline:** no (the acceptance boundary includes the installed owner, its peer link and a real Inbox router turn).
