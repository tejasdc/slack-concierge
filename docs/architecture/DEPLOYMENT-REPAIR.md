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

The detached deploy runner owns drain, candidate activation, restart, health
proof, rollback, and incident creation. Its transient unit restarts on process
failure, and the bot requeues a dead durable runner. An activation-intent
checkpoint is committed before `current` moves, so either path recognizes an
interrupted candidate and restores LKG on the same run. The root systemd repair
unit owns agent execution, review, Git integration, and retry.

## Immutable releases

`bot/src/deployment-release.ts` builds a release from `git archive <commit>`, not
from the mutable checkout. It bundles the bot entrypoint and every deployment,
state, recovery, repair, review, gate, and health command needed to recover the
next candidate. It also copies the stable shell launchers, unit definitions,
route configuration, and runtime helpers. Every file is hashed before the
content-addressed directory is made read-only.

The stable launcher and Bun executable live under
`/usr/local/lib/slack-concierge-deployment`. Content-addressed releases, the
`current` application link, `control` deployment link, incidents, agent logs,
and final messages live under `/var/lib/slack-concierge-deployment`. Candidate
testing advances only `current`; all rollout and repair commands continue from
the verified `control`/LKG artifact. `control` advances only after capture
health, Slack/Codex health, exact Git SHA, and unchanged systemd invocation are
proven and the candidate is promoted. Ordinary deploy refuses to activate a
candidate until a verified last-known-good release exists.

## Failure and repair sequence

1. Any durable rollout step fails, a candidate restart/functional proof fails,
   or a runner disappears after activation intent was persisted.
2. Deploy switches `current` back to the recorded last-known-good artifact,
   restarts Concierge, and re-proves capture and application health.
3. Admission gates reopen only after that proof. The deployment run remains
   active and receives or updates one repair incident.
4. `concierge-deployment-repair@<incident>.service` runs as root with `HOME=/root`.
   Repair Codex receives full host access and may inspect journald, systemd,
   credentials, `/root`, and every workspace. Its prompt forbids deployment,
   pushing, unrelated edits, and shared App Server restart; the supervisor owns
   those lifecycle effects.
5. A repair launch persists intent and child identity, then binds the explicit
   Codex UUID from JSON events. A dead bound child resumes the same UUID. A dead
   unbound launch parks instead of risking a duplicate session.
6. After a clean repair commit, a new independent Codex session reviews the
   actual diff and emits structured `SHIP` or `NO_SHIP`. A rejected diff returns
   to the same repair session; the fourth rejected revision parks.
7. On `SHIP`, the supervisor fetches `origin/main`, proves the reviewed base is
   unchanged, and performs a non-force push. If origin moved, the same repair
   session rebases and the result receives a new review.
8. The same durable deployment run retries. Success settles the original
   requests and creates exact provider-session/Slack-thread verification wakes.
   The third recurrence of the same candidate-health failure parks and emits one
   actionable notice.

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
- Git integration is non-force and conditional on the reviewed base.
- The shared managed Codex App Server is a dependency, not a deployment target.
  Repair uses the installed CLI but never installs Codex or restarts that daemon.
- Parking is terminal and visible; systemd does not endlessly restart a parked
  incident.

The focused executable specifications are
`bot/tests/deployment-repair-trusted-root.test.ts`,
`bot/tests/deployment-state.test.ts`, and `bot/tests/deploy.test.ts`.
