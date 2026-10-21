---
failure: One episode of both Claude and Codex running low published two warnings four minutes apart.
date: 2026-10-09
fix_commits: [da43c8f5]
cause_status: confirmed
---

# The "both providers are low" warning appeared twice for one episode

## What was seen

Tejas's Inbox showed two identical "Both Claude and Codex are at or above 90%" warnings about four minutes apart, although
neither allowance had refilled and nothing about the situation had changed.

## Cause

`bot/src/provider-usage-notice.ts` deduplicates a notice by its key, and the shared-pressure key was
`both-providers-at-90:<claude reset period>:<codex reset period>`. The reset times come from whichever accounts are
currently eligible to start new work. A live account eligibility change (an account becoming or ceasing to be usable)
altered the reported reset time, so the same pressure produced a different key and a second notice. Confirmed from the
commit message; the specific account change was not re-derived here.

## Fix

da43c8f5 makes the publisher look for an open shared warning first: a `provider_usage_warning` event whose payload has
`providers`, whose `resetsAt` is still in the future, and whose service notice has not been resolved. If one exists no new
warning is published, so the key can no longer fork an episode. The same commit also closes the duplicate that was already
published: the settlement pass walks warnings in event order, keeps the first, and settles later active ones with "This
repeated warning has closed. The first warning remains active."

## Acceptance scenario

- **Seed:** Claude and Codex both at or above 90% with reset times R1; a first shared warning published and unresolved.
- **Action:** Change which accounts are eligible so the computed reset times become R2, then run the usage watch again.
- **Expected:** No second warning is published while the first is open and unexpired. With a pre-existing duplicate seeded,
  exactly one stays active and the other is settled with the "repeated warning has closed" text.
- **Replayable offline:** yes (ledger rows and synthetic usage readings; no provider needed)
