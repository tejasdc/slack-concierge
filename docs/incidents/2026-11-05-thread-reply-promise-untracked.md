---
failure: A direct reply to an agent and its promised answer had no tracked Inbox obligation.
date: 2026-11-05
fix_commits: []
cause_status: confirmed
---

# Direct thread reply and promised answer had no topic request

## What was seen

On November 4 around 4 AM Eastern, Tejas sent a 1:06 iPhone recording about Sessions
and follow-ups inside the responsive design language thread. Concierge forwarded the
reply directly to the design agent as request `4cbbcc70-6691-49e9-be0c-4fd8256c53c4`.
At 09:00:34 UTC, a reminder turn posted “The design agent started working on your
Sessions report and the follow-ups at 4:00 AM; it answers here.” as post
`d511ea09-8155-4f9a-8ed9-16d510c42c27`. The forwarded communication request existed, but no Inbox topic request
represented the human obligation. The agent's work was later found and its answers
were moved into the thread, but the Inbox's open-request sweep could not have
discovered that missing answer by counting topic requests.

## Cause

The earlier November 4 recovery repair kept failed and stalled attempts open only
after a topic request existed. The historical audit's zero-untracked count covered
its named cohorts, not this direct-reply entrance.

## Fix

The repair joins a direct human reply to the topic request ledger in the same local
or peer transaction as its communication dispatch. An answer promise in a thread post with no open request for the exact source
is refused before posting. Older unresolved direct replies are eligible for the
existing upkeep linkage, while checked completions stay closed. The obligations
read exposes the current open count, destination and age from that ledger.

## Acceptance scenario

- **Seed:** An open Inbox topic with a human reply sent to a working agent and no existing topic request for that exact reply.
- **Action:** Forward the reply, then let the agent attempt fail or end without a checked answer.
- **Expected:** The reply and communication attempt share a topic request; its open count stays positive, and upkeep can chase it. A future-answer post without a linked request is refused.
- **Replayable offline:** yes, with a seeded owner ledger and a human-authored retained input.
