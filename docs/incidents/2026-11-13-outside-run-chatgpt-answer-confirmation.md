---
failure: An outside repair run could read and use a ChatGPT answer but could not finish because its native answer return waited behind that same run.
date: 2026-11-13
fix_commits: []
cause_status: confirmed
---

# An answered repair could not finish

## What was seen

The outside notification-consolidation repair had applied and checked the requested correction and posted its human result. Its ChatGPT critique had settled answered. The active asking run read the complete exact answer through the supported request tool, but its completed reply was refused: the answer duty still required acknowledgement of a native return queued behind that run. Handling and handoff both refused. No accepted notification, secondary route or notification delivery needed replay.

## Cause

The supported read returned the answer without retaining source-bound read evidence. The answer owner accepted only a provider-acknowledged native return. An outside run that cannot steer therefore needed to finish to admit its return, while its open answer duty prevented it from finishing.

## Fix

Retain exact tool-read custody in the existing action ledger and require a separate explicit confirmation bound to the same active run, asking session, task, request, final answer event and unchanged payload digest. Resolve only the exact duty. Preserve native return status, provider acknowledgement, answer bytes, queued work, unrelated duties and the original no-replay rule. The ordinary native acknowledgement path remains.

## Acceptance scenario

- **Seed:** An active native asking repair run holds an open work request. Its exact ChatGPT final exists, with its native return queued behind that run and no provider acknowledgement. Another answer duty remains unrelated.
- **Action:** Read the exact answer through supported request get, then explicitly record handling using its returned read receipt and complete the original work request.
- **Expected:** The exact answer duty resolves and the original completed reply succeeds. No provider acknowledgement is fabricated, no final event or answer bytes change, the original queued return remains, no Send occurs, and the unrelated duty stays open. Wrong actor, event, run, task or changed receipt is rejected. Duplicate actions are idempotent; ordinary native acknowledgement still handles its answer.
- **Replayable offline:** yes (disposable native owner acceptance; production confirmation belongs to the original asking run).
