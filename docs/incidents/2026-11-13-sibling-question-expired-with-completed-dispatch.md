---
failure: A completed dispatch expired questions belonging to sibling work in the same agent session.
date: 2026-11-13
fix_commits: []
cause_status: confirmed
---

# A sibling question disappeared when another dispatch completed

## What was seen

Two open requests shared one worker session. Completing one dispatch left the other request open
but expired its asked and decision questions. A request-only or thread-level question could also
be selected by the same session fallback.

## Cause

The final-reply expiry selector accepted either an exact dispatch link or a matching worker
session. A session may carry several independent dispatches, so it does not prove which request a
question belongs to. The Inbox retained the expiry event and original question history, but had
no supported action to restore the same question.

## Fix

Final-reply expiry now requires the exact dispatch link. A supported restoration action accepts
only the unchanged question snapshot from the exact retained expiry event, with a prior open or
partial snapshot and a still-open request linked to that question's different explicit dispatch.
It records ordinary recovery provenance and preserves question identity, revision, timestamp,
source, readiness and notification generation. Request closure and explicit settlement continue
to end questions whose dispatch ownership cannot be proven.

## Acceptance scenario

- **Seed:** Two open human requests and two explicit dispatches share one worker session; asked and decision questions link separately to the two dispatches, with one unscoped question in the same topic.
- **Action:** Complete one dispatch, then attempt exact restoration of a retained historical sibling expiry and replay the topic projection.
- **Expected:** Only the completed dispatch's questions expire; sibling and unscoped questions remain open. A valid historical sibling recovery restores the same question silently and survives replay; stale or unproven recovery is refused.
- **Replayable offline:** yes (isolated native owner fixture; no production state or external account access).
