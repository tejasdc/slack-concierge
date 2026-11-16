---
failure: An Inbox answer the router posted in its thread could not be filed as something for him to read, so it sat in "unfiled" and repeated in every later router prompt.
date: 2026-11-11
fix_commits: []
cause_status: best-explanation
---

# A posted Inbox answer stayed unfiled

## What was seen

On Nov 11 at 06:16 UTC the Inbox router (Claude Code session 9326, which took over from the
Gemini Inbox 9305 that morning) posted its answer into thread `capture:ddce3710` in the topic
"Your messages left unfiled" and declared the turn a response. Filing that attention entry was
refused: `topics file` answered "Nothing to read: the turn that raised this posted nothing into
this thread", and `topics questions` with `from=<need>` answered "No unfiled attention entry has
that id." The entry stayed in the router's unfiled list.

## Cause

Two lookups assumed the topic's own Inbox session is the session that ran the turn. After a router
takeover the topic belongs to an older Inbox session, while the new router records its posts,
turns and attention entries under its own session.

- The reading check searched for the turn's posts only under the topic's session, so it found none.
- `topics questions … from` looked for the attention entry on the topic's session, not on the
  declaring router that holds it.

The live ledger is hidden from agent shells, so the session ids of the topic and the post were
inferred from the code paths and the two refusals, not read directly.

## Fix

The reading check looks for a turn's posts under the session that ran the turn. A `from`
declaration files the entry from the declaring Inbox router when that router holds it.

## Acceptance scenario

- **Seed:** two Inbox sessions; a topic opened by the older one with thread root R; a turn of the
  newer router that posted text into R and declared outcome `response`, leaving an unfiled entry.
- **Action:** the newer router runs `sessions topics file <topic> --need <entry>`.
- **Expected:** a reading item is filed whose text is the post; the entry leaves the unfiled list.
- **Replayable offline:** yes
