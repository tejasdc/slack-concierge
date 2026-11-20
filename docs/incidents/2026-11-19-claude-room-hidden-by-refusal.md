---
failure: A Claude account with room could not run held work because an older refusal excluded its exact model.
date: 2026-11-19
fix_commits: []
cause_status: confirmed
---

# Claude room hidden by a cached refusal

## What was seen

At Essos, two requests showed no Claude account with room until November 22. The server's current `hey@tejas.nyc` account read 45% of its weekly allowance used, and an independent, tool-free Opus 5.5 request from that account completed. The `tejas@chann.app` account read 100% used. The Inbox was serving work on `hey@tejas.nyc`.

## Cause

The owner retained an exact Opus refusal under the `hey@tejas.nyc` label with a November 22 reset, even though that account's fresh weekly reading showed a November 19 reset. Its exact-model account choice consulted the retained refusal and excluded `hey`, while a generic Opus choice selected it. The historical refused process's effective credential identity was not recorded, so whether it used the other account remains unproved. The explicit held-usage check on a runner read the usage bars without asking Claude: it released two turns, and the old refusal immediately held a turn again.

## Fix

When the fresh account reading and cached reset disagree, the owner requests one tool-free check on the runner, bound to the exact held turn and refusal revision. The runner confirms the effective login before and after a completed request on the held model. Success retires only older refusals for that account and model and wakes queued work; a newer refusal or failed check preserves the hold. The automatic check runs once per refusal revision and observed allowance window during one owner lifetime. The explicit held-usage check follows this same proof path on a runner. Before every managed runner turn, a login check records the selected and observed accounts and refuses a mismatch before sending the prompt; this closes the historical account-identity logging gap for future attempts.

## Acceptance scenario

- **Seed:** A usage-held Opus turn, a cached refusal under the selected account until November 22, and a later fresh reading of the same account with room and a November 19 reset.
- **Action:** Refresh account usage or run the explicit held-usage check.
- **Expected:** A runner probe on the selected account and model succeeds, the exact old refusal is retired, and the original queued turn starts without an additional input. A failed probe leaves the turn held and does not send a false room notice.
- **Replayable offline:** no (the account identity and provider admission must be checked on the installed runner).

## Installed acceptance and repeated refusal

The first repair was installed at 4:48 PM Eastern. Its exact Opus check succeeded on
`hey@tejas.nyc` and released two original turns. The Inbox turn completed. The other
turn belonged to a Claude conversation last measured at 838,551 of its one million
context tokens. It reached Claude and received a new 429 with the same November 22
reset on Opus, Sonnet and Haiku, then returned to its own usage hold. A fresh exact
Opus request under the same selected login completed; resuming and forking that long
conversation under the same login reproduced the 429. The retained provider trace
does not identify the quota owner on the wire, so the reason that continuation
returns another account's reset remains unknown.

The personal account independently read 0% weekly used with its own November 25
reset and had a signed-in, proven local home. It too held an Opus cache entry with
the November 22 reset. Both entries made the chooser exclude accounts that could
accept fresh work. This second repair treats a reset that matches a different
freshly read account's weekly window as an attribution conflict. The provider
refusal still holds its exact turn, while the conflicting entry cannot block
the selected account for unrelated work. A real future refusal whose reset
matches its selected account remains a normal cached limit.

The long conversation's queued watch and open requests were transferred by the
ordinary same-provider handoff to a fresh Claude conversation. Acceptance moved
linked copies of the two queued inputs and canceled their old executable copies;
the old transcript remained intact. This is the recovery for that specific
conversation, not evidence that all long continuations are automatically movable.
