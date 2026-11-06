---
failure: Tejas authorized a thnkr.ing update on his Mac, but the agent's Mac app requests were refused before inspection.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# Direct Mac update request refused

## What was seen

The server installed thnkr.ing release `535c73c7`. The Mac page on `8c168502`
found the update but did not accept it. Two Mac requests to inspect and update the
already-open Safari web app were refused by Concierge's UI access guard before page
inspection. No Mac update was observed.

Tejas directly instructed a Mac Codex parent conversation to install the update at
03:32:49 UTC in user message `msg_01a1aeea-8d60-7543-a30c-f7c5801a3ccc` of thread
`01a1ad10-c8b0-7571-97f6-e2fdfffba3c5`. That same thread later issued outside
request `1c9145ce-b0bc-40e6-8b55-6971d4bdd19c` to the server repair worker.

## Cause

Concierge recorded the outside request as agent-authored, with no accepted human
input in its provenance. Its Mac guard allowed passive exact-app inspection only
from a different recorded human source, and refused update clicks. The server
worker's statement that Tejas had authorized installation was agent text, not
authorization evidence. The original provider transcript supplies the missing
direct human instruction and later request receipt.

## Fix

For this one request, the Mac owner verifies its local Codex transcript has the
direct user message and later exact outside request receipt in the same provider
thread. PR #660 granted exact-bundle passive reads and a fixed `Update now` program.
An independent critique identified that the program could not prove the current
page, ready release or stable control target at click time. A corrective release
keeps the passive read and refuses the update click until an action-bound route
can prove those facts. The transcript is a cooperative audit record, not a
security boundary against an agent able to rewrite files on its host.

## Acceptance scenario

- **Seed:** The exact retained Mac Codex transcript and an active work request from the recorded server worker for the exact thnkr.ing web app, page and ready release.
- **Action:** The Mac worker inspects the app through the exact-bundle read. An attempted Update now click is refused.
- **Expected:** The guard admits the exact app read and refuses every update click, including the former fixed program. A different source, app, release or missing transcript is refused. No installed build is claimed from the read.
- **Replayable offline:** yes, for guard decisions with `bot/scripts/mac-surface-policy-check.ts`; the physical Mac update and loaded build require live observation.
