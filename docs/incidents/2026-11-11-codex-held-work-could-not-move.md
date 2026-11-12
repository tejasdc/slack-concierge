---
failure: Work held on a Codex session with no allowance could not move to Claude, because the safe-to-move check accepted only inputs Claude had prepared, and nothing moved held sessions automatically.
date: 2026-11-11
fix_commits: []
cause_status: confirmed
---

# The Diwali session's move to Claude was refused, and 38 Codex sessions stayed queued

## What was seen

On 2026-11-11 no Codex account had room until Nov 12 and Google had none, while Claude had room on
tejas@chann.app. About 38 Codex sessions holding his open Inbox requests sat queued. The repair
agent proposed moving "Diwali party with Avi, Nov 14" (concierge:7992, 59 queued items) to a Claude
successor (concierge:9328); acceptance was refused: "A queued input may have reached its provider or
has dependencies." The one blocking item was turn 26398 (input request 44f155e6), whose only owner
event is `provider_turn_retry_queued` on 2026-11-07: "Usage for tejastej.dc@gmail.com is cached as
exhausted … No request was sent".

## Cause

The safe-to-move check, written when only Claude work moved to Codex, refused any input whose
receipt recorded an admission by a provider other than Claude. The execution host writes that
admission receipt for every claimed input just before the provider call, and the cached-usage
refusal happens inside the Codex call, so every Codex input the owner had ever claimed was
unmovable even though its usage hold proved nothing was sent. The refusal itself was classified
correctly: the journal's `failure_class: backoff` on that path is only reached with a usage hold.
Separately, only the Inbox had automatic provider failover, so every other held session waited
for a manual handoff.

## Fix

The check compares the admission with the session's own provider and ignores a capture's
`admissionIntent: live` marker. A paced automatic failover proposes the ordinary handoff for held
sessions whose provider the owner chose: at most two moved sessions working at once, open Inbox
requests first, no new move once the receiver reaches 75% use, unmovable sessions skipped for six
hours, unaccepted proposals withdrawn after 30 minutes.

## Acceptance scenario

- **Seed:** a Codex session with one input claimed, admission receipt naming Codex, refused by the
  cached-usage check (usage hold, admission intent set, no provider start).
- **Action:** read the handoff inventory.
- **Expected:** the input is movable; the same input with a provider start is not
  (`bot/scripts/held-work-movability-fixture.ts`).
- **Replayable offline:** yes
