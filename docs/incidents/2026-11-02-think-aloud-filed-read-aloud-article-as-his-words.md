---
failure: The think-aloud agent saved sentences Tejas read from an article as his own working definition.
date: 2026-11-02
fix_commits: []
cause_status: confirmed
---

# Read-aloud article text became his Canvas words

## What was seen

Tejas said he was reading the Blygger introduction on his Canvas. The retained speech in
`concierge:7810` includes the cue at 22:57:05 UTC and the article's first two sentences at
23:06:47 and 23:07:13. The agent called the first sentence "your first compact definition"
and saved both as "your working definition". Tejas reported the authorship error in his Mac
capture at 6:15 PM ET (`capture:4a4c1dcfbc1752311aecf2fe64caba125767d5de0c5766c8cfc2b9c59c135f03`).

## Cause

The Concierge think-aloud instructions treated the whole speech transcript as his words for
Canvas points and Reader notes. They did not distinguish his read-aloud quotation from his
separately spoken reaction. The original cue and quoted sentences arrived as separate turns;
speech batching was repaired separately. The missing authorship rule remained in the prompt.

## Fix

The single think-aloud prompt now treats speech introduced as reading an article, book or other
source as source quotation. It tells the agent to locate the passage in Reader when useful, to
record only a separately spoken reaction as his words, and to ask before filing if the boundary
is uncertain. Reader notes follow that same distinction. This is the prompt loaded for each
Canvas speech turn on the server and by thnkr.ing's isolated real-Codex workspace.

## Acceptance scenario

- **Seed:** an isolated thnkr.ing Canvas with its think-aloud agent and the installed Concierge
  instructions; Tejas's cue and first two Blygger introduction sentences from the retained run
  are joined as one speech message, as current batching delivers them.
- **Action:** send that message through the Canvas think-aloud panel to a real continuing Codex
  turn, then read its answer and the resulting Canvas/Reader state.
- **Expected:** the article sentences are not filed as Tejas's definition, claim, or note. Any
  saved passage is labeled as source text; any uncertain passage remains unattributed.
- **Replayable offline:** no (the real Codex turn and installed isolated thnkr.ing workspace are
  needed to check how the agent follows the prompt).
