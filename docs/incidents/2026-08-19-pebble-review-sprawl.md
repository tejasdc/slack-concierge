# Pebble webhook review sprawl and rollout failures (2026-08-19)

## Summary

A bounded request—accept authenticated Pebble transcripts at a readable HTTPS
URL and deliver them through the existing Slack Concierge flow—expanded into a
2,831-line, 25,015-word platform design with thirteen recorded `NO-GO` rounds
and a fourteenth pending review. Planning and review consumed roughly six hours
before the user stopped the loop. The oversized design combined Pebble capture,
Monologue delivery receipts, provider sandboxing, disaster recovery, project
scaffolding, backup/restore, and Slack metadata changes.

The useful work was recovered by replacing that exploration with one bounded
Pebble plan and three independent future plans. Production eventually shipped,
but the first rollout attempts exposed three additional problems: an ad hoc
launcher omitted the Git credential environment, ingress rejected systemd's
real credential ACL mode, and the deploy probe timed out while an unrelated
best-effort Canvas refresh delayed the online marker.

This was primarily a scope-control and review-contract failure. The answer is
not less care at real security or data boundaries; it is proportional care,
fixed reviewer jurisdiction, actual-environment probes, and explicit stopping
rules.

## Requested outcome

- A configurable, authenticated webhook at
  `https://capture.tejas.nyc/pebble`.
- Transcription-only delivery for minimum latency and payload size.
- Normal delivery into `#slack-inbox`, reusing Concierge's existing trusted
  Slack credential without placing it in the public ingress process.
- A route abstraction that permits future sources without hard-coded control
  flow.
- Preservation of the historical `/audio` route.

The request did not require redesigning Monologue, provider identities,
provider launching, backup/restore, AppArmor, project scaffolding, Slack
metadata, Lists, or Canvas behavior.

## What happened

1. The first implementation proposed a dedicated Slack capture app. The
   security goal—keep Concierge's powerful credential out of an
   Internet-facing process—was valid, but a second app was not required. The
   chosen boundary was revised so ingress persists authenticated captures and
   trusted Concierge performs Slack delivery with its existing user token.
2. “Review until GO” began without a fixed operating profile, scope contract,
   reviewer jurisdiction, or stopping condition. Each review treated another
   theoretical hardening opportunity as a blocker and the document grew into
   a platform rewrite.
3. The user interrupted after approximately six hours. The exploration was
   archived, the three unrelated initiatives were split into self-contained
   future plans, and the active plan explicitly excluded them.
4. The bounded implementation shipped in `c5cde9c`; the large exploration and
   future plans were separated in `f43d68a`.
5. A Pebble-specific one-off rollout wrapper failed because it did not provide
   the non-interactive Git credential environment already owned by the
   permanent deploy path. The permanent entrypoints were corrected in
   `33c0319`.
6. The capture service then failed because application validation permitted
   only root-style `0400` credentials, while systemd v255 presents `0440` to a
   non-root service through its unit-private ACL. A real systemd preflight and
   focused negative tests led to `62befb4`.
7. Both services started, but the deploy command reported a false failure
   because normal startup waited for a multi-minute best-effort Canvas refresh
   before publishing readiness. `f0b5ddc` moved ordinary readiness ahead of
   Canvas maintenance; only an explicit scaffold cutover may require Canvas
   completion before startup.
8. The public endpoint, authentication failures, durable queue, Slack delivery,
   and normal agent admission were verified end to end in production.

## Root causes

### Review had no bounded contract

The reviewer was effectively asked whether an ever-growing imagined platform
was perfect, not whether the requested webhook met its acceptance criteria
without regressing existing behavior. “Every `NO-GO` finding must be fixed”
converted advisory review into authority to expand the product.

### Scale and consequence were unstated

The design implicitly optimized a single-operator personal system for
enterprise-scale availability, restore coherence, process isolation, and audit
closure. A public webhook genuinely requires authentication, secret isolation,
body bounds, and safe persistence. It does not make every adjacent subsystem a
release dependency.

### Useful hardening and new projects were conflated

Security language made scope expansion appear mandatory. Provider UID
migration, AppArmor policy, a replacement backup/restore system, and Monologue
receipts were potentially useful, but none was required to authenticate and
deliver a Pebble transcript safely.

### Theory displaced executable evidence

Repeated design rounds reasoned about increasingly hypothetical states while
missing the production credential mode that a short real systemd preflight
would have exposed. Later, a generic readiness test was coupled to unrelated
Canvas maintenance instead of the minimum live contract: Slack connection,
capture worker, queue authentication, and online marker.

### The rollout duplicated the permanent path

The one-off launcher reconstructed deployment behavior and omitted `HOME`, so
the existing Git credential helper became invisible. A feature-specific
orchestration wrapper added another environment and another failure surface
without adding product value.

### The review tooling encoded the same bias

A forward test of the revised instructions gave a narrow, read-only
documentation review to a fresh agent. It immediately selected the legacy
`workflows-review` skill, whose default workflow calls for exhaustive analysis,
many specialist agents, 10×/100×/1000× scale scenarios, and automatic todo
creation. The review was stopped instead of allowing the tool to expand the
task.

The skill was retired on 2026-08-20 through the Git-backed workspace-skills
catalog in `6e125f9`. A permanent `retired_load_names` tombstone makes each
healthy peer recoverably remove the obsolete skill paths, same-named Codex
prompt, and Claude permission while advertising the name as an rsync exclusion.
Because unrelated dirty skill checkouts temporarily blocked full catalog
reconciliation on the server, its verified legacy copies were first moved to
Trash and the synced prompt path was replaced with an inert retirement
tombstone. That prevents the exhaustive workflow from returning during the
transition; normal reconciliation removes the inert prompt when topology is
healthy.

## What earned its complexity

- Credential-free public ingress. The route bearer may face the Internet; the
  Slack credential may not.
- Configured routes, adapters, limits, labels, and destinations rather than
  Pebble-specific branches in the main bot.
- Durable acceptance before returning `202`, stable event identity, and
  retry-safe Slack delivery.
- A private authenticated queue boundary with one routine SQLite owner.
- Historical `/audio` compatibility.
- One focused security/implementation review of the actual diff.
- Real production probes for health, negative authentication, durable status,
  and visible Slack delivery.

These directly implement requirements or protect an observed trust/state
boundary. They remain part of the shipped system.

## What did not belong in this release

- Provider UID and launcher migration.
- AppArmor/provider sandboxing.
- A new disaster-recovery and backup generation system.
- Monologue delivery receipts and cursor redesign.
- Project scaffolding, Slack metadata, Lists, and Canvas changes.

These ideas remain independently reviewable future plans. Their value does not
make them Pebble blockers.

## Prevention rules

1. Establish the operating profile before architecture: actual users,
   operators, load, exposure, data sensitivity, failure consequence,
   reversibility, compliance, and available time. Never assume Internet scale
   merely because one boundary is public.
2. Start every non-trivial change with an outcome, acceptance criteria,
   invariants, and explicit non-goals. The user owns scope; a reviewer cannot
   silently expand it.
3. Require every new service, database, credential, worker, migration, recovery
   protocol, or abstraction to map to a requirement, existing invariant, or
   observed failure. Otherwise defer it.
4. Review the actual risk surface. Low-risk work gets focused self-review;
   bounded runtime changes get one fresh diff review; high-risk work gets only
   the specialist reviews needed for named risks.
5. A blocker must cite a violated requirement/invariant, evidence, severity,
   and the smallest adequate correction. Ideal-platform suggestions are
   follow-ups, not blockers.
6. For ordinary work, permit at most three verdicts: the initial review, a
   re-review after the first correction pass, and a final re-review after the
   second correction pass. If the third verdict remains `NO-SHIP`, stop and ask
   the user to decide among the unresolved risks, scope changes, or alternatives.
7. Stop and rescope when planning/review approaches likely implementation
   effort, the plan spans more subsystems than the request, or later reviews
   repeatedly add unrelated theoretical cases.
8. Optimize for changeability rather than imagined completeness. Prefer a small
   reversible vertical slice with clear seams; introduce abstractions only for
   known variation or ownership boundaries.
9. Exercise production primitives early when the probe is reversible,
   observable, and has a defined blast radius and rollback. Test the real
   systemd credential shape, service user, deployment environment, and public
   route before adding abstractions around assumed behavior. Use staging when a
   production probe could expose secrets, corrupt data, or create unacceptable
   external effects.
10. Deploy through the permanent owner path. Do not create feature-specific
   rollout orchestration when the repository already owns drain, pull,
   restart, and readiness.

The global agent instructions were updated with the proportional review matrix,
reviewer jurisdiction, minimum-sufficient-architecture rule, and bounded review
loop. This incident preserves the dated evidence; current architecture and
runbooks remain authoritative for live behavior.

## References

- Bounded shipped plan:
  `docs/plans/2026-08-19-pebble-concierge-handoff.md`
- Superseded exploration:
  `docs/archive/2026-08-19-platform-hardening-source-design.md`
- Extracted future work: `docs/future-plans/`
- Capture architecture: `docs/architecture/CAPTURE-INGRESS.md`
- Deployment runbook: `docs/runbooks/DEPLOYMENT.md`
- Relevant commits: `c5cde9c`, `f43d68a`, `33c0319`, `62befb4`, `f0b5ddc`
