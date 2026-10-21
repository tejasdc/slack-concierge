---
failure: A ChatGPT request that was running when Concierge restarted was marked failed in the first second after the restart while ChatGPT was still answering.
date: 2026-10-09
fix_commits: [395c7d1c]
cause_status: confirmed
---

# A ChatGPT run taken back after a Concierge restart failed as unverifiable

## What was seen

In the 7:26 PM live check on October 9, the first takeover of a running ChatGPT request after a Concierge restart ended
the run as an error although ChatGPT was still writing the answer. This was the first live run of d0785db6, which had
made ChatGPT requests survive Concierge updates 12 minutes earlier. It is distinct from the Thinkering-restart failures
recorded in [the in-progress answer record](2026-10-09-chatgpt-answer-failed-during-thinkering-start.md).

## Cause

Startup adoption (`claimAdoptableExecutions`) runs before the owner request API is listening. Thinkering's ChatGPT
capability verifies every reconcile/observe call by asking this owner for the run's receipt, so the follow's first call
was refused as unverifiable and `bot/src/session-execution-host.ts` treated that as the run's end.

## Fix

395c7d1c adds an owner-serving promise to the execution host; both runtime compositions (`index.ts`,
`session-runtime.ts`) call `markOwnerServing()` once the request API listens, and an adopted ChatGPT run awaits it
before following.

## Acceptance scenario

- **Seed:** A ledger with a live `capability-host` ChatGPT execution; a stub capability that refuses calls until the
  owner's receipt route answers.
- **Action:** Start the owner.
- **Expected:** The adopted run issues no follow call before the API is listening, then follows and settles with the
  answer; it is never marked error.
- **Replayable offline:** yes (stub capability that checks the owner socket)
