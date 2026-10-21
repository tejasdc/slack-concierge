---
failure: A reply Tejas wrote inside an Inbox thread showed "Queued" the whole time the agent was working on it.
date: 2026-10-09
fix_commits: [793be39e]
cause_status: confirmed
---

# His thread reply said Queued until the agent's final answer

## What was seen

When Tejas replied inside a thread, thnkr.ing showed the reply as Queued for the entire time the receiving agent was
working on it, and only changed when the agent's final answer arrived. He could not tell whether the agent had his
words or was still busy with earlier work.

## Cause

A thread reply is carried to the working agent as a forwarded request (`forwardReply` in
`bot/src/session-communication.ts`). The reply's status was written once as waiting and updated only when the final
reply settled the request; nothing followed the carrying request's execution state, locally or on the Mac peer.

## Fix

793be39e derives the reply's status from the request that carries it on every execution change here and on every poll
of the Mac (`session-receipt-status.ts`, `session-inbox.ts`, `session-peers.ts`): Delivered while the agent finishes
earlier work, the agent's own hold when one applies, Working once its run has the reply, and the final as before.

## Acceptance scenario

- **Seed:** An Inbox thread whose working agent session is mid-turn on other work (local and, separately, a Mac peer
  session).
- **Action:** Tejas sends a reply in that thread addressed to the agent.
- **Expected:** The reply's receipt reads Delivered while the earlier turn runs, Working once the run picks the reply up,
  then the final disposition; never Queued after delivery.
- **Replayable offline:** partly (local path yes with a stub provider; the Mac poll path needs a peer instance)
