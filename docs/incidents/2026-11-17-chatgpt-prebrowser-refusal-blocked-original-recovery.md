---
failure: A ChatGPT review rejected before browser admission stayed unanswered because recovery required a browser receipt that could not exist.
date: 2026-11-17
fix_commits: []
cause_status: confirmed
---

# ChatGPT review rejected before browser admission stayed unanswered

## What was seen

Request `f70fb334-1e48-416f-9e4a-db58fe7d16f6` ended without a ChatGPT answer. The asking session tried its guarded original-run recovery, which refused because the proposed send did not match the retained admission. The answer obligation remained open.

## Cause

The original turn 33010 carried two attachment descriptors with agent-source provenance. thnkr.ing's input schema rejected that field with HTTP 400 `INVALID_PROVIDER_INPUT` before its ChatGPT handler ran. Concierge retained that exact certain failure, but its recovery accepted only a failed browser receipt. No browser receipt could exist for a pre-handler refusal. The turn had one dispatch attempt, no provider start or acknowledgement, and no later work in its ChatGPT session.

## Fix

Concierge accepts the exact retained HTTP validation refusal as a second no-send proof. The original-run requeue transaction checks the failure event and run identity again, requires one attempt and no other capability event, and preserves the existing no-acknowledgement and no-later-work guards. A missing receipt alone never authorizes requeue. The companion thnkr.ing change accepts the bound attachment provenance while retaining strict file and authority comparison.

## Acceptance scenario

- **Seed:** Admit one ChatGPT turn with the original request, run, binding and two provenance-bearing attachments. Retain one HTTP 400 `INVALID_PROVIDER_INPUT` capability failure from the input-validation route, with `uncertain:false`, no provider start or acknowledgement, and no later admitted turn.
- **Action:** From its asking session, invoke `sessions chatgpt-recover` for that original request after thnkr.ing accepts the attachment descriptor.
- **Expected:** Concierge requeues only the same native run once. Its ChatGPT answer reaches the original asking session, and the asking session records how it handled the answer. A second attempt, an uncertain response, another capability event, or later admitted work does not permit another requeue.
- **Replayable offline:** no (the full answer path requires the signed-in ChatGPT browser; the proof predicate and refusal can be exercised without it).
