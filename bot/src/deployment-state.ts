import { randomUUID } from "node:crypto";
import { db, type ProviderId, type SessionRow } from "./state";
import { isProcessIdentityAlive } from "./runtime-identity";

export type DeploymentRunStatus =
  | "prepared"
  | "draining"
  | "updating"
  | "restarting"
  | "verifying"
  | "releasing"
  | "succeeded"
  | "failed"
  | "ambiguous";

export type DeploymentRepairState = "restored" | "repairing" | "reviewing" | "retrying" | "parked";

export interface DeploymentRunRow {
  id: string;
  target: string;
  unit_name: string;
  status: DeploymentRunStatus;
  repair_state: DeploymentRepairState | null;
  candidate_artifact_digest: string | null;
  candidate_commit: string | null;
  desired_commit: string | null;
  activation_state: "intended" | "active" | null;
  runner_pid: number | null;
  runner_boot_id: string | null;
  runner_start_ticks: string | null;
  deployed_commit: string | null;
  service_invocation_id: string | null;
  evidence_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface DeploymentReleaseRow {
  artifact_digest: string;
  run_id: string;
  git_commit: string;
  source_tree_digest: string;
  runtime_digest: string;
  compatibility_digest: string;
  artifact_path: string;
  state: "prepared" | "active" | "lkg" | "retired" | "failed";
  created_at: string;
  activated_at: string | null;
  promoted_at: string | null;
}

export interface DeploymentRepairIncidentRow {
  id: string;
  run_id: string;
  status: DeploymentRepairState | "completed";
  failed_commit: string;
  restored_commit: string;
  failure_fingerprint: string;
  same_failure_count: number;
  worktree_path: string | null;
  branch_name: string | null;
  base_commit: string;
  repair_commit: string | null;
  review_verdict: "SHIP" | "NO_SHIP" | null;
  review_json: string | null;
  review_attempts: number;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface DeploymentRepairAgentRunRow {
  id: string;
  incident_id: string;
  kind: "repair" | "review";
  launch_state: "launch_intended" | "session_bound" | "completed" | "parked";
  supervisor_pid: number;
  supervisor_boot_id: string;
  supervisor_start_ticks: string;
  child_pid: number | null;
  child_boot_id: string | null;
  child_start_ticks: string | null;
  session_uuid: string | null;
  output_path: string;
  result_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface DeploymentRequestRow {
  id: string;
  run_id: string;
  source_turn_id: number;
  source_session_id: number;
  expected_commit: string;
  slack_channel_id: string;
  slack_thread_ts: string;
  requested_by_user_id: string | null;
  provider_id: ProviderId;
  provider_model: string | null;
  reasoning_effort: string | null;
  provider_session_uuid: string;
  status: "pending" | "included" | "not_included" | "failed";
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeploymentWakeRow {
  id: string;
  run_id: string;
  session_id: number;
  slack_channel_id: string;
  slack_thread_ts: string;
  requested_by_user_id: string | null;
  provider_id: ProviderId;
  provider_model: string | null;
  reasoning_effort: string | null;
  provider_session_uuid: string;
  control_handoff_id: string | null;
  prompt: string;
  status: "pending" | "running" | "delivered" | "parked";
  owner_instance_id: string | null;
  turn_id: number | null;
  provider_admission_intended_at: string | null;
  attempts: number;
  next_attempt_ms: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeploymentNoticeRow {
  id: string;
  run_id: string;
  session_id: number;
  slack_channel_id: string;
  slack_thread_ts: string;
  requested_by_user_id: string | null;
  kind: "deploy_failed" | "commit_not_included" | "wake_parked";
  text: string;
  client_msg_id: string;
  status: "pending" | "sending" | "delivered" | "parked";
  owner_instance_id: string | null;
  attempts: number;
  next_attempt_ms: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export type DeploymentTurnReactionState = "deploying" | "repairing" | "deployed" | "parked";

export interface DeploymentTurnReactionTarget {
  turnId: number;
  slackChannelId: string;
  slackUserMessageTs: string;
}

export interface DeploymentTurnReactionRow {
  turn_id: number;
  run_id: string;
  slack_channel_id: string;
  slack_user_msg_ts: string;
  desired_state: DeploymentTurnReactionState;
  projected_state: DeploymentTurnReactionState | null;
  desired_revision: number;
  projected_revision: number;
  projection_status: "pending" | "sending" | "delivered" | "parked";
  projection_attempts: number;
  projection_next_attempt_ms: number | null;
  projection_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeploymentFailureDiagnostics {
  stage?: string;
  failed_command?: string;
  failure_line?: number;
  exit_status?: number;
  command_output?: string;
  run_status?: string;
  repair_state?: string;
}

export interface DeploymentFailureOptions {
  diagnostics?: DeploymentFailureDiagnostics;
  noticeReason?: string;
}

export interface ClaimedDeploymentWake {
  wake: DeploymentWakeRow;
  turnId: number;
  session: SessionRow;
}

const ACTIVE_RUN_STATUSES: DeploymentRunStatus[] = [
  "prepared",
  "draining",
  "updating",
  "restarting",
  "verifying",
  "releasing",
];

const PHASE_ORDER: DeploymentRunStatus[] = [
  "prepared",
  "draining",
  "updating",
  "restarting",
  "verifying",
  "releasing",
];

db.exec(`
CREATE TABLE IF NOT EXISTS deployment_runs (
  id                    TEXT PRIMARY KEY,
  target                TEXT NOT NULL,
  unit_name             TEXT NOT NULL UNIQUE,
  status                TEXT NOT NULL CHECK(status IN ('prepared', 'draining', 'updating', 'restarting', 'verifying', 'releasing', 'succeeded', 'failed', 'ambiguous')),
  runner_pid            INTEGER,
  runner_boot_id        TEXT,
  runner_start_ticks    TEXT,
  deployed_commit       TEXT,
  service_invocation_id TEXT,
  evidence_json         TEXT,
  error                 TEXT,
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at          DATETIME
);

CREATE UNIQUE INDEX IF NOT EXISTS deployment_runs_one_active_target
ON deployment_runs(target)
WHERE status IN ('prepared', 'draining', 'updating', 'restarting', 'verifying', 'releasing');

CREATE TABLE IF NOT EXISTS deployment_run_events (
  sequence       INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id         TEXT NOT NULL REFERENCES deployment_runs(id) ON DELETE CASCADE,
  event          TEXT NOT NULL,
  detail_json    TEXT NOT NULL DEFAULT '{}',
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS deployment_requests (
  id                       TEXT PRIMARY KEY,
  run_id                   TEXT NOT NULL REFERENCES deployment_runs(id),
  source_turn_id           INTEGER NOT NULL REFERENCES turns(id),
  source_session_id        INTEGER NOT NULL REFERENCES sessions(id),
  expected_commit          TEXT NOT NULL,
  slack_channel_id         TEXT NOT NULL,
  slack_thread_ts          TEXT NOT NULL,
  requested_by_user_id     TEXT,
  provider_id              TEXT NOT NULL CHECK(provider_id IN ('codex', 'claude-code')),
  provider_model           TEXT,
  reasoning_effort         TEXT,
  provider_session_uuid    TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'included', 'not_included', 'failed')),
  error                    TEXT,
  created_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source_turn_id, expected_commit)
);

CREATE TABLE IF NOT EXISTS deployment_wakes (
  id                              TEXT PRIMARY KEY,
  run_id                          TEXT NOT NULL REFERENCES deployment_runs(id),
  session_id                      INTEGER NOT NULL REFERENCES sessions(id),
  slack_channel_id                TEXT NOT NULL,
  slack_thread_ts                 TEXT NOT NULL,
  requested_by_user_id            TEXT,
  provider_id                     TEXT NOT NULL CHECK(provider_id IN ('codex', 'claude-code')),
  provider_model                  TEXT,
  reasoning_effort                TEXT,
  provider_session_uuid           TEXT NOT NULL,
  control_handoff_id              TEXT,
  prompt                          TEXT NOT NULL,
  status                          TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'delivered', 'parked')),
  owner_instance_id               TEXT,
  turn_id                         INTEGER REFERENCES turns(id),
  provider_admission_intended_at  DATETIME,
  attempts                        INTEGER NOT NULL DEFAULT 0,
  next_attempt_ms                 INTEGER,
  error                           TEXT,
  created_at                      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(run_id, session_id, slack_channel_id, slack_thread_ts)
);

CREATE TABLE IF NOT EXISTS deployment_notices (
  id                    TEXT PRIMARY KEY,
  run_id                TEXT NOT NULL REFERENCES deployment_runs(id),
  session_id            INTEGER NOT NULL REFERENCES sessions(id),
  slack_channel_id      TEXT NOT NULL,
  slack_thread_ts       TEXT NOT NULL,
  requested_by_user_id  TEXT,
  kind                  TEXT NOT NULL CHECK(kind IN ('deploy_failed', 'commit_not_included', 'wake_parked')),
  text                  TEXT NOT NULL,
  client_msg_id         TEXT NOT NULL UNIQUE,
  status                TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'sending', 'delivered', 'parked')),
  owner_instance_id     TEXT,
  attempts              INTEGER NOT NULL DEFAULT 0,
  next_attempt_ms       INTEGER,
  error                 TEXT,
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(run_id, session_id, slack_channel_id, slack_thread_ts, kind)
);

CREATE TABLE IF NOT EXISTS deployment_turn_reactions (
  turn_id                    INTEGER PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
  run_id                     TEXT NOT NULL REFERENCES deployment_runs(id) ON DELETE CASCADE,
  slack_channel_id           TEXT NOT NULL,
  slack_user_msg_ts          TEXT NOT NULL,
  desired_state              TEXT NOT NULL CHECK(desired_state IN ('deploying', 'repairing', 'deployed', 'parked')),
  projected_state            TEXT CHECK(projected_state IS NULL OR projected_state IN ('deploying', 'repairing', 'deployed', 'parked')),
  desired_revision           INTEGER NOT NULL DEFAULT 1,
  projected_revision         INTEGER NOT NULL DEFAULT 0,
  projection_status          TEXT NOT NULL DEFAULT 'pending' CHECK(projection_status IN ('pending', 'sending', 'delivered', 'parked')),
  projection_attempts        INTEGER NOT NULL DEFAULT 0,
  projection_next_attempt_ms INTEGER,
  projection_error           TEXT,
  created_at                 DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                 DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS deployment_releases (
  artifact_digest      TEXT PRIMARY KEY,
  run_id               TEXT NOT NULL REFERENCES deployment_runs(id),
  git_commit           TEXT NOT NULL,
  source_tree_digest   TEXT NOT NULL,
  runtime_digest       TEXT NOT NULL,
  compatibility_digest TEXT NOT NULL,
  artifact_path        TEXT NOT NULL UNIQUE,
  state                TEXT NOT NULL CHECK(state IN ('prepared', 'active', 'lkg', 'retired', 'failed')),
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  activated_at         DATETIME,
  promoted_at          DATETIME
);

CREATE UNIQUE INDEX IF NOT EXISTS deployment_releases_one_lkg
ON deployment_releases(state) WHERE state='lkg';

CREATE TABLE IF NOT EXISTS deployment_repair_incidents (
  id                   TEXT PRIMARY KEY,
  run_id               TEXT NOT NULL UNIQUE REFERENCES deployment_runs(id) ON DELETE CASCADE,
  status               TEXT NOT NULL CHECK(status IN ('restored', 'repairing', 'reviewing', 'retrying', 'parked', 'completed')),
  failed_commit        TEXT NOT NULL,
  restored_commit      TEXT NOT NULL,
  failure_fingerprint  TEXT NOT NULL,
  same_failure_count   INTEGER NOT NULL DEFAULT 1,
  worktree_path        TEXT,
  branch_name          TEXT,
  base_commit          TEXT NOT NULL,
  repair_commit        TEXT,
  review_verdict       TEXT CHECK(review_verdict IS NULL OR review_verdict IN ('SHIP', 'NO_SHIP')),
  review_json          TEXT,
  review_attempts      INTEGER NOT NULL DEFAULT 0,
  error                TEXT,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at         DATETIME
);

CREATE TABLE IF NOT EXISTS deployment_repair_agent_runs (
  id                     TEXT PRIMARY KEY,
  incident_id            TEXT NOT NULL REFERENCES deployment_repair_incidents(id) ON DELETE CASCADE,
  kind                   TEXT NOT NULL CHECK(kind IN ('repair', 'review')),
  launch_state           TEXT NOT NULL CHECK(launch_state IN ('launch_intended', 'session_bound', 'completed', 'parked')),
  supervisor_pid         INTEGER NOT NULL,
  supervisor_boot_id     TEXT NOT NULL,
  supervisor_start_ticks TEXT NOT NULL,
  child_pid              INTEGER,
  child_boot_id          TEXT,
  child_start_ticks      TEXT,
  session_uuid           TEXT,
  output_path            TEXT NOT NULL,
  result_json            TEXT,
  error                  TEXT,
  created_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at           DATETIME
);
`);

const deploymentRunColumns = new Set(
  (db.query("PRAGMA table_info(deployment_runs)").all() as Array<{ name: string }>).map((column) => column.name),
);
if (!deploymentRunColumns.has("repair_state")) {
  db.exec(`ALTER TABLE deployment_runs ADD COLUMN repair_state TEXT
    CHECK(repair_state IS NULL OR repair_state IN ('restored', 'repairing', 'reviewing', 'retrying', 'parked'))`);
}
if (!deploymentRunColumns.has("candidate_artifact_digest")) {
  db.exec("ALTER TABLE deployment_runs ADD COLUMN candidate_artifact_digest TEXT");
}
if (!deploymentRunColumns.has("candidate_commit")) {
  db.exec("ALTER TABLE deployment_runs ADD COLUMN candidate_commit TEXT");
}
if (!deploymentRunColumns.has("desired_commit")) {
  db.exec("ALTER TABLE deployment_runs ADD COLUMN desired_commit TEXT");
}
if (!deploymentRunColumns.has("activation_state")) {
  db.exec(`ALTER TABLE deployment_runs ADD COLUMN activation_state TEXT
    CHECK(activation_state IS NULL OR activation_state IN ('intended', 'active'))`);
}

const deploymentRepairIncidentColumns = new Set(
  (db.query("PRAGMA table_info(deployment_repair_incidents)").all() as Array<{ name: string }>).map((column) => column.name),
);
if (!deploymentRepairIncidentColumns.has("review_attempts")) {
  db.exec("ALTER TABLE deployment_repair_incidents ADD COLUMN review_attempts INTEGER NOT NULL DEFAULT 0");
}

const deploymentWakeColumns = new Set(
  (db.query("PRAGMA table_info(deployment_wakes)").all() as Array<{ name: string }>).map((column) => column.name),
);
if (!deploymentWakeColumns.has("control_handoff_id")) {
  db.exec("ALTER TABLE deployment_wakes ADD COLUMN control_handoff_id TEXT");
}
db.query(`UPDATE deployment_wakes
  SET status='parked', owner_instance_id=NULL, next_attempt_ms=NULL,
      error='Post-deployment verification wakes were retired; successful deployments no longer invoke feature agents.',
      updated_at=CURRENT_TIMESTAMP
  WHERE status IN ('pending', 'running')`).run();

function appendRunEvent(runId: string, event: string, detail: Record<string, unknown> = {}) {
  db.query(`INSERT INTO deployment_run_events (run_id, event, detail_json) VALUES (?, ?, ?)`)
    .run(runId, event, JSON.stringify(detail));
}

function requestDeploymentTurnReactionStateInTransaction(
  runId: string,
  state: DeploymentTurnReactionState,
) {
  const changed = db.query(`UPDATE deployment_turn_reactions
    SET desired_state=?, desired_revision=desired_revision+1,
        projection_status='pending', projection_attempts=0,
        projection_next_attempt_ms=0, projection_error=NULL,
        updated_at=CURRENT_TIMESTAMP
    WHERE run_id=? AND desired_state<>'deployed' AND desired_state<>?`)
    .run(state, runId, state).changes;
  if (changed > 0) appendRunEvent(runId, "deployment_turn_reactions_requested", { state, count: changed });
  return changed;
}

export function registerDeploymentTurnReactionTargets(
  runId: string,
  targets: DeploymentTurnReactionTarget[],
  state: DeploymentTurnReactionState = "deploying",
): number {
  return db.transaction(() => {
    if (!getDeploymentRun(runId)) throw new Error(`Unknown deployment run ${runId}.`);
    let changed = 0;
    for (const target of targets) {
      const existing = getDeploymentTurnReaction(target.turnId);
      if (existing?.desired_state === "deployed") continue;
      if (!existing) {
        db.query(`INSERT INTO deployment_turn_reactions (
          turn_id, run_id, slack_channel_id, slack_user_msg_ts, desired_state,
          projection_status, projection_next_attempt_ms
        ) VALUES (?, ?, ?, ?, ?, 'pending', 0)`)
          .run(target.turnId, runId, target.slackChannelId, target.slackUserMessageTs, state);
        changed += 1;
        continue;
      }
      const updated = db.query(`UPDATE deployment_turn_reactions
        SET run_id=?, slack_channel_id=?, slack_user_msg_ts=?, desired_state=?,
            desired_revision=desired_revision+1, projection_status='pending',
            projection_attempts=0, projection_next_attempt_ms=0,
            projection_error=NULL, updated_at=CURRENT_TIMESTAMP
        WHERE turn_id=? AND desired_state<>'deployed'
          AND (run_id<>? OR desired_state<>?)`)
        .run(
          runId,
          target.slackChannelId,
          target.slackUserMessageTs,
          state,
          target.turnId,
          runId,
          state,
        );
      changed += updated.changes;
    }
    if (changed > 0) appendRunEvent(runId, "deployment_turn_reactions_requested", { state, count: changed });
    return changed;
  })();
}

export function recordDeploymentTurnReactionDiscoveryFailure(runId: string, error: string) {
  appendRunEvent(runId, "deployment_turn_reaction_discovery_failed", { error });
}

export function getDeploymentTurnReaction(turnId: number): DeploymentTurnReactionRow | null {
  return db.query("SELECT * FROM deployment_turn_reactions WHERE turn_id=?")
    .get(turnId) as DeploymentTurnReactionRow | null;
}

export function listPendingDeploymentTurnReactions(): DeploymentTurnReactionRow[] {
  return db.query(`SELECT * FROM deployment_turn_reactions
    WHERE projection_status='pending' ORDER BY updated_at, turn_id`)
    .all() as DeploymentTurnReactionRow[];
}

export function claimDeploymentTurnReaction(
  turnId: number,
  nowMs = Date.now(),
): DeploymentTurnReactionRow | null {
  const claimed = db.query(`UPDATE deployment_turn_reactions
    SET projection_status='sending', projection_attempts=projection_attempts+1,
        updated_at=CURRENT_TIMESTAMP
    WHERE turn_id=? AND projection_status='pending'
      AND COALESCE(projection_next_attempt_ms, 0)<=?`)
    .run(turnId, nowMs);
  return claimed.changes === 1 ? getDeploymentTurnReaction(turnId) : null;
}

export function markDeploymentTurnReactionDelivered(
  turnId: number,
  projectedRevision: number,
  projectedState: DeploymentTurnReactionState,
) {
  const delivered = db.query(`UPDATE deployment_turn_reactions
    SET projected_state=?, projected_revision=?,
        projection_status=CASE WHEN desired_revision=? THEN 'delivered' ELSE 'pending' END,
        projection_attempts=CASE WHEN desired_revision=? THEN projection_attempts ELSE 0 END,
        projection_next_attempt_ms=CASE WHEN desired_revision=? THEN NULL ELSE 0 END,
        projection_error=NULL, updated_at=CURRENT_TIMESTAMP
    WHERE turn_id=? AND projection_status='sending'`)
    .run(
      projectedState,
      projectedRevision,
      projectedRevision,
      projectedRevision,
      projectedRevision,
      turnId,
    );
  if (delivered.changes !== 1) throw new Error("Deployment reaction projection was not sending.");
}

export function markDeploymentTurnReactionRetry(
  turnId: number,
  desiredRevision: number,
  error: string,
  nextAttemptMs: number,
) {
  const retried = db.query(`UPDATE deployment_turn_reactions
    SET projection_status='pending',
        projection_attempts=CASE WHEN desired_revision=? THEN projection_attempts ELSE 0 END,
        projection_error=CASE WHEN desired_revision=? THEN ? ELSE NULL END,
        projection_next_attempt_ms=CASE WHEN desired_revision=? THEN ? ELSE 0 END,
        updated_at=CURRENT_TIMESTAMP
    WHERE turn_id=? AND projection_status='sending'`)
    .run(desiredRevision, desiredRevision, error, desiredRevision, nextAttemptMs, turnId);
  if (retried.changes !== 1) throw new Error("Deployment reaction projection lost its sending lease.");
}

export function parkDeploymentTurnReaction(turnId: number, desiredRevision: number, error: string) {
  const parked = db.query(`UPDATE deployment_turn_reactions
    SET projection_status=CASE WHEN desired_revision=? THEN 'parked' ELSE 'pending' END,
        projection_attempts=CASE WHEN desired_revision=? THEN projection_attempts ELSE 0 END,
        projection_error=CASE WHEN desired_revision=? THEN ? ELSE NULL END,
        projection_next_attempt_ms=CASE WHEN desired_revision=? THEN NULL ELSE 0 END,
        updated_at=CURRENT_TIMESTAMP
    WHERE turn_id=? AND projection_status='sending'`)
    .run(desiredRevision, desiredRevision, desiredRevision, error, desiredRevision, turnId);
  if (parked.changes !== 1) throw new Error("Deployment reaction projection could not be parked.");
}

export function recoverDeploymentTurnReactionClaims(): number {
  return db.query(`UPDATE deployment_turn_reactions
    SET projection_status='pending', projection_next_attempt_ms=0,
        projection_error=COALESCE(projection_error, 'Reaction projection interrupted before completion.'),
        updated_at=CURRENT_TIMESTAMP
    WHERE projection_status='sending'`).run().changes;
}

function getActiveDeploymentRun(target: string): DeploymentRunRow | null {
  return db.query(`
    SELECT * FROM deployment_runs
    WHERE target=? AND status IN ('prepared', 'draining', 'updating', 'restarting', 'verifying', 'releasing')
    ORDER BY created_at, id LIMIT 1
  `).get(target) as DeploymentRunRow | null;
}

export function getDeploymentRun(runId: string): DeploymentRunRow | null {
  return db.query("SELECT * FROM deployment_runs WHERE id=?").get(runId) as DeploymentRunRow | null;
}

export function wakeDeploymentRunnerWaitingForIdle(): boolean {
  const run = db.query(`
    SELECT runner_pid, runner_boot_id, runner_start_ticks
    FROM deployment_runs
    WHERE status='draining' AND runner_pid IS NOT NULL
    ORDER BY created_at, id LIMIT 1
  `).get() as {
    runner_pid: number;
    runner_boot_id: string;
    runner_start_ticks: string;
  } | null;
  if (!run || !isProcessIdentityAlive({
    pid: run.runner_pid,
    bootId: run.runner_boot_id,
    startTicks: run.runner_start_ticks,
  })) return false;
  try {
    process.kill(run.runner_pid, "SIGUSR1");
    return true;
  } catch {
    return false;
  }
}

export function listDeploymentRunEvents(runId: string): Array<{
  sequence: number;
  event: string;
  detail_json: string;
  created_at: string;
}> {
  return db.query(`SELECT sequence, event, detail_json, created_at
                   FROM deployment_run_events WHERE run_id=? ORDER BY sequence`)
    .all(runId) as any[];
}

export function listDeploymentRequests(runId: string): DeploymentRequestRow[] {
  return db.query("SELECT * FROM deployment_requests WHERE run_id=? ORDER BY created_at, id")
    .all(runId) as DeploymentRequestRow[];
}

export function recordDeploymentReleasePrepared(
  runId: string,
  artifactPath: string,
  manifest: {
    artifact_digest: string;
    git_commit: string;
    source_tree_digest: string;
    runtime_digest: string;
    compatibility_digest: string;
  },
) {
  assertCommit(manifest.git_commit);
  for (const digest of [
    manifest.artifact_digest,
    manifest.source_tree_digest,
    manifest.runtime_digest,
    manifest.compatibility_digest,
  ]) {
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("Release provenance contains an invalid digest.");
  }
  db.query(`INSERT INTO deployment_releases (
      artifact_digest, run_id, git_commit, source_tree_digest, runtime_digest,
      compatibility_digest, artifact_path, state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared')
    ON CONFLICT(artifact_digest) DO UPDATE SET
      run_id=excluded.run_id,
      artifact_path=excluded.artifact_path
  `).run(
    manifest.artifact_digest,
    runId,
    manifest.git_commit,
    manifest.source_tree_digest,
    manifest.runtime_digest,
    manifest.compatibility_digest,
    artifactPath,
  );
  appendRunEvent(runId, "release_prepared", {
    artifact_digest: manifest.artifact_digest,
    git_commit: manifest.git_commit,
  });
  return getDeploymentRelease(manifest.artifact_digest)!;
}

export function getDeploymentRelease(artifactDigest: string): DeploymentReleaseRow | null {
  return db.query("SELECT * FROM deployment_releases WHERE artifact_digest=?")
    .get(artifactDigest) as DeploymentReleaseRow | null;
}

export function getLastKnownGoodRelease(): DeploymentReleaseRow | null {
  return db.query("SELECT * FROM deployment_releases WHERE state='lkg' LIMIT 1")
    .get() as DeploymentReleaseRow | null;
}

export function recordDeploymentReleaseActivated(runId: string, artifactDigest: string) {
  return db.transaction(() => {
    const release = getDeploymentRelease(artifactDigest);
    if (!release || release.run_id !== runId) throw new Error("Deployment release is not owned by this run.");
    const run = getDeploymentRun(runId);
    if (run?.candidate_artifact_digest !== artifactDigest || run.activation_state !== "intended") {
      throw new Error("Deployment release activation was not durably intended by this run.");
    }
    db.query(`UPDATE deployment_releases
      SET state=CASE WHEN state='lkg' THEN 'lkg' ELSE 'active' END,
          activated_at=CURRENT_TIMESTAMP
      WHERE artifact_digest=?`).run(artifactDigest);
    db.query(`UPDATE deployment_runs SET activation_state='active', updated_at=CURRENT_TIMESTAMP
      WHERE id=?`).run(runId);
    appendRunEvent(runId, "release_activated", { artifact_digest: artifactDigest });
    return getDeploymentRelease(artifactDigest)!;
  })();
}

export function recordDeploymentReleaseActivationIntent(runId: string, artifactDigest: string) {
  return db.transaction(() => {
    const release = getDeploymentRelease(artifactDigest);
    if (!release || release.run_id !== runId) throw new Error("Deployment release is not owned by this run.");
    const run = getDeploymentRun(runId);
    if (!run || !ACTIVE_RUN_STATUSES.includes(run.status)) throw new Error("Deployment run is not active.");
    db.query(`UPDATE deployment_runs
      SET candidate_artifact_digest=?, candidate_commit=?, activation_state='intended',
          updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(artifactDigest, release.git_commit, runId);
    appendRunEvent(runId, "release_activation_intended", {
      artifact_digest: artifactDigest,
      git_commit: release.git_commit,
    });
    return getDeploymentRun(runId)!;
  })();
}

export function promoteDeploymentRelease(runId: string, artifactDigest: string) {
  return db.transaction(() => {
    const release = getDeploymentRelease(artifactDigest);
    if (!release || release.run_id !== runId) throw new Error("Deployment release is not owned by this run.");
    if (!release.activated_at) throw new Error("Only an activated release may become last-known-good.");
    db.query("UPDATE deployment_releases SET state='retired' WHERE state='lkg' AND artifact_digest<>?")
      .run(artifactDigest);
    db.query(`UPDATE deployment_releases SET state='lkg', promoted_at=CURRENT_TIMESTAMP
      WHERE artifact_digest=?`).run(artifactDigest);
    appendRunEvent(runId, "release_promoted", { artifact_digest: artifactDigest });
    return getDeploymentRelease(artifactDigest)!;
  })();
}

export function getDeploymentRepairIncident(incidentId: string): DeploymentRepairIncidentRow | null {
  return db.query("SELECT * FROM deployment_repair_incidents WHERE id=?")
    .get(incidentId) as DeploymentRepairIncidentRow | null;
}

export function getDeploymentRepairIncidentForRun(runId: string): DeploymentRepairIncidentRow | null {
  return db.query("SELECT * FROM deployment_repair_incidents WHERE run_id=?")
    .get(runId) as DeploymentRepairIncidentRow | null;
}

export function beginDeploymentRepair(input: {
  runId: string;
  failedCommit: string;
  restoredCommit: string;
  failureFingerprint: string;
  error: string;
}): DeploymentRepairIncidentRow {
  assertCommit(input.failedCommit);
  assertCommit(input.restoredCommit);
  const incident = db.transaction(() => {
    const run = getDeploymentRun(input.runId);
    if (!run || !ACTIVE_RUN_STATUSES.includes(run.status)) {
      throw new Error(`Deployment run ${input.runId} must be active before repair handoff.`);
    }
    if (run.status !== "releasing") {
      db.query("UPDATE deployment_runs SET status='releasing', updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(input.runId);
      appendRunEvent(input.runId, "repair_handoff", { failed_phase: run.status });
    }
    const existing = getDeploymentRepairIncidentForRun(input.runId);
    if (existing) {
      const sameFailureCount = existing.failure_fingerprint === input.failureFingerprint
        ? existing.same_failure_count + 1
        : 1;
      db.query(`UPDATE deployment_repair_incidents
        SET status='restored', failed_commit=?, restored_commit=?, base_commit=?,
            failure_fingerprint=?, same_failure_count=?, repair_commit=NULL,
            review_verdict=NULL, review_json=NULL, review_attempts=0, error=?, completed_at=NULL,
            updated_at=CURRENT_TIMESTAMP
        WHERE id=?`).run(
          input.failedCommit,
          input.restoredCommit,
          input.failedCommit,
          input.failureFingerprint,
          sameFailureCount,
          input.error,
          existing.id,
        );
      db.query(`UPDATE deployment_runs SET repair_state='restored', updated_at=CURRENT_TIMESTAMP
        WHERE id=?`).run(input.runId);
      requestDeploymentTurnReactionStateInTransaction(input.runId, "repairing");
      appendRunEvent(input.runId, "repair_restored", {
        incident_id: existing.id,
        failure_fingerprint: input.failureFingerprint,
        same_failure_count: sameFailureCount,
        restored_commit: input.restoredCommit,
      });
      return getDeploymentRepairIncident(existing.id)!;
    }
    const incidentId = randomUUID();
    db.query(`INSERT INTO deployment_repair_incidents (
      id, run_id, status, failed_commit, restored_commit, failure_fingerprint,
      same_failure_count, base_commit, error
    ) VALUES (?, ?, 'restored', ?, ?, ?, 1, ?, ?)`)
      .run(
        incidentId,
        input.runId,
        input.failedCommit,
        input.restoredCommit,
        input.failureFingerprint,
        input.failedCommit,
        input.error,
      );
    db.query(`UPDATE deployment_runs SET repair_state='restored', updated_at=CURRENT_TIMESTAMP
      WHERE id=?`).run(input.runId);
    requestDeploymentTurnReactionStateInTransaction(input.runId, "repairing");
    appendRunEvent(input.runId, "repair_restored", {
      incident_id: incidentId,
      failure_fingerprint: input.failureFingerprint,
      same_failure_count: 1,
      restored_commit: input.restoredCommit,
    });
    return getDeploymentRepairIncident(incidentId)!;
  })();
  if (incident.same_failure_count >= 3) {
    return parkDeploymentRepair(
      incident.id,
      `The same deployment failure recurred ${incident.same_failure_count} times: ${input.error}`,
      {
        noticeReason: `Autonomous deployment repair stopped because the same failure recurred ${incident.same_failure_count} times.`,
      },
    );
  }
  return incident;
}

export function claimDeploymentRepair(input: {
  incidentId: string;
  pid: number;
  bootId: string;
  startTicks: string;
}) {
  return db.transaction(() => {
    const incident = getDeploymentRepairIncident(input.incidentId);
    if (!incident || incident.status === "parked" || incident.status === "completed") {
      throw new Error(`Deployment repair incident ${input.incidentId} is not runnable.`);
    }
    const run = getDeploymentRun(incident.run_id);
    if (!run || run.status !== "releasing") throw new Error("Repair no longer owns an active deployment run.");
    const status = incident.status === "reviewing" ? "reviewing" : "repairing";
    db.query(`UPDATE deployment_runs
      SET repair_state=?, runner_pid=?, runner_boot_id=?, runner_start_ticks=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=?`).run(status, input.pid, input.bootId, input.startTicks, run.id);
    db.query(`UPDATE deployment_repair_incidents SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(status, incident.id);
    appendRunEvent(run.id, "repair_claimed", { incident_id: incident.id, runner_pid: input.pid });
    return getDeploymentRepairIncident(incident.id)!;
  })();
}

export function recordDeploymentRepairWorkspace(
  incidentId: string,
  worktreePath: string,
  branchName: string,
  baseCommit: string,
) {
  assertCommit(baseCommit);
  db.query(`UPDATE deployment_repair_incidents
    SET worktree_path=?, branch_name=?, base_commit=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND status NOT IN ('parked', 'completed')`)
    .run(worktreePath, branchName, baseCommit, incidentId);
  return getDeploymentRepairIncident(incidentId)!;
}

export function latestDeploymentRepairAgentRun(
  incidentId: string,
  kind: "repair" | "review",
): DeploymentRepairAgentRunRow | null {
  return db.query(`SELECT * FROM deployment_repair_agent_runs
    WHERE incident_id=? AND kind=? ORDER BY created_at DESC, id DESC LIMIT 1`)
    .get(incidentId, kind) as DeploymentRepairAgentRunRow | null;
}

export function prepareDeploymentRepairAgentLaunch(input: {
  incidentId: string;
  kind: "repair" | "review";
  supervisorPid: number;
  supervisorBootId: string;
  supervisorStartTicks: string;
  outputPath: string;
}) {
  const incident = getDeploymentRepairIncident(input.incidentId);
  if (!incident || incident.status === "parked" || incident.status === "completed") {
    throw new Error("Repair incident is not launchable.");
  }
  const id = randomUUID();
  db.query(`INSERT INTO deployment_repair_agent_runs (
    id, incident_id, kind, launch_state, supervisor_pid, supervisor_boot_id,
    supervisor_start_ticks, output_path
  ) VALUES (?, ?, ?, 'launch_intended', ?, ?, ?, ?)`)
    .run(
      id,
      input.incidentId,
      input.kind,
      input.supervisorPid,
      input.supervisorBootId,
      input.supervisorStartTicks,
      input.outputPath,
    );
  db.query(`UPDATE deployment_repair_incidents SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(input.kind === "review" ? "reviewing" : "repairing", input.incidentId);
  db.query(`UPDATE deployment_runs SET repair_state=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?`).run(input.kind === "review" ? "reviewing" : "repairing", incident.run_id);
  return latestDeploymentRepairAgentRun(input.incidentId, input.kind)!;
}

export function recordDeploymentRepairChild(
  agentRunId: string,
  identity: { pid: number; bootId: string; startTicks: string },
) {
  const changed = db.query(`UPDATE deployment_repair_agent_runs
    SET child_pid=?, child_boot_id=?, child_start_ticks=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND launch_state='launch_intended' AND child_pid IS NULL`)
    .run(identity.pid, identity.bootId, identity.startTicks, agentRunId);
  if (changed.changes !== 1) throw new Error("Repair agent child identity could not be persisted.");
}

export function bindDeploymentRepairSession(agentRunId: string, sessionUuid: string) {
  if (!/^[0-9a-f-]{30,50}$/i.test(sessionUuid)) throw new Error("Repair session UUID is invalid.");
  const changed = db.query(`UPDATE deployment_repair_agent_runs
    SET launch_state='session_bound', session_uuid=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND launch_state='launch_intended' AND session_uuid IS NULL`)
    .run(sessionUuid, agentRunId);
  if (changed.changes !== 1) {
    const current = db.query("SELECT * FROM deployment_repair_agent_runs WHERE id=?")
      .get(agentRunId) as DeploymentRepairAgentRunRow | null;
    if (!current || current.session_uuid !== sessionUuid) throw new Error("Repair session binding was lost.");
  }
}

export function completeDeploymentRepairAgentRun(agentRunId: string, result: Record<string, unknown>) {
  db.query(`UPDATE deployment_repair_agent_runs
    SET launch_state='completed', result_json=?, error=NULL,
        completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND launch_state IN ('launch_intended', 'session_bound')`)
    .run(JSON.stringify(result), agentRunId);
}

export function parkDeploymentRepairAgentRun(agentRunId: string, error: string) {
  db.query(`UPDATE deployment_repair_agent_runs
    SET launch_state='parked', error=?, completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND launch_state IN ('launch_intended', 'session_bound')`).run(error, agentRunId);
}

export function recordDeploymentRepairCommit(incidentId: string, repairCommit: string) {
  assertCommit(repairCommit);
  db.query(`UPDATE deployment_repair_incidents
    SET repair_commit=?, review_verdict=NULL, review_json=NULL, status='reviewing', updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND status NOT IN ('parked', 'completed')`).run(repairCommit, incidentId);
  const incident = getDeploymentRepairIncident(incidentId)!;
  db.query("UPDATE deployment_runs SET repair_state='reviewing', updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(incident.run_id);
  return incident;
}

export function recordDeploymentRepairReview(
  incidentId: string,
  verdict: "SHIP" | "NO_SHIP",
  result: Record<string, unknown>,
) {
  db.query(`UPDATE deployment_repair_incidents
    SET review_verdict=?, review_json=?, review_attempts=review_attempts+1,
        status=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND status NOT IN ('parked', 'completed')`)
    .run(verdict, JSON.stringify(result), verdict === "SHIP" ? "reviewing" : "repairing", incidentId);
  const incident = getDeploymentRepairIncident(incidentId)!;
  db.query("UPDATE deployment_runs SET repair_state=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(verdict === "SHIP" ? "reviewing" : "repairing", incident.run_id);
  return incident;
}

export function prepareDeploymentRetry(incidentId: string) {
  return db.transaction(() => {
    const incident = getDeploymentRepairIncident(incidentId);
    if (!incident || incident.status === "parked" || incident.status === "completed") {
      throw new Error("Repair incident is not retryable.");
    }
    if (incident.review_verdict !== "SHIP" || !incident.repair_commit) {
      throw new Error("Deployment retry requires a reviewed repair commit.");
    }
    const run = getDeploymentRun(incident.run_id);
    if (!run || run.status !== "releasing") throw new Error("Deployment run is not held for retry.");
    db.query(`UPDATE deployment_repair_incidents SET status='retrying', updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(incidentId);
    db.query(`UPDATE deployment_runs
      SET status='prepared', repair_state='retrying', runner_pid=NULL, runner_boot_id=NULL,
          runner_start_ticks=NULL, deployed_commit=NULL, service_invocation_id=NULL,
          evidence_json=NULL, error=NULL, completed_at=NULL, candidate_artifact_digest=NULL,
          candidate_commit=NULL, activation_state=NULL, updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND status='releasing'`).run(run.id);
    requestDeploymentTurnReactionStateInTransaction(run.id, "deploying");
    appendRunEvent(run.id, "repair_retrying", { incident_id: incidentId, repair_commit: incident.repair_commit });
    return getDeploymentRun(run.id)!;
  })();
}

export function completeDeploymentRepairIncident(incidentId: string) {
  const incident = getDeploymentRepairIncident(incidentId);
  if (!incident) throw new Error("Unknown deployment repair incident.");
  db.query(`UPDATE deployment_repair_incidents
    SET status='completed', error=NULL, completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
    WHERE id=?`).run(incidentId);
  return getDeploymentRepairIncident(incidentId)!;
}

export function parkDeploymentRepair(
  incidentId: string,
  error: string,
  options: DeploymentFailureOptions = {},
): DeploymentRepairIncidentRow {
  const incident = getDeploymentRepairIncident(incidentId);
  if (!incident) throw new Error("Unknown deployment repair incident.");
  db.query(`UPDATE deployment_repair_incidents
    SET status='parked', error=?, completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
    WHERE id=?`).run(error, incidentId);
  db.query("UPDATE deployment_runs SET repair_state='parked', updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(incident.run_id);
  failDeploymentRun(
    incident.run_id,
    `Autonomous deployment repair parked: ${error}`,
    "failed",
    options,
  );
  return getDeploymentRepairIncident(incidentId)!;
}

export function listRunnableDeploymentRepairs(): DeploymentRepairIncidentRow[] {
  return db.query(`SELECT incident.* FROM deployment_repair_incidents incident
    JOIN deployment_runs run ON run.id=incident.run_id
    WHERE incident.status NOT IN ('parked', 'completed')
      AND (run.status='releasing' OR (run.status='prepared' AND run.repair_state='retrying'))
      AND run.repair_state IS NOT NULL
      AND run.runner_pid IS NULL
    ORDER BY incident.created_at, incident.id`).all() as DeploymentRepairIncidentRow[];
}

function assertCommit(value: string) {
  if (!/^[0-9a-f]{40}$/i.test(value)) throw new Error("Expected commit must be a full 40-character Git SHA.");
}

const deploymentContinuationSelect = `
    SELECT turn.id AS turn_id, turn.session_id, turn.status AS turn_status,
           turn.owner_instance_id, turn.slack_user_msg_ts, turn.slack_reply_thread_ts,
           turn.requested_by_user_id, turn.provider_model, turn.reasoning_effort,
           session.slack_channel_id, session.slack_thread_ts AS session_thread_ts,
           session.provider_id, session.agent_session_uuid,
           claim.user_id AS claim_user_id
    FROM turns turn
    JOIN sessions session ON session.id=turn.session_id
    LEFT JOIN slack_user_input_claims claim
      ON claim.slack_channel_id=session.slack_channel_id
     AND claim.slack_user_msg_ts=turn.slack_user_msg_ts
`;

function continuationFromSource(source: any) {
  if (!source.agent_session_uuid) {
    throw new Error("Deployment verification requires an existing provider session UUID.");
  }
  return {
    sourceTurnId: Number(source.turn_id),
    sourceSessionId: Number(source.session_id),
    ownerInstanceId: String(source.owner_instance_id),
    slackChannelId: String(source.slack_channel_id),
    slackThreadTs: String(source.slack_reply_thread_ts || source.session_thread_ts),
    requestedByUserId: source.requested_by_user_id || source.claim_user_id || null,
    providerId: source.provider_id as ProviderId,
    providerModel: source.provider_model || null,
    reasoningEffort: source.reasoning_effort || null,
    providerSessionUuid: String(source.agent_session_uuid),
  };
}

export function deploymentContinuationForTurn(sourceTurnId: number, ownerInstanceId: string) {
  const source = db.query(`${deploymentContinuationSelect} WHERE turn.id=?`).get(sourceTurnId) as any;
  if (!source) throw new Error(`Deployment source turn ${sourceTurnId} does not exist.`);
  if (source.turn_status !== "running" || source.owner_instance_id !== ownerInstanceId) {
    throw new Error(`Deployment source turn ${sourceTurnId} is not owned by this live agent turn.`);
  }
  return continuationFromSource(source);
}

export function deploymentContinuationForActiveSession(input: {
  sourceSessionId: number;
  slackChannelId: string;
  slackThreadTs: string;
}) {
  const sources = db.query(`${deploymentContinuationSelect}
    WHERE session.id=? AND session.slack_channel_id=?
      AND COALESCE(turn.slack_reply_thread_ts, session.slack_thread_ts)=?
      AND turn.status='running' AND turn.owner_instance_id IS NOT NULL
    ORDER BY turn.id
  `).all(input.sourceSessionId, input.slackChannelId, input.slackThreadTs) as any[];
  if (sources.length !== 1) {
    throw new Error(
      `Deployment source session ${input.sourceSessionId} must have exactly one owned running turn; found ${sources.length}.`,
    );
  }
  return continuationFromSource(sources[0]);
}

export function deploymentContinuationForAgent(input: {
  sourceTurnId: number;
  ownerInstanceId: string;
  sourceSessionId: number;
  slackChannelId: string;
  slackThreadTs: string;
}) {
  try {
    return deploymentContinuationForTurn(input.sourceTurnId, input.ownerInstanceId);
  } catch (exactTurnError) {
    if (!Number.isSafeInteger(input.sourceSessionId) || input.sourceSessionId <= 0
      || !input.slackChannelId || !input.slackThreadTs) throw exactTurnError;
    const current = deploymentContinuationForActiveSession(input);
    if (current.sourceTurnId === input.sourceTurnId) throw exactTurnError;
    return current;
  }
}

export function requestDeployment(input: {
  target?: string;
  sourceTurnId: number;
  ownerInstanceId: string;
  expectedCommit: string;
}): { run: DeploymentRunRow; request: DeploymentRequestRow; launchRequired: boolean } {
  assertCommit(input.expectedCommit);
  const target = input.target || "concierge";
  return db.transaction(() => {
    const existing = db.query(`SELECT request.*, run.status AS run_status
      FROM deployment_requests request
      JOIN deployment_runs run ON run.id=request.run_id
      WHERE request.source_turn_id=? AND request.expected_commit=?`)
      .get(input.sourceTurnId, input.expectedCommit) as any;
    if (existing) {
      return {
        run: getDeploymentRun(existing.run_id)!,
        request: db.query("SELECT * FROM deployment_requests WHERE id=?").get(existing.id) as DeploymentRequestRow,
        launchRequired: existing.run_status === "prepared",
      };
    }

    const source = deploymentContinuationForTurn(input.sourceTurnId, input.ownerInstanceId);

    let run = getActiveDeploymentRun(target);
    let launchRequired = false;
    if (!run) {
      const runId = randomUUID();
      const unitName = `concierge-deploy-${runId.slice(0, 12)}`;
      db.query(`INSERT INTO deployment_runs (id, target, unit_name, status)
                VALUES (?, ?, ?, 'prepared')`).run(runId, target, unitName);
      appendRunEvent(runId, "prepared", { target, unit_name: unitName });
      run = getDeploymentRun(runId)!;
      launchRequired = true;
    }

    const requestId = randomUUID();
    db.query(`
      INSERT INTO deployment_requests (
        id, run_id, source_turn_id, source_session_id, expected_commit,
        slack_channel_id, slack_thread_ts, requested_by_user_id,
        provider_id, provider_model, reasoning_effort, provider_session_uuid
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      requestId,
      run.id,
      source.sourceTurnId,
      source.sourceSessionId,
      input.expectedCommit.toLowerCase(),
      source.slackChannelId,
      source.slackThreadTs,
      source.requestedByUserId,
      source.providerId,
      source.providerModel,
      source.reasoningEffort,
      source.providerSessionUuid,
    );
    appendRunEvent(run.id, "request_joined", {
      request_id: requestId,
      source_turn_id: source.sourceTurnId,
      expected_commit: input.expectedCommit.toLowerCase(),
    });
    return {
      run,
      request: db.query("SELECT * FROM deployment_requests WHERE id=?").get(requestId) as DeploymentRequestRow,
      launchRequired,
    };
  })();
}

export function requestOperatorDeployment(target = "concierge") {
  return db.transaction(() => {
    const existing = getActiveDeploymentRun(target);
    if (existing) {
      if (existing.status !== "prepared") {
        throw new Error(`Deployment run ${existing.id} already owns ${target} in ${existing.status}.`);
      }
      return { run: existing, launchRequired: true };
    }
    const runId = randomUUID();
    const unitName = `concierge-deploy-${runId.slice(0, 12)}`;
    db.query(`INSERT INTO deployment_runs (id, target, unit_name, status)
      VALUES (?, ?, ?, 'prepared')`).run(runId, target, unitName);
    appendRunEvent(runId, "prepared", { target, unit_name: unitName, requested_by: "operator" });
    return { run: getDeploymentRun(runId)!, launchRequired: true };
  })();
}

export function requestAutomaticDeployment(
  desiredCommit: string,
  target = "concierge",
): {
  run: DeploymentRunRow | null;
  launchRequired: boolean;
  reason: "prepared" | "active" | "current" | "uninitialized" | "blocked";
} {
  assertCommit(desiredCommit);
  return db.transaction(() => {
    const active = getActiveDeploymentRun(target);
    if (active) return { run: active, launchRequired: false, reason: "active" as const };
    const lastKnownGood = getLastKnownGoodRelease();
    if (!lastKnownGood) return { run: null, launchRequired: false, reason: "uninitialized" as const };
    if (lastKnownGood.git_commit === desiredCommit.toLowerCase()) {
      return { run: null, launchRequired: false, reason: "current" as const };
    }
    const blocked = db.query(`SELECT * FROM deployment_runs
      WHERE target=? AND desired_commit=? AND status IN ('failed', 'ambiguous')
      ORDER BY completed_at DESC, created_at DESC LIMIT 1`)
      .get(target, desiredCommit.toLowerCase()) as DeploymentRunRow | null;
    if (blocked) return { run: blocked, launchRequired: false, reason: "blocked" as const };
    const runId = randomUUID();
    const unitName = `concierge-deploy-${runId.slice(0, 12)}`;
    db.query(`INSERT INTO deployment_runs (id, target, unit_name, status, desired_commit)
      VALUES (?, ?, ?, 'prepared', ?)`).run(runId, target, unitName, desiredCommit.toLowerCase());
    appendRunEvent(runId, "prepared", {
      target,
      unit_name: unitName,
      requested_by: "origin-main-reconciler",
      desired_commit: desiredCommit.toLowerCase(),
      last_known_good_commit: lastKnownGood.git_commit,
    });
    return { run: getDeploymentRun(runId)!, launchRequired: true, reason: "prepared" as const };
  })();
}

export function claimDeploymentRun(input: {
  runId: string;
  pid: number;
  bootId: string;
  startTicks: string;
}): DeploymentRunRow {
  return db.transaction(() => {
    const run = getDeploymentRun(input.runId);
    if (!run) throw new Error(`Unknown deployment run ${input.runId}.`);
    if (run.status === "draining"
      && run.runner_pid === input.pid
      && run.runner_boot_id === input.bootId
      && run.runner_start_ticks === input.startTicks) return run;
    if (run.status !== "prepared" || run.runner_pid != null) {
      const priorOwnerAlive = isProcessIdentityAlive({
        pid: Number(run.runner_pid || 0),
        bootId: run.runner_boot_id || "",
        startTicks: run.runner_start_ticks || "",
      });
      if (!ACTIVE_RUN_STATUSES.includes(run.status)
        || (run.repair_state && run.repair_state !== "retrying")
        || priorOwnerAlive) {
        throw new Error(`Deployment run ${input.runId} cannot be claimed from ${run.status}.`);
      }
      db.query(`UPDATE deployment_runs
        SET status='draining', runner_pid=?, runner_boot_id=?, runner_start_ticks=?, updated_at=CURRENT_TIMESTAMP
        WHERE id=?`).run(input.pid, input.bootId, input.startTicks, input.runId);
      appendRunEvent(input.runId, "runner_reclaimed", { prior_status: run.status, runner_pid: input.pid });
      return getDeploymentRun(input.runId)!;
    }
    db.query(`UPDATE deployment_runs
      SET status='draining', runner_pid=?, runner_boot_id=?, runner_start_ticks=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND status='prepared' AND runner_pid IS NULL`)
      .run(input.pid, input.bootId, input.startTicks, input.runId);
    appendRunEvent(input.runId, "draining", { runner_pid: input.pid });
    return getDeploymentRun(input.runId)!;
  })();
}

export function recordDeploymentRunPhase(
  runId: string,
  phase: "updating" | "restarting" | "verifying" | "releasing",
  detail: Record<string, unknown> = {},
): DeploymentRunRow {
  return db.transaction(() => {
    const run = getDeploymentRun(runId);
    if (!run) throw new Error(`Unknown deployment run ${runId}.`);
    const current = PHASE_ORDER.indexOf(run.status);
    const next = PHASE_ORDER.indexOf(phase);
    if (current < 0 || next !== current + 1) {
      throw new Error(`Deployment run ${runId} cannot transition ${run.status} -> ${phase}.`);
    }
    db.query("UPDATE deployment_runs SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(phase, runId);
    appendRunEvent(runId, phase, detail);
    return getDeploymentRun(runId)!;
  })();
}

function deploymentNoticeText(input: {
  kind: DeploymentNoticeRow["kind"];
  runId: string;
  expectedCommits?: string[];
  error: string;
  outcome?: "failed" | "ambiguous";
}) {
  const reference = `Reference: \`${input.runId.slice(0, 12)}\`.`;
  if (input.kind === "commit_not_included") {
    const commits = (input.expectedCommits || []).map((commit) => `\`${commit}\``).join(", ");
    return `Deployment passed its health gate but did not include the requested commit${input.expectedCommits?.length === 1 ? "" : "s"}: ${commits}. ${noticeSentence(input.error)} No verification turn was started. ${reference}`;
  }
  if (input.kind === "wake_parked") {
    return `Deployment succeeded, but Concierge could not safely resume the original provider session for verification. ${noticeSentence(input.error)} No fresh session was substituted. ${reference}`;
  }
  const result = input.outcome === "ambiguous"
    ? "Deployment outcome is uncertain."
    : "Deployment failed.";
  return `${result} ${noticeSentence(input.error)} No verification turn was started. ${reference}`;
}

function noticeSentence(input: string) {
  const trimmed = input.trim();
  const capitalized = /^[a-z]/.test(trimmed)
    ? `${trimmed[0].toUpperCase()}${trimmed.slice(1)}`
    : trimmed;
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}

function queueNotice(input: {
  runId: string;
  sessionId: number;
  channel: string;
  threadTs: string;
  userId: string | null;
  kind: DeploymentNoticeRow["kind"];
  error: string;
  expectedCommits?: string[];
  outcome?: "failed" | "ambiguous";
}) {
  const noticeId = randomUUID();
  db.query(`
    INSERT INTO deployment_notices (
      id, run_id, session_id, slack_channel_id, slack_thread_ts,
      requested_by_user_id, kind, text, client_msg_id, status, next_attempt_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0)
    ON CONFLICT(run_id, session_id, slack_channel_id, slack_thread_ts, kind) DO NOTHING
  `).run(
    noticeId,
    input.runId,
    input.sessionId,
    input.channel,
    input.threadTs,
    input.userId,
    input.kind,
    deploymentNoticeText(input),
    `slack-concierge:deployment-notice:${noticeId}`,
  );
}

function gitCommitIsAncestor(repo: string, ancestor: string, descendant: string): boolean {
  return Bun.spawnSync({
    cmd: ["git", "-C", repo, "merge-base", "--is-ancestor", ancestor, descendant],
    stdout: "ignore",
    stderr: "ignore",
  }).exitCode === 0;
}

export function completeDeploymentRun(input: {
  runId: string;
  repo: string;
  deployedCommit: string;
  serviceInvocationId: string;
  evidence: Record<string, unknown>;
  isAncestor?: (repo: string, ancestor: string, descendant: string) => boolean;
}): DeploymentRunRow {
  assertCommit(input.deployedCommit);
  const isAncestor = input.isAncestor || gitCommitIsAncestor;
  return db.transaction(() => {
    const run = getDeploymentRun(input.runId);
    if (!run) throw new Error(`Unknown deployment run ${input.runId}.`);
    if (run.status !== "releasing") {
      if (run.status === "succeeded") return run;
      throw new Error(`Deployment run ${input.runId} cannot succeed from ${run.status}.`);
    }
    const requests = listDeploymentRequests(input.runId);
    for (const request of requests) {
      const included = isAncestor(input.repo, request.expected_commit, input.deployedCommit);
      db.query(`UPDATE deployment_requests
        SET status=?, error=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'`)
        .run(
          included ? "included" : "not_included",
          included ? null : `Deployed commit ${input.deployedCommit} is not a descendant of ${request.expected_commit}.`,
          request.id,
        );
    }

    const settledRequests = listDeploymentRequests(input.runId);
    const requestGroups = new Map<string, DeploymentRequestRow[]>();
    for (const request of settledRequests) {
      const key = [request.source_session_id, request.slack_channel_id, request.slack_thread_ts].join("\u0000");
      const group = requestGroups.get(key) || [];
      group.push(request);
      requestGroups.set(key, group);
    }
    for (const requestsForSession of requestGroups.values()) {
      const omitted = requestsForSession.filter((request) => request.status !== "included");
      if (omitted.length > 0) {
        const latest = requestsForSession.at(-1)!;
        queueNotice({
          runId: input.runId,
          sessionId: latest.source_session_id,
          channel: latest.slack_channel_id,
          threadTs: latest.slack_thread_ts,
          userId: latest.requested_by_user_id,
          kind: "commit_not_included",
          error: omitted.map((request) => request.error).filter(Boolean).join(" ")
            || "One or more requested commits were not deployed.",
          expectedCommits: omitted.map((request) => request.expected_commit),
        });
      }
    }

    db.query(`UPDATE deployment_runs
      SET status='succeeded', deployed_commit=?, service_invocation_id=?, evidence_json=?,
          repair_state=NULL, error=NULL, completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND status='releasing'`)
      .run(
        input.deployedCommit.toLowerCase(),
        input.serviceInvocationId,
        JSON.stringify(input.evidence),
        input.runId,
      );
    requestDeploymentTurnReactionStateInTransaction(input.runId, "deployed");
    const completedRun = getDeploymentRun(input.runId)!;
    appendRunEvent(input.runId, "succeeded", {
      deployed_commit: input.deployedCommit.toLowerCase(),
      service_invocation_id: input.serviceInvocationId,
      included_request_count: settledRequests.filter((request) => request.status === "included").length,
    });
    db.query(`UPDATE deployment_repair_incidents
      SET status='completed', error=NULL, completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
      WHERE run_id=? AND status NOT IN ('parked', 'completed')`).run(input.runId);

    return completedRun;
  })();
}

export function failDeploymentRun(
  runId: string,
  error: string,
  outcome: "failed" | "ambiguous" = "failed",
  options: DeploymentFailureOptions = {},
): DeploymentRunRow | null {
  return db.transaction(() => {
    const run = getDeploymentRun(runId);
    if (!run) return null;
    if (!ACTIVE_RUN_STATUSES.includes(run.status)) return run;
    db.query(`UPDATE deployment_runs
      SET status=?, error=?, completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
      WHERE id=?`).run(outcome, error, runId);
    requestDeploymentTurnReactionStateInTransaction(runId, "parked");
    db.query(`UPDATE deployment_requests
      SET status='failed', error=?, updated_at=CURRENT_TIMESTAMP
      WHERE run_id=? AND status='pending'`).run(error, runId);
    appendRunEvent(runId, outcome, {
      error,
      prior_status: run.status,
      diagnostics: options.diagnostics || {},
    });
    const grouped = new Map<string, DeploymentRequestRow>();
    for (const request of listDeploymentRequests(runId)) {
      const key = [request.source_session_id, request.slack_channel_id, request.slack_thread_ts].join("\u0000");
      grouped.set(key, request);
    }
    for (const request of grouped.values()) {
      queueNotice({
        runId,
        sessionId: request.source_session_id,
        channel: request.slack_channel_id,
        threadTs: request.slack_thread_ts,
        userId: request.requested_by_user_id,
        kind: "deploy_failed",
        error: options.noticeReason || error,
        outcome,
      });
    }
    return getDeploymentRun(runId);
  })();
}

export function listPreparedDeploymentRuns(): DeploymentRunRow[] {
  return db.query(`SELECT * FROM deployment_runs
    WHERE status='prepared' AND repair_state IS NULL ORDER BY created_at, id`)
    .all() as DeploymentRunRow[];
}

export function listDeadCandidateDeploymentRuns(
  isAlive: (identity: { pid: number; bootId: string; startTicks: string }) => boolean,
): DeploymentRunRow[] {
  return (db.query(`SELECT * FROM deployment_runs
    WHERE status IN ('draining', 'updating', 'restarting', 'verifying', 'releasing')
      AND (repair_state IS NULL OR repair_state='retrying')
      AND activation_state IN ('intended', 'active')
      AND candidate_commit IS NOT NULL AND candidate_artifact_digest IS NOT NULL`)
    .all() as DeploymentRunRow[]).filter((run) => !isAlive({
      pid: Number(run.runner_pid || 0),
      bootId: run.runner_boot_id || "",
      startTicks: run.runner_start_ticks || "",
    }));
}

export function recoverDeadDeploymentRuns(
  isAlive: (identity: { pid: number; bootId: string; startTicks: string }) => boolean,
): number {
  const runs = db.query(`SELECT * FROM deployment_runs
    WHERE status IN ('draining', 'updating', 'restarting', 'verifying', 'releasing')`)
    .all() as DeploymentRunRow[];
  let recovered = 0;
  for (const run of runs) {
    if (isAlive({
      pid: Number(run.runner_pid || 0),
      bootId: run.runner_boot_id || "",
      startTicks: run.runner_start_ticks || "",
    })) continue;
    if (run.repair_state === "retrying") {
      if (run.activation_state) {
        // The immutable repair supervisor (or boot pre-start recovery) restores
        // LKG and re-enters the existing incident. Do not rewrite that retry as a
        // generic lost repair owner while its activation checkpoint is actionable.
        continue;
      }
      db.transaction(() => {
        db.query(`UPDATE deployment_runs
          SET status='prepared', runner_pid=NULL, runner_boot_id=NULL, runner_start_ticks=NULL,
              updated_at=CURRENT_TIMESTAMP WHERE id=? AND repair_state='retrying'`).run(run.id);
        appendRunEvent(run.id, "repair_retry_requeued", { prior_status: run.status });
      })();
      recovered += 1;
      continue;
    }
    if (run.repair_state) {
      db.transaction(() => {
        db.query(`UPDATE deployment_runs
          SET status='releasing', repair_state='repairing', runner_pid=NULL,
              runner_boot_id=NULL, runner_start_ticks=NULL, updated_at=CURRENT_TIMESTAMP
          WHERE id=? AND repair_state IS NOT NULL`).run(run.id);
        db.query(`UPDATE deployment_repair_incidents
          SET status='repairing', updated_at=CURRENT_TIMESTAMP
          WHERE run_id=? AND status NOT IN ('parked', 'completed')`).run(run.id);
        appendRunEvent(run.id, "repair_owner_lost", { prior_status: run.status });
      })();
      recovered += 1;
      continue;
    }
    db.transaction(() => {
      db.query(`UPDATE deployment_runs
        SET status='prepared', runner_pid=NULL, runner_boot_id=NULL, runner_start_ticks=NULL,
            updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(run.id);
      appendRunEvent(run.id, "runner_recovery_queued", {
        prior_status: run.status,
        activation_state: run.activation_state,
        candidate_commit: run.candidate_commit,
      });
    })();
    recovered += 1;
  }
  return recovered;
}

export function listPendingDeploymentWakes(nowMs = Date.now()): DeploymentWakeRow[] {
  return db.query(`SELECT * FROM deployment_wakes
    WHERE status='pending' AND COALESCE(next_attempt_ms, 0)<=?
    ORDER BY created_at, id`).all(nowMs) as DeploymentWakeRow[];
}

export function getDeploymentWake(wakeId: string): DeploymentWakeRow | null {
  return db.query("SELECT * FROM deployment_wakes WHERE id=?").get(wakeId) as DeploymentWakeRow | null;
}

export function claimDeploymentWake(
  wakeId: string,
  ownerInstanceId: string,
): ClaimedDeploymentWake | null {
  return db.transaction(() => {
    const wake = getDeploymentWake(wakeId);
    if (!wake || wake.status !== "pending") return null;
    const run = getDeploymentRun(wake.run_id);
    const session = db.query("SELECT * FROM sessions WHERE id=?").get(wake.session_id) as SessionRow | null;
    if (!run || run.status !== "succeeded" || !session
      || session.slack_channel_id !== wake.slack_channel_id
      || session.provider_id !== wake.provider_id
      || session.agent_session_uuid !== wake.provider_session_uuid) {
      parkDeploymentWake(
        wakeId,
        "The original provider session mapping is missing or no longer exact.",
      );
      return null;
    }
    if (session.status === "running") return null;
    if (session.status !== "idle") {
      parkDeploymentWake(
        wakeId,
        `The original provider session was ${session.status} instead of safely idle before verification.`,
      );
      return null;
    }
    const syntheticMessageKey = `deployment:${wake.id}`;
    const existingTurn = db.query(`SELECT id, status, turn_kind, trigger_key,
      provider_admission_intended_at FROM turns
      WHERE session_id=? AND slack_user_msg_ts=?`)
      .get(session.id, syntheticMessageKey) as any;
    const retryingPreAdmissionTurn = existingTurn
      && existingTurn.status === "cancelled"
      && existingTurn.turn_kind === "deployment_verification"
      && existingTurn.trigger_key === wake.id
      && !existingTurn.provider_admission_intended_at;
    if (existingTurn && !retryingPreAdmissionTurn) {
      parkDeploymentWake(wakeId, "The deterministic verification turn identity collided with terminal state.");
      return null;
    }
    const locked = db.query(`UPDATE sessions SET status='running', last_turn_at=CURRENT_TIMESTAMP
      WHERE id=? AND status='idle'
        AND NOT EXISTS (
          SELECT 1 FROM turns competing
          WHERE competing.session_id=sessions.id
            AND competing.status IN ('queued', 'parked', 'running', 'delivering')
        )`).run(session.id);
    if (locked.changes !== 1) return null;
    let turnId: number;
    if (retryingPreAdmissionTurn) {
      db.query(`UPDATE turns
        SET status='running', owner_instance_id=?, agent_text=NULL, ended_at=NULL
        WHERE id=? AND status='cancelled' AND provider_admission_intended_at IS NULL`)
        .run(ownerInstanceId, existingTurn.id);
      turnId = existingTurn.id;
    } else {
      const inserted = db.query(`
        INSERT INTO turns (
          session_id, slack_user_msg_ts, slack_reply_thread_ts, user_text, status,
          owner_instance_id, turn_kind, trigger_key, requested_by_user_id,
          provider_model, reasoning_effort
        ) VALUES (?, ?, ?, ?, 'running', ?, 'deployment_verification', ?, ?, ?, ?)
        RETURNING id
      `).get(
        session.id,
        syntheticMessageKey,
        wake.slack_thread_ts,
        wake.prompt,
        ownerInstanceId,
        wake.id,
        wake.requested_by_user_id,
        wake.provider_model,
        wake.reasoning_effort,
      ) as { id: number };
      turnId = inserted.id;
    }
    db.query(`UPDATE deployment_wakes
      SET status='running', owner_instance_id=?, turn_id=?, attempts=attempts+1,
          error=NULL, updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND status='pending'`)
      .run(ownerInstanceId, turnId, wakeId);
    return { wake: getDeploymentWake(wakeId)!, turnId, session };
  })();
}

export function markDeploymentWakeAdmissionIntended(
  wakeId: string,
  turnId: number,
  ownerInstanceId: string,
) {
  db.transaction(() => {
    const wake = db.query(`UPDATE deployment_wakes
      SET provider_admission_intended_at=COALESCE(provider_admission_intended_at, CURRENT_TIMESTAMP),
          updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND turn_id=? AND status='running' AND owner_instance_id=?`)
      .run(wakeId, turnId, ownerInstanceId);
    if (wake.changes !== 1) throw new Error(`Deployment wake ${wakeId} lost its execution lease.`);
    const turn = db.query(`UPDATE turns
      SET provider_admission_intended_at=COALESCE(provider_admission_intended_at, CURRENT_TIMESTAMP)
      WHERE id=? AND status='running' AND owner_instance_id=?`)
      .run(turnId, ownerInstanceId);
    if (turn.changes !== 1) throw new Error(`Deployment wake ${wakeId} lost its turn lease.`);
  })();
}

export function settleDeploymentWakeFromTurn(wakeId: string): DeploymentWakeRow | null {
  return db.transaction(() => {
    const wake = getDeploymentWake(wakeId);
    if (!wake || wake.status !== "running" || !wake.turn_id) return wake;
    const turn = db.query("SELECT status, agent_text FROM turns WHERE id=?").get(wake.turn_id) as any;
    if (!turn) return parkDeploymentWake(wakeId, "The linked verification turn disappeared.");
    if (turn.status === "done") {
      db.query(`UPDATE deployment_wakes
        SET status='delivered', owner_instance_id=NULL, error=NULL,
            next_attempt_ms=NULL, updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND status='running'`).run(wakeId);
      return getDeploymentWake(wakeId);
    }
    if (["error", "cancelled", "interrupted", "delivery_parked"].includes(turn.status)) {
      return parkDeploymentWake(
        wakeId,
        turn.agent_text || `Verification turn ended in ${turn.status}.`,
      );
    }
    return wake;
  })();
}

export function parkDeploymentWake(wakeId: string, error: string): DeploymentWakeRow | null {
  return db.transaction(() => {
    const wake = getDeploymentWake(wakeId);
    if (!wake || wake.status === "delivered" || wake.status === "parked") return wake;
    if (wake.status === "running" && wake.turn_id) {
      const turn = db.query(`SELECT session_id, status, provider_admission_intended_at
        FROM turns WHERE id=?`).get(wake.turn_id) as any;
      if (turn?.status === "running"
        && !wake.provider_admission_intended_at
        && !turn.provider_admission_intended_at) {
        db.query(`UPDATE turns
          SET status='cancelled', owner_instance_id=NULL, agent_text=?, ended_at=CURRENT_TIMESTAMP
          WHERE id=? AND status='running' AND provider_admission_intended_at IS NULL`)
          .run(error, wake.turn_id);
        db.query("UPDATE sessions SET status='idle' WHERE id=? AND status='running'")
          .run(turn.session_id);
      }
    }
    db.query(`UPDATE deployment_wakes
      SET status='parked', owner_instance_id=NULL, error=?, next_attempt_ms=NULL,
          updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(error, wakeId);
    if (!wake.control_handoff_id) {
      queueNotice({
        runId: wake.run_id,
        sessionId: wake.session_id,
        channel: wake.slack_channel_id,
        threadTs: wake.slack_thread_ts,
        userId: wake.requested_by_user_id,
        kind: "wake_parked",
        error,
      });
    }
    return getDeploymentWake(wakeId);
  })();
}

export function recoverDeploymentWakeClaims(
  isAlive: (identity: { pid: number; bootId: string; startTicks: string }) => boolean,
): { retried: number; parked: number; settled: number } {
  const wakes = db.query(`
    SELECT wake.*, process.pid AS owner_pid, process.boot_id AS owner_boot_id,
           process.process_start_ticks AS owner_start_ticks,
           turn.status AS turn_status, turn.session_id AS turn_session_id,
           turn.provider_admission_intended_at AS turn_admission_intended_at
    FROM deployment_wakes wake
    LEFT JOIN process_instances process ON process.instance_id=wake.owner_instance_id
    LEFT JOIN turns turn ON turn.id=wake.turn_id
    WHERE wake.status='running'
  `).all() as any[];
  const recovered = { retried: 0, parked: 0, settled: 0 };
  for (const wake of wakes) {
    if (isAlive({
      pid: Number(wake.owner_pid || 0),
      bootId: String(wake.owner_boot_id || ""),
      startTicks: String(wake.owner_start_ticks || ""),
    })) continue;
    if (["done", "error", "cancelled", "interrupted", "delivery_parked"].includes(wake.turn_status)) {
      settleDeploymentWakeFromTurn(wake.id);
      recovered.settled += 1;
      continue;
    }
    if (wake.turn_status === "delivering") continue;
    if (!wake.provider_admission_intended_at && !wake.turn_admission_intended_at) {
      db.transaction(() => {
        db.query(`UPDATE turns SET status='cancelled', ended_at=CURRENT_TIMESTAMP,
          owner_instance_id=NULL, agent_text='Verification execution stopped before provider admission intent.'
          WHERE id=? AND status='running'`).run(wake.turn_id);
        db.query(`UPDATE sessions SET status='idle'
          WHERE id=? AND status='running'`).run(wake.turn_session_id);
        db.query(`UPDATE deployment_wakes
          SET status='pending', owner_instance_id=NULL, turn_id=NULL, error=NULL,
              next_attempt_ms=0, updated_at=CURRENT_TIMESTAMP
          WHERE id=? AND status='running'`).run(wake.id);
      })();
      recovered.retried += 1;
      continue;
    }
    parkDeploymentWake(
      wake.id,
      "The prior Concierge process stopped after provider admission became possible; replay would risk a duplicate provider turn.",
    );
    recovered.parked += 1;
  }
  return recovered;
}

export function listPendingDeploymentNotices(nowMs = Date.now()): DeploymentNoticeRow[] {
  return db.query(`SELECT * FROM deployment_notices
    WHERE status='pending' AND COALESCE(next_attempt_ms, 0)<=?
    ORDER BY created_at, id`).all(nowMs) as DeploymentNoticeRow[];
}

export function getDeploymentNotice(noticeId: string): DeploymentNoticeRow | null {
  return db.query("SELECT * FROM deployment_notices WHERE id=?")
    .get(noticeId) as DeploymentNoticeRow | null;
}

export function claimDeploymentNotice(
  noticeId: string,
  ownerInstanceId: string,
  nowMs = Date.now(),
): DeploymentNoticeRow | null {
  const claimed = db.query(`UPDATE deployment_notices
    SET status='sending', owner_instance_id=?, attempts=attempts+1, updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND status='pending' AND COALESCE(next_attempt_ms, 0)<=?`)
    .run(ownerInstanceId, noticeId, nowMs);
  return claimed.changes === 1 ? getDeploymentNotice(noticeId) : null;
}

export function markDeploymentNoticeDelivered(noticeId: string, ownerInstanceId: string) {
  const delivered = db.query(`UPDATE deployment_notices
    SET status='delivered', owner_instance_id=NULL, error=NULL, next_attempt_ms=NULL,
        updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND status='sending' AND owner_instance_id=?`)
    .run(noticeId, ownerInstanceId);
  if (delivered.changes !== 1) throw new Error(`Deployment notice ${noticeId} lost its delivery lease.`);
}

export function markDeploymentNoticeRetry(
  noticeId: string,
  ownerInstanceId: string,
  error: string,
  nextAttemptMs: number,
) {
  const retried = db.query(`UPDATE deployment_notices
    SET status='pending', owner_instance_id=NULL, error=?, next_attempt_ms=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND status='sending' AND owner_instance_id=?`)
    .run(error, nextAttemptMs, noticeId, ownerInstanceId);
  if (retried.changes !== 1) throw new Error(`Deployment notice ${noticeId} lost its delivery lease.`);
}

export function parkDeploymentNotice(noticeId: string, ownerInstanceId: string, error: string) {
  const parked = db.query(`UPDATE deployment_notices
    SET status='parked', owner_instance_id=NULL, error=?, next_attempt_ms=NULL, updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND status='sending' AND owner_instance_id=?`)
    .run(error, noticeId, ownerInstanceId);
  if (parked.changes !== 1) throw new Error(`Deployment notice ${noticeId} lost its delivery lease.`);
}

export function recoverDeploymentNoticeClaims(
  isAlive: (identity: { pid: number; bootId: string; startTicks: string }) => boolean,
): number {
  const notices = db.query(`SELECT notice.id, notice.owner_instance_id,
      process.pid, process.boot_id, process.process_start_ticks
    FROM deployment_notices notice
    LEFT JOIN process_instances process ON process.instance_id=notice.owner_instance_id
    WHERE notice.status='sending'`).all() as any[];
  let recovered = 0;
  for (const notice of notices) {
    if (isAlive({
      pid: Number(notice.pid || 0),
      bootId: String(notice.boot_id || ""),
      startTicks: String(notice.process_start_ticks || ""),
    })) continue;
    recovered += db.query(`UPDATE deployment_notices
      SET status='pending', owner_instance_id=NULL,
          error='Notice delivery interrupted before completion.', next_attempt_ms=0,
          updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND status='sending' AND owner_instance_id IS ?`)
      .run(notice.id, notice.owner_instance_id).changes;
  }
  return recovered;
}
