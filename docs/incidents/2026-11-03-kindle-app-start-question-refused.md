---
failure: Concierge refused a physical Kindle app startup as a device question.
date: 2026-11-03
fix_commits: []
cause_status: confirmed
---

# Kindle startup question was refused

## What was seen

The KOReader worker needed Tejas to start KOReader once on his Kindle Oasis. The
Kindle had no agent network route until KOReader started; the Mac found no SSH
port on the local network and USB exposed storage only. The worker tried four
times to file the prerequisite as a device question, and Concierge refused it.
The step was delivered as a progress post instead of a question in Needs attention.
The report is the agent-authored Inbox capture
`capture:f5be102d1e5f753c293f7295af654cc11569d4c46ced511e970d8aee153bf55b`.

## Cause

The owner recognized only a short list of physical verbs for device questions.
Starting an app on a named e-reader, watch or TV was absent, even when starting
the app was necessary to expose the agent connection.

## Fix

Accept a single app-start action on those physical device classes through both
question entrances. Keep generic app and website requests on agent-reachable
computers and phones refused. The existing reason field records why the agent
cannot take the physical step itself.

## Acceptance scenario

- **Seed:** A Kindle with no agent connection until KOReader starts.
- **Action:** The worker asks Tejas to open KOReader once on his Kindle Oasis with the required reason.
- **Expected:** Concierge admits the device question; a generic request to open Safari on his Mac remains refused.
- **Replayable offline:** yes (the question admission rule is deterministic).
