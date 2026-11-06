---
failure: A stand-in session bound to the Inbox role while the Codex Inbox router was out of allowance received no new captures, could not name or link threads, and had no way to read the words of the requests it inherited.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# A bound stand-in Inbox router could not act as the Inbox

## What was seen

From about 04:17 UTC on 2026-11-06 the Inbox router, concierge:8785 (Codex), stopped on a
Codex usage limit. The automatic Inbox failover had proposed a Claude successor at 03:11 UTC
(handoff 06b7ff65, successor concierge:8876), but that successor's first turn parked
("Claude Code ended before acknowledging the initial user message"), so the handoff stayed
proposed. The overnight incident agent then ran `sessions agents bind inbox` for
concierge:8901 (Claude). `sessions agents` showed 8901 as the bound Inbox, but:

1. A marked test capture at about 04:50 UTC and an agent issue report at about 04:55 UTC were
   both admitted to 8785's queue.
2. `sessions ask --thread <capture>` from 8901 was refused ("Only the Inbox names a thread on
   a request; this session has no threads"), so `topics request link` was then refused for the
   threadless dispatch, and 35 agent reports went to sessions with no thread.
3. Topic reads (`topics read`, `items`, `detail`) gave message ids, titles and short dispatch
   excerpts but never a message's own words, so 8901 could not judge the inherited requests.

## Cause

Concierge had two markers for "the Inbox" that only a provider handoff kept together. The
standing-role binding (`standingRole: 'inbox'`) is what `sessions agents` shows and what
`agents bind` moved. Everything that acts as the Inbox read a second marker (`inbox: true`,
newest such session wins) and, for threads and topics, the chain of accepted provider
handoffs. A handoff sets both markers and adds a chain link; a bind set only the role, so
captures (`ensureInboxSession`), thread-named requests (`inboxRequestThread`), and every
thread lookup kept pointing at 8785. Message words were readable only as the input delivered
to the router that received it; no read returned them by id.

## Fix

One definition of the Inbox, in `bot/src/inbox-lineage-sql.ts`: every session ever marked as
the Inbox is part of the one Inbox (as its history page already treated it), and the current
router is the live holder of the `inbox` role (else the newest Inbox session). Binding the
`inbox` role now does what an accepted handoff does: it marks the session as the Inbox router
and carries the former router's attention, through one shared step used by both paths. Thread,
topic and placement lookups that walked only handoff chains now include every Inbox session. The
bind receipt states what moved and lists inputs still queued on the former router.
`sessions topics message <id>` returns a message's words, author, time, attachments, thread and
topic. `--capture-id` also accepts the `capture:<id>` form that thread listings show.

Rejected: recording a bind as a synthetic accepted handoff. It would claim an inventory move
that never happened, and binding back to the older router would form a cycle that the
existing recursive lineage queries (UNION ALL) never leave.

## Acceptance scenario

- **Seed:** Inbox sessions A (older, holds the inbox role, has topics and a capture in a
  topic) and an ordinary session B in the Inbox folder.
- **Action:** `sessions agents bind inbox <B>`, then a new capture, then from B
  `sessions ask --thread <A's capture>` and `sessions topics message <A's capture>`.
- **Expected:** The capture is admitted to B; the ask is admitted with A's thread root; the
  message read returns the capture's words; binding back to A makes A current again.
- **Replayable offline:** no (checked live on the server, with the router-actions entrance).
