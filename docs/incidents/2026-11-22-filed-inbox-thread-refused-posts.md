---
failure: Concierge refused posts to an Inbox thread whose roots came from another session, and an empty topic could never receive its first post.
date: 2026-11-22
fix_commits: []
cause_status: confirmed
---

# Filed Inbox thread refused posts

## What was seen

The Inbox router filed the original Specifications discussion under one topic, then got
“That --thread is not a message in this Inbox” with either filed root. It created an empty
duplicate with the same title, which still offered no address the post command would accept.

## Cause

Topic placement and post admission used different message sets. Posting required a row in
the Inbox dialogue, even for exact roots already placed in a topic. The post command accepted
only message IDs, so there was no first post for a rootless topic.

## Fix

The Inbox owner recognizes filed roots and accepts a direct topic address. It commits a
rootless topic's first post and root together and returns the retained receipt on exact retry.
It uses the same discussion membership and author attribution as other Inbox posts.

## Acceptance scenario

- **Seed:** An Inbox, a worker, an accepted input in another session, and an empty topic.
- **Action:** Post to the exact input before and after placing it. Post as the worker to
  a newly created topic by its topic ID and retry after merging it.
- **Expected:** Only the filed input admits the reply. Both accepted posts appear under
  the proper topic with their author and live post identity. The retry creates no new post.
- **Replayable offline:** yes, with the disposable owner in `bot/scripts/inbox-requested-notification-fixture.ts`.
