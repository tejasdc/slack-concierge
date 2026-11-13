---
failure: An explicitly refused Codex account switch remained waiting in supported operation receipts.
date: 2026-11-13
fix_commits: []
cause_status: confirmed
---

# A refused Codex switch looked unresolved

## What was seen

The agent command returned a definitive active-work refusal and the Codex daemon and
account stayed unchanged. The exact operation and receipt-page views nevertheless said
`waiting`, with no result or error. The immediate reply omitted the retained operation
ID, so the experimenter had to associate the response with the operation by timestamp
and source. Earlier explicit refusals had the same receipt mismatch.

## Cause

The switch saved a direct reply with `status`, while the common operation projection
read `state`. It also hid result fields for every action, including this switch. The
retained action already carried the exact ID and agent source; the projection discarded
the useful result.

## Fix

The immediate reply now includes its retained operation ID while keeping the switch's
existing `status` and `detail`. The exact operation and compact receipt readers derive
their existing operation state from that structured status: a refused activation is
`failed`, an applied activation is `completed`, and an unconfirmed result is `uncertain`.
No second outcome field or English-message classifier is used. Historical receipts are
read from their original saved result; nothing is replayed, migrated or synthetically
settled. Account movement, guards, activation reconciliation and admission holds are
unchanged.

## Acceptance scenario

- **Seed:** An admitted agent work input in disposable state. The normal routed command calls the guarded switch entrypoint replaced by a deterministic no-provider refusal, then reads the resulting operation through the canonical owner and compact receipt readers. A second scenario seeds an old status/detail receipt as-is.
- **Action:** Invoke the same source/action once more and read both retained receipts. The fixture counts switch-entry calls and never starts a provider or changes an account.
- **Expected:** Direct reply, duplicate reply, exact receipt and compact receipt share the retained operation ID and structured result. Receipt state is `failed`; status/detail and agent source stay intact. Historical receipts also render `failed` without replay or migration.
- **Replayable offline:** yes; `bot/scripts/codex-account-switch-receipt-fixture.ts` runs the admitted route and canonical owner read against a disposable database with a deterministic refusal.
