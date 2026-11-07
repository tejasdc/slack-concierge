---
failure: An Inbox prompt waited for a global history rebuild even though it needed one thread's return status.
date: 2026-11-07
fix_commits: []
cause_status: confirmed
---

# An Inbox prompt waited for unrelated history after restart

## What was seen

After the yielding index repair, a restart rebuilt 18,273 Inbox entries in 4,434 steps
over 111 seconds. The installed initial and steered prompt paths awaited that whole
rebuild before preparing a provider message; the exact cold-prompt wait has not yet
been measured. The owner loop remained responsive, but a prompt admitted then could
wait for the remaining rebuild. The earlier synchronous build had blocked the owner
for 18.5 seconds; yielding the same global work moved rather than removed the prompt's
dependency.

## Cause

Prompt construction called the global entry index only to determine whether a returned
answer in the current topic still needed relaying. Both initial and steered Inbox sends
waited for the entire global warm-up before invoking that construction. The other topic
facts were already available from retained topic and request records.

## Fix

Prompt construction now resolves final returns and later posts for its topic directly
from retained request, event and Inbox message identities. It includes root-addressed
upkeep requests that have not been linked into a topic request. The global index still
warms for list and topic reads, but neither initial nor steered provider sends waits for
it. Accepted input identity and its durability barrier are unchanged.

## Acceptance scenario

- **Seed:** A restarted owner has more Inbox history than one warm-up step, and a topic
  has a retained worker final that has not yet been posted in that topic.
- **Action:** Admit an initial or steered Inbox input in that topic while the background
  index is still warming, then post the returned answer.
- **Expected:** The prompt starts from the current topic without waiting for the global
  warm-up. It names the unrelayed answer before the post and omits that warning after
  the post. A later topic read still reaches complete index coverage.
- **Replayable offline:** yes (the isolated topic completion fixture exercises the
  retained final and post across a cold index reset; cold-start timing also needs a
  marked installed request).
