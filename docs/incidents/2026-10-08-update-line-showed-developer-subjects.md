---
failure: The update line showed developer commit subjects for changes that did have a plain sentence, and implied the waiting update was everything coming.
date: 2026-10-08
fix_commits: [d5dbac0f]
cause_status: confirmed
---

# The update line showed developer summaries instead of his sentences

## What was seen

On 2026-10-08 Tejas's update line in thnkr.ing listed "Developer summaries" for a change whose plain-language
sentence had been written as a note after the commit was pushed. The line also listed only what the current
update would install, so a short list read as all that was coming while more was queued behind it.

## Cause

Confirmed from d5dbac0f. `release-history.ts` reads `Update-note:` sentences from the commit and from
`refs/notes/update`, but the deployment-owned checkout fetched only branches (`deployment-push.ts`), so notes
added after a push never reached it. The wait payload in `session-owner.ts` carried only the waiting run's
changes.

## Fix

d5dbac0f: each accepted push also fetches `+refs/notes/update:refs/notes/update`; when a summary lacks a
sentence, `release-history.ts` refreshes notes in the background at most every three minutes
(`refreshNotesSoon`), so the owner never waits on the network. The wait payload adds `queued`: notes and
subjects for what was pushed after the waiting update's commit.

## Acceptance scenario

- **Seed:** commit C pushed without an `Update-note:` line; a note added afterward on `refs/notes/update` in
  origin; a later commit D pushed while the update for C waits.
- **Action:** read the update status twice, more than three minutes apart.
- **Expected:** the second read shows C's note sentence, not its subject, and lists D under queued changes.
- **Replayable offline:** yes (scratch origin repository with notes)
