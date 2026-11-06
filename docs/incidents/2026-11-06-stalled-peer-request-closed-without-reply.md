---
failure: A stalled Mac request could close without the agent's explicit final reply.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# Stalled peer request closed without an agent reply

## What was seen

Tejas's September 23 dropped-result report described a Mac request closed on the
agent's interim words, followed by a real final answer six minutes later. The
explicit-reply repair removed prose inference from normal dispatch. On November 6,
source inspection found that the server's separate peer reconciliation still closed
an overdue request as `unanswered` when the Mac turn had ended without a final.

## Cause

Peer reconciliation treated a stalled notice as a terminal answer. This contradicted
the request owner rule that only an explicit final, requester cancellation, or a
failed or cancelled execution settles agent work.

## Fix

Peer reconciliation no longer settles a request merely because its worker ended or
its due time passed. Existing overdue and stalled notices remain. The Mac's final
reply still forwards by its retained event identity and settles at the server.

## Acceptance scenario

- **Seed:** Ask a Mac agent for work, then record a partial reply.
- **Action:** Let its turn end without a final reply and allow the request to become stalled. Later, send an explicit final from that same agent.
- **Expected:** The request stays open after the turn ends and after the stalled notice. The final settles it once and returns to the requester with the original request identity.
- **Replayable offline:** yes (a two-owner request fixture can advance the due time and deliver the retained final).
