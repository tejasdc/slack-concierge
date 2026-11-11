---
failure: A session's receipt list showed a delegated request with no human behind it while its full record named his capture, so thnkr.ing's send check refused his explicit ring send.
date: 2026-11-10
fix_commits: []
cause_status: best-explanation
---

# His ring send was refused because the receipt list lost who asked

## What was seen

On 2026-11-10 the messaging agent's receipt list (`GET /sessions/v1/presentation/receipts/concierge:3912`)
listed requests `1606936e…` and `f0c175ea…` with `provenance.originatingHuman = null`. The full
operation record for the same requests named his ring capture `capture:fda0ae73…`. thnkr.ing's
send check read the list and refused his explicit send to Sophie; it now reads full records.

## Cause

The receipt list is built in the presentation worker, a separate process, so it carried its own
hand copy of the owner's walk from an input to the human behind it. The owner's walk later learned
two more ways a human stands behind an input: a message the Inbox routed from his own words
(`routedFrom`, added 2026-10-15 and used by the routing handoffs of early November) and a human
Inbox reply forwarded before it owned a run. The copy never received either, so any request whose
only link to him was one of those listed no human. Confirmed: the copy lacked both steps.
Best explanation, not observed row by row: these two requests reached him through one of them
(agent shells cannot read the live ledger to show which).

## Fix

One walk, `bot/src/input-provenance.ts`, takes its database as an argument. The owner's record
calls it with the live ledger and names a missing run as before; the receipt worker calls it with
its read-only handle and only reads existing run names. A change to the worker bundle rebuilds
every retained receipt automatically.

## Acceptance scenario

- **Seed:** a human Inbox capture; an agent request whose input carries `routedFrom` naming that
  capture's input, with no source chain reaching him otherwise.
- **Action:** read the request's operation record and the session's receipt list.
- **Expected:** both name the same `originatingHuman`, including its capture ID.
- **Replayable offline:** yes
