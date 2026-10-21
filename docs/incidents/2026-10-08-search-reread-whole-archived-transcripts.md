---
failure: A session search that matched a very long archived transcript took ten seconds and held up Concierge while it re-read whole archived conversations.
date: 2026-10-08
fix_commits: [f8e8ea09]
cause_status: confirmed
---

# Session search re-read whole archived conversations

## What was seen

Supervisor incident 708b0814 on 2026-10-08: one session search took 10.2 s on the owner's loop. Four archived
candidates each needed a check; the Inbox router's 289 MB transcript took 5.8 s and 120 MB per check.

## Cause

Confirmed from f8e8ea09. Session search proved each archived candidate still existed with a Thinkering
`context` read of `limit:1`. Thinkering answers `context` by re-reading and serializing the whole retained
snapshot of that version, regardless of the limit. 989 of 37,685 archive sources are files over 50 MB, so any
search matching one paid a full transcript read per candidate.

## Fix

f8e8ea09: `retainArchiveSource` in `session-owner.ts` proves retention with one page of Thinkering's prepared
history for the exact version, built once from the digest-checked snapshot and answering in about 2 ms
afterwards. Both the word and the meaning search paths use it; a composition without prepared history keeps the
`context` read. (A later regression where the bounded page omitted source identity is recorded in the
[dispatch incident record](2026-10-08-dispatch-hang-handoff.md), fixed by 0e8cdb21, 992ad18a, 1de55bec.)

## Acceptance scenario

- **Seed:** an archive index with four matching candidates, one backed by a ~300 MB transcript with prepared
  history available.
- **Action:** run a session search that matches all four.
- **Expected:** the search completes in well under a second, makes no `context` call, and returns the same
  retained candidates.
- **Replayable offline:** partly (needs a Thinkering source host stand-in that serves prepared history pages)
