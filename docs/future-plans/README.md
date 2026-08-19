# Future plans

There are exactly three independent future projects extracted from the earlier
platform-hardening exploration. Each document is self-contained: it defines the
outcome, scope, ownership model, phases, acceptance criteria, and decisions
needed before promotion. You do not need to search or read a combined design.

1. [Provider isolation and sandboxing](PROVIDER-ISOLATION-AND-SANDBOXING.md) —
   non-root bot/provider identities, one lifecycle broker, credential/session
   migration, workspace authority, namespaces, and AppArmor.
2. [Concierge disaster recovery](CONCIERGE-DISASTER-RECOVERY.md) — coherent
   application generations, `remote-box`/restic ownership, offline journaled
   restore, external-effect reconciliation, and recovery drills.
3. [Monologue delivery receipts](MONOLOGUE-DELIVERY-RECEIPTS.md) — close the
   post-before-seen crash window while preserving the current Monologue flow.

These are proposals, not current runtime truth or approved implementation
plans. Promote only one at a time into `docs/plans/` after its product outcome,
scope, and risk are explicitly approved.

The original 2,831-line combined exploration is retained under `docs/archive/`
for provenance only. It is superseded, may contain rejected design iterations,
and is never required reading or implementation authority.
