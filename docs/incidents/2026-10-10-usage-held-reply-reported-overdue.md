---
failure: A thread reply held only by a usage limit was reported as an overdue, stalled answer by a Service post, with internal request ids, instead of saying it waited for the allowance.
date: 2026-10-10
fix_commits: [d617eff2]
cause_status: confirmed
---

# Usage-held replies were announced as overdue

## What was seen

When the receiving agent's account was at its usage limit, Tejas's forwarded thread replies sat queued and the overdue
check posted a Service "no answer yet" message into the thread, naming internal request ids and commands. The reply's
own receipt did not say it was waiting for a usage reset.

## Cause

The reply receipt carried no usage refusal or reset time, including for replies queued behind an earlier usage-held
turn, so `request-liveness.ts` treated the silent request as stalled and posted an overdue Service answer. Human notices
included ids and commands from the agent-facing template.

## Fix

d617eff2 carries the usage refusal and reset time into the reply receipt (`session-receipt-status.ts`,
`prepared-receipt-core.ts`), including queued replies behind an earlier hold; forwarded human replies show that one status
line instead of an overdue Service post; old false stalls reopen from retained hold evidence; human notices omit internal
ids and commands.

## Acceptance scenario

- **Seed:** A thread whose working agent's account is usage-held with a known reset; one earlier held turn in that
  session.
- **Action:** Tejas replies in the thread and 20 minutes pass.
- **Expected:** The reply's receipt shows the usage hold and reset time; no overdue Service post appears in the thread;
  no notice text contains a request id.
- **Replayable offline:** yes (synthetic usage hold, fake clock)
