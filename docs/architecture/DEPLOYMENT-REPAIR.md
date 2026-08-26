# Trusted-root deployment repair

Slack Concierge is a personal, single-operator service. Its deployment repair
path therefore trusts the same root account and Codex installation already used
for ordinary agent work. There is no project-specific execution tier, alternate
home, credential proxy, filesystem allowlist, or second deployment database.

## Ownership

The existing Concierge SQLite database owns the complete workflow:

- `deployment_runs` remains the single active batch per target. Its ordinary
  status stays `releasing` while repair owns it; nullable `repair_state` records
  `restored`, `repairing`, `reviewing`, `retrying`, or `parked`.
- `deployment_releases` records the Git commit, source archive digest, bundled
  runtime digest, compatibility digest, artifact path, and current
  last-known-good designation.
- `deployment_repair_incidents` records the failed and restored commits, stable
  failure fingerprint, review result, committed repair, and bounded attempts.
- `deployment_repair_agent_runs` records launch intent, supervisor and child
  process identities, explicit Codex session UUID, output paths, and completion.
- `deployment_turn_reactions` records one monotonic per-turn desired/projected
  reaction state and retries Slack delivery without invoking the provider.

The detached deploy runner owns drain, candidate activation, restart, health
proof, rollback, and post-launch incident creation. The bot records the same
incident shape if systemd cannot launch the detached runner. Its transient unit
restarts on process failure, and the bot requeues a dead durable runner. An activation-intent
checkpoint is committed before `current` moves, so either path recognizes an
interrupted candidate and restores LKG on the same run. The root systemd repair
unit owns agent execution, diagnosis, review, Git integration, and retry.
Deployment machinery records evidence and available commit-to-task authorship
mappings but never infers causality or selects a feature task as the culprit.
The same mappings drive a durable Slack reaction projection on each originating
user message; reactions expose rollout state but never start or resume a
provider session.

## Immutable releases

`bot/src/deployment-release.ts` builds releases from committed Git archives, not
from the mutable checkout. Normal releases use one commit for both application
and control provenance. The one-time cutover explicitly combines application
bytes from the proven live commit with control bytes from the reviewed cutover
commit; its manifest records and verifies both commits and both archive digests.
It bundles the bot entrypoint and every deployment,
state, recovery, repair, review, gate, and health command needed to recover the
next candidate. The two Node bridge entrypoints are bundled with their WebSocket
dependency so neither runtime resolves modules from a mutable checkout. It also
copies the stable shell launchers, unit definitions,
route configuration, and runtime helpers. Every file is hashed before the
content-addressed directory is made read-only.

The stable launcher and Bun executable live under
`/usr/local/lib/slack-concierge-deployment`. Content-addressed releases, the
`current` application link, `control` deployment link, incidents, agent logs,
and final messages live under `/var/lib/slack-concierge-deployment`. Candidate
testing advances only `current`; all rollout and repair commands continue from
the verified `control`/LKG artifact. Promotion records the proven LKG in SQLite
before advancing `control`; every restoration reconciles both pointers from
that database authority, including after a crash between those operations.
After promotion, the runner refreshes the installed systemd units and router
action wrapper from that promoted artifact before recording deployment success;
the initial install from prior LKG is not sufficient for either surface.
Ordinary deploy refuses to activate a
candidate until a verified last-known-good release exists.

## Failure and repair sequence

1. The detached runner cannot launch, any durable rollout step fails, a
   candidate restart/functional proof fails, or a runner disappears after
   activation intent was persisted.
2. If candidate activation began, deploy switches `current` back to the
   recorded last-known-good artifact, restarts Concierge, and re-proves capture
   and application health. A pre-launch failure leaves the already-healthy LKG
   runtime unchanged.
3. Admission gates reopen only after that proof. The deployment run remains
   active and receives or updates one repair incident.
4. `concierge-deployment-repair@<incident>.service` runs as root with `HOME=/root`.
   Repair Codex receives full host access, the failure evidence, the
   LKG-to-candidate commit range, and any opaque task-provenance mappings. Those
   mappings establish authorship context only. The same mapped turns change
   from 📦 to 🛠️ without being labeled causal. The agent may inspect journald,
   systemd, credentials, `/root`, and every workspace and owns diagnosis of the
   actual cause. Its prompt forbids deployment, pushing, unrelated edits, and
   shared App Server restart; the supervisor owns those lifecycle effects.
5. A repair launch persists intent and child identity, then binds the explicit
   Codex UUID from JSON events. A dead bound child resumes the same UUID. A dead
   unbound launch parks instead of risking a duplicate session.
6. After a clean repair commit, a new independent Codex session reviews the
   actual diff and emits structured `SHIP` or `NO_SHIP`. A rejected diff returns
   to the same repair session; the fourth rejected revision parks.
7. On `SHIP`, the supervisor fetches `origin/main`, proves the reviewed base is
   unchanged, and performs a non-force push. If origin moved, the same repair
   session rebases and the result receives a new review.
8. The same durable deployment run retries and its mapped turns return to 📦.
   Success records the exact runtime and health proof, replaces their marker
   with 🚀, and invokes no feature agent. The third recurrence of the same
   candidate-health failure parks the incident and replaces 🛠️ with 🛑.

## Recovery invariants

- A live prior child is never duplicated.
- A bound dead child resumes by explicit UUID; `--last` is never used.
- An unbound ambiguous launch never starts another agent.
- Already committed work, an already recorded review, and an already pushed
  commit are safe restart boundaries.
- Candidate and restored commits remain separate evidence. Recurrence hashes
  stable failure class, stage, and exit evidence across repair commits; a
  materially different failure resets the counter.
- Startup recovery runs from the immutable control artifact before the bot. It
  restores LKG for a dead post-activation runner, then the healthy LKG bot
  relaunches the persisted repair incident.
- A dead retry owner before activation is requeued on the same run. A dead retry
  owner after activation restores both application and control pointers before
  the same incident continues.
- Git integration is non-force and conditional on the reviewed base.
- The shared managed Codex App Server is a dependency, not a deployment target.
  Repair uses the installed CLI but never installs Codex or restarts that daemon.
- Parking is terminal and visible; systemd does not endlessly restart a parked
  incident.

The focused executable specifications are
`bot/tests/deployment-repair-trusted-root.test.ts`,
`bot/tests/deployment-state.test.ts`, and `bot/tests/deploy.test.ts`.
