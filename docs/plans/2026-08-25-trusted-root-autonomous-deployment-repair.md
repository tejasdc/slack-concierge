---
title: "Trusted-root autonomous deployment repair"
type: refactor
status: approved
date: 2026-08-25
owner: operator
---

# Trusted-root autonomous deployment repair

## Outcome

Keep deployment self-repair as a first-class Concierge capability, but implement
it for the machine that actually exists: one trusted operator, one personal
server, and agents that already have root access. A failed deployment restores
the last-known-good Concierge runtime, launches a root-trusted Codex repair
session, obtains a fresh review, integrates the reviewed repair, retries the
deployment, and wakes the exact requesting tasks after verified success.

This replaces the unactivated hostile-worker threat model. The repair agent is
trusted to inspect and change the whole server. Correctness gates remain;
security theater does not.

## Keep

- durable deployment batching and exact requesting session/thread mappings;
- the detached systemd deployment runner and active-turn/capture admission
  gates;
- immutable application-and-control releases and automatic last-known-good restoration;
- durable repair incident state in the existing Concierge SQLite database,
  writable by the detached root supervisor while Concierge is stopped;
- one resumable repair session per incident, a fresh review of the actual diff,
  non-force integration onto unchanged `origin/main`, and bounded parking when
  the failure does not change;
- functional capture and Concierge health checks, exact runtime/invocation
  proof, deterministic incident notices, and exact post-deploy wakes;
- the existing shared Codex App Server lifecycle. Repair uses the installed
  Codex CLI and never updates or restarts the managed App Server.

## Remove

- application containment and the non-root Concierge cutover;
- per-project broker/worker services, sockets, dynamic users, authority files,
  alternate provider homes, copied sessions, HMAC bindings, stable workspace
  aliases, and project filesystem namespaces;
- Bubblewrap/no-network repair and review sandboxes, credential mediation, and
  evidence redaction. Repair and review run as root with the normal `/root`
  environment and may inspect every project and host diagnostic surface;
- root-kernel versus non-root coordinator privilege separation, role sockets,
  A/B coordinator activation, canary generations, synthetic incidents, rollout
  leases, protected-source/Codex promotion approval gates, and executable
  identity attestations that existed to defend principals from one another;
- activation flags, containment rollout units, tests, and active documentation
  for the retired threat model.

## Runtime model

1. The existing Concierge SQLite database is the single deployment lifecycle
   owner. The existing constrained `deployment_runs.status` values and parent
   table remain unchanged. An additive nullable `repair_state` column plus
   subordinate repair/session/review rows records `restored`, `repairing`,
   `reviewing`, `retrying`, or `parked`. While repair owns a run, its existing
   status remains `releasing` (therefore active and coalescing) and its runner
   identity is transferred to the live repair supervisor. This is readable by
   the old rollback binary and avoids rebuilding the live foreign-key parent.
   There is no second intent or handoff database. Only terminal parking changes
   the run and its still-pending requests to failed and creates one notice.
2. Each release contains the application plus the deployment, recovery, repair,
   review, gate, and health commands needed for the next rollout. Candidate
   testing advances only the `current` application pointer; those commands run
   from the separate immutable `control`/LKG pointer until successful promotion.
   Activation intent is durable before `current` moves. A dead transient runner
   restarts or is requeued, and a dead post-activation runner restores LKG and
   enters repair on the same run.
3. If candidate health fails, the deploy runner atomically restores the prior
   immutable release and re-proves capture and Concierge health before reopening
   admission.
4. The runner records or updates one incident in that same database and starts
   `concierge-deployment-repair@<incident>.service`. Dead-run reconciliation
   treats supervisor-owned repair states as live workflow, never as a failed
   deployment, and new requests coalesce behind that one active target run.
5. The repair service runs as root in an incident Git worktree based on the
   failed target. Before spawning Codex it persists `launch_intended` plus the
   repair unit/process identity; after the first CLI event it binds the explicit
   session UUID. A restart resumes only a bound session after proving the prior
   child dead. An unbound `launch_intended` crash is parked and notified as
   ambiguous rather than creating a second session.
6. The repair agent may diagnose the live host and edit/test/commit the repair,
   but the supervisor—not the prompt—owns integration. A fresh independent
   review also runs as trusted root with full host visibility, is instructed not
   to mutate the repair, and returns structured `SHIP` or `NO_SHIP` for the actual committed diff. Review
   uses the same minimal `launch_intended` / child identity / `session_bound`
   admission states and parks an unbound crash.
7. On `SHIP`, the supervisor proves `origin/main` still equals the reviewed base
   and performs a non-force push. Origin movement returns the same repair
   session to correction and requires a new review.
8. The supervisor retries the same durable deployment run. Success settles the
   original requests and creates their exact verification wakes. A changed
   failure resumes repair; the same unchanged failure three times parks the
   incident and emits one actionable notice.
9. On supervisor restart, persisted state determines the next action. A live
   child remains in the same systemd cgroup; a dead child is resumed from the
   recorded session rather than silently treated as success.

## Runtime cutover

Before the canonical checkout advances, and only inside an explicitly
operator-authorized restart boundary after both admission gates prove idle, the
existing release manager must rehash and activate the `f2b0550` artifact while
the checkout is still unchanged. It must then prove the stable pointer and
manifest, a fresh invocation reporting `f2b0550`, capture health, application
health, and unchanged managed App Server identity before promoting the artifact
as the initial immutable last-known-good release. If activation or any proof
fails, it restores the canonical-checkout fallback, re-proves that runtime, and
aborts before advancing Git.

Before that restart, an idempotent pre-cutover migration makes a consistent
SQLite backup, adds only the nullable repair columns and new child tables,
copies no parent rows, and runs `foreign_key_check` and `integrity_check`. Any
failure rolls the schema transaction back on the same live database inode; the
untouched backup remains available without swapping files under the old process.
The migration is replay-safe and a focused fixture proves all 12 live-style
runs, 70 events, 16 requests, 3 wakes, and 12 notices remain byte-for-byte
equivalent outside the new nullable columns/tables.

The source change installs a separate retained runtime root at
`/usr/local/lib/slack-concierge-deployment`, a separate release root at
`/var/lib/slack-concierge-deployment`, the trusted-root repair unit, and its
direct application launcher while the current root Concierge runtime remains
active. It copies or rebuilds the exact proven last-known-good artifact into the
new release root, verifies its manifest and bytes, records it as the initial
last-known-good release in the single application database, switches
`concierge-bot.service` to the new launcher, and re-proves the same runtime and
managed App Server identity.

Only then are these exact retired surfaces stopped and moved to a dated
recoverable backup: the kernel/coordinator/provider-adapter/rollout/broker/worker
units and drop-ins; `/usr/local/lib/concierge-deployment`; containment-only
subtrees under `/var/lib/concierge-deployment`; and the generated
`/var/lib/concierge-provider*`, `/var/lib/concierge-workspace`, and matching
`/var/lib/private/concierge-provider*` trees. The verified release artifacts
already copied to `/var/lib/slack-concierge-deployment` are retained.

With every old unit and runtime path unavailable, the acceptance fixture then
exercises normal restart, failed-candidate restoration, root-trusted
repair/review/retry, exact wakes, and unchanged App Server identity. Concierge,
capture, project, Git, provider-session, Slack, and App Server state are not
deleted or reset.

## Acceptance criteria

1. A focused fixture causes a candidate deployment to fail health, proves the
   previous release is healthy again, runs a root-trusted repair and fresh
   review, integrates the repair, retries, and settles the original deployment
   request only after verified success.
2. A focused crash-window fixture proves that a bound repair session resumes
   only after its prior child is dead, while an unbound repair or review launch
   parks without starting a second session.
3. A production-shaped migration fixture proves the additive repair schema is
   idempotent, preserves every deployment run/event/request/wake/notice row,
   passes both SQLite integrity checks, and rolls back on the same database
   inode on forced failure while retaining its backup.
4. Repair and review can read `/root`, the canonical repository, all project
   workspaces, journald, systemd, and the normal Codex configuration without
   bind mounts, copied homes, brokers, adapters, project allowlists, or namespace
   setup.
5. No source, checked-in unit, environment switch, test, or active documentation
   references application containment or per-project provider broker/worker
   execution.
6. Ordinary successful deployments retain batching, drain, capture gating,
   frozen dependencies, last-known-good releases, functional health, exact
   runtime proof, notices, and exact wakes.
7. The shared managed Codex App Server PID and installation are unchanged by
   repair activation and deployment.
8. No live registry mapping for `/root/workspace/inbox` exists; `slack-inbox`
   remains the real project.

## Non-goals

- defending the operator's agents from the operator's own machine or secrets;
- multi-tenant isolation, least-privilege credentials, compliance, or hostile
  repair/review workers;
- automatic Codex installation or App Server updates;
- changing Slack, Canvas, capture, provider-turn, or project behavior outside
  deployment repair.
