# Future plans

These independent proposals are not current runtime truth. Each document is
self-contained and defines its outcome, scope, ownership model, acceptance
criteria, and decisions needed before promotion.

1. [Provider isolation and sandboxing](PROVIDER-ISOLATION-AND-SANDBOXING.md) —
   non-root bot/provider identities, one lifecycle broker, credential/session
   migration, workspace authority, namespaces, and AppArmor.
2. [Concierge disaster recovery](CONCIERGE-DISASTER-RECOVERY.md) — coherent
   application generations, `remote-box`/restic ownership, offline journaled
   restore, external-effect reconciliation, and recovery drills.
3. [Monologue delivery receipts](MONOLOGUE-DELIVERY-RECEIPTS.md) — close the
   post-before-seen crash window while preserving the current Monologue flow.
4. [Cross-project deployment status](CROSS-PROJECT-DEPLOYMENT-STATUS.md) — make
   push-driven deployment reactions available to existing and newly created
   managed projects without teaching feature agents a deployment protocol.

These are proposals, not current runtime truth or approved implementation
plans. Promote only one at a time into `docs/plans/` after its product outcome,
scope, and risk are explicitly approved.

The original 2,831-line combined exploration is retained under `docs/archive/`
for provenance only. It is superseded, may contain rejected design iterations,
and is never required reading or implementation authority.
