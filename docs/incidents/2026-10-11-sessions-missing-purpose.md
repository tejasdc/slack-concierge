---
failure: Most agent sessions, including the standing Thread reader, showed no purpose in thnkr.ing, because the description given at creation was dropped or never asked for.
date: 2026-10-11
fix_commits: [5e51c1af, 2f667a85, ff79b71f, 55f96d1f]
cause_status: confirmed
---

# Sessions had no purpose to show

## What was seen

2,285 of 2,438 sessions had no purpose, and thnkr.ing's hover said so over the standing Thread reader (capture 9840ea45:
"wait what is the thread reader doing why is its purpose missing?"). The Mac's 114 older sessions stayed empty even after
the server was filled.

## Cause

Session creation paths did not require a purpose: an agent creating a local or peer session dropped its one-line request
summary, and other paths (forks, imports, the Inbox, hand-started sessions) supplied none. The startup fill added later
ran only from `index.ts`; the Mac starts through `session-runtime.ts`.

## Fix

5e51c1af keeps the request summary when an agent creates a local or peer session. 2f667a85 makes `createNativeSession`
require a purpose (throws without one) and fills existing sessions at startup from a one-time `session-purposes.json`, then
their first words, never overwriting a written purpose. ff79b71f keeps the Inbox and repair agent described by their role
rather than their first message. 55f96d1f runs the fill in `session-runtime.ts` so the Mac gets it.

## Acceptance scenario

- **Seed:** A ledger with sessions lacking a purpose (one Inbox, one with a first human message), on both runtime
  compositions.
- **Action:** Start the owner; an agent then creates a session with `--summary`.
- **Expected:** Every session has a purpose (the Inbox's is its role); the new session's purpose is the summary; creating
  a session without a purpose fails.
- **Replayable offline:** yes (scratch ledger)
