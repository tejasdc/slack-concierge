---
failure: A reply to an agent's post in an older Inbox conversation offered only the current Inbox agent.
date: 2026-11-16
fix_commits: []
cause_status: confirmed
---

# An earlier Inbox agent disappeared from the reply choices

## What was seen

In “Possible missing text after moving a note,” Tejas tried to answer the recovery agent's post. The reply box offered only the Inbox agent, and his reply reached the Inbox. The recovery agent's request had already closed. The retained post `post:forward:3f41be42-202f-4018-a058-b6d01edb7e49` names `concierge:9773` as its writer and belongs to an older Inbox session, `concierge:9733`. The active Inbox is `concierge:9832`.

## Cause

The thread read follows all Inbox sessions in one lineage, but the reply-target read considered posts only from the current Inbox session. A second lookup for the writer of a selected post had the same narrower scope. The recipient list therefore omitted a visible post's writer after the Inbox role moved. Whether the agent's request was still open was incidental: a post must retain its writer as a reply choice for its entire lifetime.

## Fix

Read post writers across the same Inbox lineage as the visible thread. Preserve the established rule for ordinary main-thread replies: the latest speaker is the initial recipient, and the current Inbox agent remains a choice. A reply under an exact agent post initially goes to that post's writer, subject to an accepted handoff successor, even when its request is closed.
An earlier Inbox role holder still counts as the router, so exposing its posts does not add a false agent choice.

## Acceptance scenario

- **Seed:** A thread contains an agent post written under an earlier Inbox session; that agent's request is closed and a newer Inbox session holds the role.
- **Action:** Open the thread, then reply under the old agent post.
- **Expected:** The reply box names and offers that agent, the accepted reply is addressed to it, and its answer appears under the same message. An ordinary main-thread message still uses the latest speaker as its initial recipient and offers the Inbox agent.
- **Earlier Inbox post:** Selecting a post written by an earlier Inbox role holder still selects the current Inbox agent, even when another agent spoke later.
- **Replayable offline:** yes (retained message and session lineage are sufficient).
