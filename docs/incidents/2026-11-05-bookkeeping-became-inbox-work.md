---
failure: Service returns and upkeep notices became open Inbox requests during thread migration.
date: 2026-11-05
fix_commits: []
cause_status: confirmed
---

# Bookkeeping became Inbox work

## What was seen

At 11:34 UTC on November 5, the Inbox migration made open requests from service-origin transcript roots. A read-only ledger check found 62 open recovered requests rooted in returned results and 295 rooted in upkeep notices. Of the return-rooted topics, 18 had additional upkeep roots. These rows were separate from the original communication request or human work and could trigger more upkeep notices.

## Cause

The one-time migration treated every Inbox transcript root as a new human work request. A service return or upkeep notice could be a root without Tejas asking for work there.

## Fix

Future migration requires a human-authored root or a marked, routable agent capture. The correction for historical rows retires a recovered request only when every root in its topic is a service-origin return or upkeep input, one request was created from one of those roots, and there is no question, human reply or dispatch added after migration. The exact migration event, service roots, original request identity and source input become closure evidence. A matching communication or project-setup receipt is also cited when retained. The original request, outcome receipts, source inputs and topic history stay intact; the original work still needs its own checked answer.

The first correction was too broad. A fresh Claude Code review found it would also close 355 agent-work roots, including 291 on Tejas's own messages. Those roots may carry his delegated work and are excluded.

The narrow correction left two groups open. About 135 other recovered service notices (allowance, area suggestion, cut-off turn, background-job, watch and secret notices) were closed by hand by the acting Inbox router on November 6. Fifteen recovered threads rooted only in returns and upkeep stayed open because the router had since linked the original task, which is owned by another thread; each was flagged again every few hours ("Its work ended as answered") and drew another upkeep round. The correction now accepts every service-origin root, treats settled reading items as finished, and accepts later dispatches whose work has its home in another thread, citing each as evidence. A dispatch homed in the same thread, or nowhere, still keeps the request open.

## Acceptance scenario

- **Seed:** Retain a human message, an agent-work request sourced from it, and service return/upkeep inputs. Recreate older recovered topics for service roots, agent work, a mixed human/service root, a question and later assigned work.
- **Action:** Run migration and the owner correction twice.
- **Expected:** The human message retains its request. Only untouched service return/upkeep requests close, with exact migration and source identities cited. Agent work, the question, the human root and later assignment stay open.
- **Replayable offline:** yes (`bot/scripts/inbox-bookkeeping-recovery-fixture.ts` runs in the release build against its own scratch state directory).
