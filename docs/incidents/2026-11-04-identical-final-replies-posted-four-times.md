---
failure: Four identical final replies from one agent run appeared four times in one Inbox topic.
date: 2026-11-04
fix_commits: []
cause_status: confirmed
---

# Identical final replies posted four times

## What was seen

In the marked `[Agent test] One agent update and stopped notice` topic, four requests to the
same fixture agent retained separate final replies with the same body and closing facts. The
server's raw Inbox history showed four separate final posts at 09:11:41–42 UTC, despite the
earlier partial replies and one stopped notice appearing once each. The four request IDs were
`e5e9c49e-5141-4345-a6e1-a5cfc244f596`, `94398913-f148-4472-92ee-7342b9c88f4c`,
`e4f2ef99-523b-4cef-a826-8c19284b54f6`, and `7208441f-b14a-44c4-a465-f3ef32646c90`.
All four requests settled as answered; this failure was in the visible final post selection.

## Cause

The final-post grouping lookup compared the first post's closing line using the older
post-based closure event ID. The repair had already moved closure events to per-reply event
IDs so each request could retain its own outcome. The lookup found no closure for the first
post and rejected each later identical final as different. The four posts and their closure
events in the owner ledger establish the mismatch.

## Fix

Resolve a candidate's closing line through its per-reply closure event, while recognizing
older post-based closure IDs. Keep the exact closing-line comparison so mixed outcomes remain
separate. The prepared topic reader also resolves closing facts through the retained post
association, including a bodyless final attached to an earlier answer. The existing request
and topic outcome paths retain each request's result. A versioned projection refresh updates
answers already prepared before this correction, and the historical duplicate guard uses the
same closing-facts lookup.

## Acceptance scenario

- **Seed:** Four requests in one Inbox topic, held by one agent run; each receives an identical final body, disposition and closing line.
- **Action:** The agent sends four separate final replies.
- **Expected:** One visible final post with closing facts, and four individually settled requests with four retained closure records. A different closing line creates a separate visible post.
- **Replayable offline:** yes (isolated Inbox event ledger and the four-reply fixture).
