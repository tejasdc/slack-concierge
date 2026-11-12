---
failure: Migrated Inbox requests stayed open after their checked answers because closure required a new topic post.
date: 2026-11-05
fix_commits: []
cause_status: confirmed
---

# Checked old answers could not close migrated requests

## What was seen

The Inbox router tried to close two September requests with their exact answered dispatch and final answer event. The owner refused both because the shared-request guard accepted a topic post or only a final without a typed work disposition. The retained final answers had a completed disposition and described live checks, but predated the new topics.

## Cause

The exact-final verifier was restricted to finals without any work disposition. That was appropriate for recovering an untyped answer, but excluded checked typed finals whose topic did not exist when they were delivered.

## Fix

The owner accepts an unsuperseded final event as request-specific evidence when its dispatch, source input, responder, text and disposition match the retained answered request. A typed final must say completed without a not-checked reason. The router still checks that the answer covers each human request. Closing records the original final event as evidence and does not repost the answer.

## Acceptance scenario

- **Seed:** Two migrated human requests share one answered dispatch with a completed final, and neither new topic has an answer post. Also retain a different dispatch's final and an uncertain outcome.
- **Action:** Close each request with the exact original final event after checking its scope; try the wrong event and uncertain outcome as negative cases.
- **Expected:** The exact finals close their requests with the original event in closure evidence. Wrong, superseded, failed, and uncertain evidence is refused. No new answer post is made.
- **Replayable offline:** yes (the legacy topic completion fixture)
