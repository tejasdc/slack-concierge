# Future plans

These documents preserve valuable design work that is intentionally outside
the active Pebble webhook scope. They are proposals, not current runtime truth
or approved implementation plans.

- [Provider isolation and sandboxing](PROVIDER-ISOLATION-AND-SANDBOXING.md) —
  non-root provider identities, a narrow launch broker, credential migration,
  process namespaces, and AppArmor.
- [Concierge disaster recovery](CONCIERGE-DISASTER-RECOVERY.md) — coherent
  application snapshots, restore ownership, external-effect reconciliation,
  and recovery evidence.
- [Monologue delivery receipts](MONOLOGUE-DELIVERY-RECEIPTS.md) — close the
  post-before-seen crash window without coupling Monologue to Pebble.
- [Complete source exploration](2026-08-19-platform-hardening-source-design.md)
  — the preserved, superseded design from which these projects were extracted.

Promote one proposal at a time into `docs/plans/` only after its desired user
outcome and operational risk justify implementation.
