---
failure: An outside request could not declare its own active release watch.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# Outside request release watch refused

## What was seen

On November 6, 2026, outside work request `47183115-d38b-4e68-b233-1177c6097b3a`
registered renewing release watch `f34d13b3eee4` from its recipient session and
source run. The watch was observing and appeared in session obligations. Its
`sessions reply --partial --waiting-on-watch` call was refused with “needs an
active watch owned by this agent”; a plain partial was recorded. The outside
agent reported the defect without changing the request ledger. It later closed
that work request after its release check, so this incident does not reopen it.

## Cause

The reply validator recognized local and peer request rows but omitted outside
requests. Its outside reply path also discarded the watch ID. The shared wait
predicate, Stop hook, and renewing-watch close check likewise covered local and
peer requests only. Thus accepting the flag alone would have left an outside
request without a durable wake condition.

## Fix

The repair makes the three request kinds use the same active recipient-session
watch evidence. Outside partials retain the watch ID; request liveness, the Stop
hook, and renewal termination read it. The outside reply's action key still
refuses a changed retry. The alternative of treating any session watch as a wait
would let an unrelated watch conceal an unfinished request, so the request and
watch identities remain joined.

## Acceptance scenario

- **Seed:** An outside work request is delivered to an agent session, which registers an active renewing file watch from its exact source pair.
- **Action:** The agent sends a partial reply for that request naming its watch.
- **Expected:** The reply records the watch ID, the request remains open, and the Stop hook does not demand a final reply while that watch is active. A different session's watch or an unknown watch is refused. After the agent's final reply, that watch series does not renew again. The original request and watch IDs are forensic evidence, not test inputs to replay.
- **Replayable offline:** yes, with an isolated owner ledger and file watch.
