---
failure: Held agent returns repeatedly blocked new requests during Inbox upkeep.
date: 2026-11-05
fix_commits: []
cause_status: confirmed
---

# Held returns and thread upkeep delayed the owner

## What was seen

After the exact request-link scan was repaired, the owner still reported 450–940 ms event
loop delays. Final answers with the same post identities appeared in the log several times a
second, while provider readings caused another long Inbox sweep. Incoming sessions and app
reads share this event loop.

## Cause

Two final request events remained `held` because their asking sessions were unavailable or
archived. Each delivery poll correctly revisited the held return, but it repeated the
already posted answer's filing, linked-copy checks and whole-thread upkeep. Separately, a
provider reading ran one synchronous pass across 1,165 open Inbox topics and their retained
requests. Live owner traces counted about 7,000 ledger calls on an answer retry and about
21,000 calls on a provider-reading pass.

## Fix

After posting, filing, copying linked answers and updating the thread, the owner records a
durable receipt for the exact final event. A held return can still retry delivery to its
asker, but completed Inbox work is reused; if any Inbox step fails, the receipt is absent
and the same event retries. The provider-reading sweep yields between short groups of topic
transactions. It keeps the same exact work and recovery identities, and overlapping readings
share the active pass. Before admitting recovery, it rechecks the current request and his
answers so a reply that arrived during a yield cannot trigger stale recovery.

## Acceptance scenario

- **Seed:** A final agent answer already posted and filed in an Inbox thread, whose return to
  an unavailable asking session remains held; more than a thousand open Inbox topics exist.
- **Action:** Poll the held return repeatedly while a provider reading checks all open work.
- **Expected:** The answer appears and is filed once; the held request remains retained for
  its asker; subsequent polls do not repeat thread upkeep; incoming requests are admitted
  while the Inbox sweep progresses, without an owner loop delay over 200 ms from that sweep.
- **Replayable offline:** yes (with a diagnostic ledger snapshot and a held return).
