---
failure: Saved check-in reasons could remain documented without reaching an agent who could act on them.
date: 2026-11-15
fix_commits: []
cause_status: confirmed
---

# Check-in reasons stopped at journal storage

Source: human capture `fbea55fb7e1911a50e2f80794d84d6a802376230e62c53da5271a60a1d92708b`, November 16 at 02:43:28.800 UTC. The request says reasoning should be processed rather than only documented and asks for prior check-ins to be backfilled. The [whole repair design](../plans/2026-11-15-actionable-checkin-processing.md) preserves the exact source and ownership boundaries.

## What was seen

The source request reports actionable reasons being documented without routing and asks for earlier check-ins to be audited. This record concerns that processing gap, not a proven cause for the later phone cover.

## Cause

The direct Journal check-in handoff asked the keeper only for quoted tracker observations and treated journal text as data. It had no separate processing disposition or Inbox request for actionable reasons. The canonical saved-word watcher followed journal-entry roots; Journal emergency-opening and Focus-opening reasons saved check-in roots outside that watcher. Saving a reason therefore did not establish that an actor received it.

The original party source is `checkin:escape-action-a2c5049d-8e7c-40d6-885b-d2844928138a`, event time November 14 at 21:47:53.891 UTC. The private source read confirms the original words and later explanation children. The friction investigation reports successful Journal opening and hall-pass acceptance; which later cover affected the phone remains that investigation's question. This incident does not claim the routing gap caused the later cover.

The current canonical job inventory contains 86 jobs and no match against the 24 audited check-in roots. This is complete for that inventory, not proof that no historical route ever existed. The introducing change and an earlier complete entrance audit are unknown. Earlier refused-button work preserved bytes in a separate unpublished implementation; it did not prove installed check-in storage or actionable routing.

## Fix

Every supported free-text check-in save reaches the existing durable queue. Versioned processing distinguishes delivery, exact-source review, tracked Inbox handoff and the resulting actor's outcome. No successful processing claim rests on tracker storage alone. A whole-entry source version catches child commands arriving after a review was prepared. Existing request links preserve already-admitted work; retry identity never replays an effect. Passive reflection, private source data and intentional friction remain separate.

## Acceptance scenario

- **Seed:** A saved free-text check-in with one reflection and two actionable passages, a versioned keeper admission, and a separate already-open Inbox observer. Retain a second case with an earlier accepted request for the same source.
- **Action:** Process the source, lose the response after Inbox acceptance, and retry using a new reviewing run. Separately add a child command after preparing a context-only review while leaving the root unchanged.
- **Expected:** Two distinct tracked Inbox requests and their visible outcomes; no duplicate dispatch, no replay of earlier accepted work, no reflection-only thread, and refusal of the stale review. A tracker-only success does not settle the processing obligation.
- **Replayable offline:** yes (owner/source/request contracts with disposable state); installed keeper, browser and physical-device claims require their separate real-system checks.

## Release evidence

The bounded `bot/scripts/journal-processing-fixture.ts` uses disposable owner/Inbox state for stale-source, missing-proof, separate-portion, Stop-during-read, duplicate, response-loss, restart and legacy-caller checks. It is not production or physical-device evidence.

Installed acceptance is pending. It must use the agent-authored check-in entrance and a separate read-only browser, observe a tracked actionable assessment and its result, and confirm passive reflection creates no work. No historical escape, real practice completion or personal browser state is replayed to get a receipt. Keeper 9752 owns historical audit/backfill, friction builder 7095 owns the party rule, and this outside Concierge repair session 9793 owns delivery and acceptance of the routing change.
