---
failure: Concierge accepted updates that requested a notification but appeared only in the agent session.
date: 2026-11-18
fix_commits: []
cause_status: confirmed
---

# Requested notifications on progress went missing

## What was seen

The Essos agent sent four partial replies with an explicit notification flag.
Tejas could see them in the agent session and asked why they were missing from
the Inbox Conversation. His follow-up was message
0806b497-6b25-4097-b101-12bd2e3ec70b. An invalid promise reference during the
same work produced a generic refusal even though the agent held eligible work.

## Cause

Concierge dropped the notification flag and retained quiet progress. A plain
progress receipt has no Conversation post.

## Fix

New notified progress is now refused
before receipt creation. The response describes the actual Conversation routes.
The direct-post guard can name an open request when retained work in the topic
attests it.

## Acceptance scenario

- **Seed:** a marked thread with one open Inbox request and a delegated worker.
- **Action:** send a notified progress-only partial, then a notified prompt answer.
  Try a bad promise reference, then post using the request named by the refusal.
- **Expected:** the first partial produces a refusal and no progress event. The answer
  reaches the Conversation. The bad reference creates no post, and the supported
  reference creates a worker-authored notice. An exact historical progress replay
  adds no second event.
- **Replayable offline:** yes with `bun bot/scripts/inbox-requested-notification-fixture.ts`.
