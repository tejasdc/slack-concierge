import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { Database } from "bun:sqlite";

export type IntentStatus =
  | "pending"
  | "satisfied"
  | "verification_pending"
  | "verified"
  | "parked"
  | "cancelled";

export type GenerationStatus = "prepared" | "active" | "succeeded" | "failed" | "ambiguous";
export type AttemptStatus =
  | "prepared"
  | "draining"
  | "updating"
  | "activating"
  | "verifying"
  | "releasing"
  | "succeeded"
  | "failed"
  | "ambiguous"
  | "restored";
export type IncidentStatus =
  | "open"
  | "stabilizing"
  | "diagnosing"
  | "awaiting_owner_fix"
  | "repairing"
  | "reviewing"
  | "deploying"
  | "verifying"
  | "learning"
  | "resolved"
  | "parked";
export type HandoffStatus = "pending" | "claimed" | "delivered" | "parked";
export type ReleaseStatus = "candidate" | "healthy" | "last_known_good" | "superseded" | "rollback_ineligible";
export type GapClassification =
  | "knowledge_gap"
  | "retrieval_miss"
  | "execution_miss"
  | "stale_knowledge"
  | "evidence_gap"
  | "novel_failure";
export type NotificationKind = "runtime_restored" | "repair_parked" | "forward_repair_succeeded";
export type NotificationStatus = "prepared" | "sending" | "ambiguous" | "delivered" | "parked";
export type RolloutStatus =
  | "staged"
  | "containing_application"
  | "staging_coordinator"
  | "proving"
  | "review_pending"
  | "authorized"
  | "canary_activating"
  | "canary_probation"
  | "recovery_proving"
  | "evidence_review_pending"
  | "production_authorized"
  | "production_activating"
  | "production_probation"
  | "verified"
  | "revoking"
  | "parked";
export type RolloutCheckStatus = "prepared" | "running" | "passed" | "failed" | "ambiguous";
export type RolloutReviewKind = "implementation" | "live_evidence";
export type RolloutReviewRequestStatus = "prepared" | "running" | "ship" | "no_ship" | "ambiguous" | "parked";
export type ActivationGenerationKind = "canary" | "production";
export type ActivationGenerationStatus = "pending" | "exposed" | "revoked";
export type CoordinatorSlot = "legacy" | "a" | "b";
export type CoordinatorHandoffStatus =
  | "prepared"
  | "start_requested"
  | "acknowledged"
  | "probation"
  | "promoted"
  | "revocation_requested"
  | "recovered"
  | "ambiguous";
export type RolloutGateStatus = "prepared" | "holding" | "held" | "release_requested" | "released" | "ambiguous";

export interface ContinuationSnapshot {
  sourceTurnId: number;
  sourceSessionId: number;
  slackChannelId: string;
  slackThreadTs: string;
  requestedByUserId: string | null;
  providerId: "codex" | "claude-code";
  providerModel: string | null;
  reasoningEffort: string | null;
  providerSessionUuid: string;
}

export interface DeploymentIntentRow {
  id: string;
  target: string;
  expected_commit: string;
  source_turn_id: number;
  source_session_id: number;
  slack_channel_id: string;
  slack_thread_ts: string;
  requested_by_user_id: string | null;
  provider_id: "codex" | "claude-code";
  provider_model: string | null;
  reasoning_effort: string | null;
  provider_session_uuid: string;
  status: IntentStatus;
  correcting_intent_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface TargetGenerationRow {
  id: string;
  target: string;
  desired_commit: string;
  origin_url: string;
  origin_observed_at: string;
  status: GenerationStatus;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface DeploymentAttemptRow {
  id: string;
  generation_id: string;
  target: string;
  status: AttemptStatus;
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

export interface DeploymentIncidentRow {
  id: string;
  target: string;
  status: IncidentStatus;
  failure_fingerprint: string;
  last_attempt_id: string;
  repair_provider_id: string | null;
  repair_session_uuid: string | null;
  repeated_fingerprint_count: number;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface DeploymentRepairRunRow {
  incident_id: string;
  status: "prepared" | "launched" | "running" | "completed" | "ambiguous" | "parked";
  base_commit: string;
  baseline_local_commit: string;
  repository_path: string;
  evidence_digest: string;
  provider_capability_digest: string;
  capability_expires_at_ms: number;
  worker_unit: string;
  provider_launch_attempted: number;
  pending_provider_capability_digest: string | null;
  pending_capability_expires_at_ms: number | null;
  provider_session_uuid: string | null;
  result_json: string | null;
  integrated_commit: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface DeploymentReviewRunRow {
  id: string;
  incident_id: string;
  status: "prepared" | "launched" | "running" | "ship" | "no_ship" | "ambiguous" | "parked";
  base_commit: string;
  head_commit: string;
  tree_digest: string;
  policy_digest: string;
  enforcement_digest: string;
  evidence_digest: string;
  repository_path: string;
  control_path: string;
  provider_capability_digest: string;
  capability_expires_at_ms: number;
  worker_unit: string;
  provider_launch_attempted: number;
  provider_session_uuid: string | null;
  verdict_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface DeploymentHandoffRow {
  id: string;
  target: string;
  kind: "verification" | "commit_blocker";
  attempt_id: string | null;
  incident_id: string | null;
  source_session_id: number;
  slack_channel_id: string;
  slack_thread_ts: string;
  requested_by_user_id: string | null;
  provider_id: "codex" | "claude-code";
  provider_model: string | null;
  reasoning_effort: string | null;
  provider_session_uuid: string;
  payload_json: string;
  status: HandoffStatus;
  owner_instance_id: string | null;
  idempotency_key: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReleaseRow {
  id: string;
  target: string;
  git_commit: string;
  artifact_path: string;
  artifact_digest: string;
  runtime_digest: string;
  compatibility_digest: string;
  rollback_safe: number;
  status: ReleaseStatus;
  evidence_json: string;
  created_at: string;
  updated_at: string;
}

export interface NotifierTargetRow {
  target: string;
  slack_channel_id: string;
  slack_channel_name: string;
  registry_code_path: string;
  bot_user_id: string | null;
  preflight_evidence_json: string | null;
  preflight_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeploymentNotificationRow {
  id: string;
  target: string;
  incident_id: string;
  kind: NotificationKind;
  payload_json: string;
  payload_digest: string;
  client_msg_id: string;
  status: NotificationStatus;
  root_alert_id: string | null;
  slack_ts: string | null;
  send_started_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeploymentRolloutRow {
  id: string;
  target: string;
  status: RolloutStatus;
  next_step: string;
  owner_unit: string;
  owner_invocation_id: string | null;
  owner_pid: number | null;
  owner_boot_id: string | null;
  owner_start_ticks: string | null;
  lease_heartbeat_at: string | null;
  identity_digest: string;
  evidence_digest: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface DeploymentRolloutCheckRow {
  rollout_id: string;
  name: string;
  phase: string;
  status: RolloutCheckStatus;
  evidence_digest: string | null;
  evidence_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface DeploymentRolloutReviewRow {
  id: string;
  rollout_id: string;
  review_kind: RolloutReviewKind;
  status: "ship" | "no_ship";
  reviewed_digest: string;
  identity_digest: string;
  reviewer_session_uuid: string;
  verdict_json: string;
  created_at: string;
}

export interface DeploymentRolloutReviewRequestRow {
  id: string;
  rollout_id: string;
  review_kind: RolloutReviewKind;
  status: RolloutReviewRequestStatus;
  reviewed_digest: string;
  identity_digest: string;
  worker_unit: string;
  owner_invocation_id: string | null;
  owner_pid: number | null;
  owner_boot_id: string | null;
  owner_start_ticks: string | null;
  provider_launch_attempted: number;
  provider_session_uuid: string | null;
  verdict_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface DeploymentActivationGenerationRow {
  id: string;
  rollout_id: string;
  target: string;
  kind: ActivationGenerationKind;
  status: ActivationGenerationStatus;
  capabilities_json: string;
  identity_digest: string;
  evidence_digest: string | null;
  bot_acknowledged_at: string | null;
  coordinator_acknowledged_at: string | null;
  exposed_at: string | null;
  revoked_at: string | null;
  revocation_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeploymentCoordinatorHandoffRow {
  generation_id: string;
  rollout_id: string;
  target: string;
  status: CoordinatorHandoffStatus;
  candidate_slot: "a" | "b";
  candidate_version: string;
  candidate_unit: string;
  candidate_invocation_id: string | null;
  candidate_pid: number | null;
  candidate_boot_id: string | null;
  candidate_start_ticks: string | null;
  incumbent_slot: CoordinatorSlot | null;
  incumbent_version: string | null;
  incumbent_unit: string | null;
  incumbent_was_active: number;
  candidate_start_requested_at: string | null;
  candidate_started_at: string | null;
  incumbent_stop_requested_at: string | null;
  incumbent_stopped_at: string | null;
  handshake_at: string | null;
  heartbeat_at: string | null;
  reconciliation_digest: string | null;
  probation_started_at: string | null;
  probation_deadline_at: string | null;
  promotion_requested_at: string | null;
  promoted_at: string | null;
  revocation_requested_at: string | null;
  recovered_at: string | null;
  recovery_invocation_id: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeploymentRolloutGateRow {
  rollout_id: string;
  target: string;
  status: RolloutGateStatus;
  deployment_token: string;
  capture_token: string;
  owner_pid: number;
  owner_boot_id: string;
  owner_start_ticks: string;
  deployment_held_at: string | null;
  capture_held_at: string | null;
  held_at: string | null;
  release_requested_at: string | null;
  released_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

const ATTEMPT_PHASES: AttemptStatus[] = [
  "prepared",
  "draining",
  "updating",
  "activating",
  "verifying",
  "releasing",
];

const INCIDENT_TRANSITIONS: Record<IncidentStatus, IncidentStatus[]> = {
  open: ["stabilizing", "diagnosing", "parked"],
  stabilizing: ["diagnosing", "parked"],
  diagnosing: ["awaiting_owner_fix", "repairing", "parked"],
  awaiting_owner_fix: ["deploying", "diagnosing", "parked"],
  repairing: ["reviewing", "diagnosing", "parked"],
  reviewing: ["repairing", "deploying", "parked"],
  deploying: ["verifying", "diagnosing", "parked"],
  verifying: ["learning", "diagnosing", "parked"],
  learning: ["resolved", "parked"],
  resolved: [],
  parked: ["diagnosing"],
};

const ROLLOUT_TRANSITIONS: Record<RolloutStatus, RolloutStatus[]> = {
  staged: ["containing_application", "revoking", "parked"],
  containing_application: ["staging_coordinator", "revoking", "parked"],
  staging_coordinator: ["proving", "revoking", "parked"],
  proving: ["review_pending", "revoking", "parked"],
  review_pending: ["authorized", "proving", "revoking", "parked"],
  authorized: ["canary_activating", "review_pending", "revoking", "parked"],
  canary_activating: ["canary_probation", "revoking", "parked"],
  canary_probation: ["recovery_proving", "revoking", "parked"],
  recovery_proving: ["evidence_review_pending", "revoking", "parked"],
  evidence_review_pending: ["production_authorized", "recovery_proving", "revoking", "parked"],
  production_authorized: ["production_activating", "evidence_review_pending", "revoking", "parked"],
  production_activating: ["production_probation", "revoking", "parked"],
  production_probation: ["verified", "revoking", "parked"],
  verified: [],
  revoking: ["staged", "parked"],
  parked: ["staged"],
};

function assertCommit(value: string, label = "commit") {
  if (!/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error(`${label} must be a full 40-character Git SHA.`);
  }
}

function assertDigest(value: string, label: string) {
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error(`${label} must be a SHA-256 digest.`);
}

function canonicalJson(value: unknown): string {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function evidenceDigest(name: string, phase: string, evidence: Record<string, unknown>) {
  return createHash("sha256").update(canonicalJson({ name, phase, evidence })).digest("hex");
}

function requireNonEmpty(value: string, label: string) {
  if (!value.trim()) throw new Error(`${label} is required.`);
}

export function canonicalDeploymentControlPath() {
  return process.env.CONCIERGE_DEPLOYMENT_STATE_DIR
    ? `${process.env.CONCIERGE_DEPLOYMENT_STATE_DIR}/control.db`
    : "/root/.local/state/concierge-deployment/control.db";
}

export class DeploymentControlStore {
  readonly database: Database;

  constructor(path = canonicalDeploymentControlPath()) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new Database(path, { create: true, strict: true });
    this.database.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    this.installSchema();
  }

  close() {
    this.database.close();
  }

  private installSchema() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS deployment_commands (
        idempotency_key TEXT PRIMARY KEY,
        caller_role TEXT NOT NULL,
        command_kind TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        response_json TEXT,
        status TEXT NOT NULL CHECK(status IN ('applying', 'applied', 'rejected', 'ambiguous')),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS deployment_intents (
        id TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        expected_commit TEXT NOT NULL,
        source_turn_id INTEGER NOT NULL,
        source_session_id INTEGER NOT NULL,
        slack_channel_id TEXT NOT NULL,
        slack_thread_ts TEXT NOT NULL,
        requested_by_user_id TEXT,
        provider_id TEXT NOT NULL CHECK(provider_id IN ('codex', 'claude-code')),
        provider_model TEXT,
        reasoning_effort TEXT,
        provider_session_uuid TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'satisfied', 'verification_pending', 'verified', 'parked', 'cancelled')),
        correcting_intent_id TEXT REFERENCES deployment_intents(id),
        error TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(source_turn_id, expected_commit)
      );
      CREATE INDEX IF NOT EXISTS deployment_intents_target_status
        ON deployment_intents(target, status, created_at, id);

      CREATE TABLE IF NOT EXISTS target_generations (
        id TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        desired_commit TEXT NOT NULL,
        origin_url TEXT NOT NULL,
        origin_observed_at DATETIME NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('prepared', 'active', 'succeeded', 'failed', 'ambiguous')),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME
      );
      CREATE UNIQUE INDEX IF NOT EXISTS target_generations_one_active
        ON target_generations(target) WHERE status IN ('prepared', 'active');

      CREATE TABLE IF NOT EXISTS generation_intents (
        generation_id TEXT NOT NULL REFERENCES target_generations(id),
        intent_id TEXT NOT NULL REFERENCES deployment_intents(id),
        joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(generation_id, intent_id)
      );

      CREATE TABLE IF NOT EXISTS deployment_attempts (
        id TEXT PRIMARY KEY,
        generation_id TEXT NOT NULL REFERENCES target_generations(id),
        target TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('prepared', 'draining', 'updating', 'activating', 'verifying', 'releasing', 'succeeded', 'failed', 'ambiguous', 'restored')),
        runner_pid INTEGER,
        runner_boot_id TEXT,
        runner_start_ticks TEXT,
        deployed_commit TEXT,
        service_invocation_id TEXT,
        evidence_json TEXT,
        error TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME
      );
      CREATE UNIQUE INDEX IF NOT EXISTS deployment_attempts_one_active
        ON deployment_attempts(target) WHERE status IN ('prepared', 'draining', 'updating', 'activating', 'verifying', 'releasing');

      CREATE TABLE IF NOT EXISTS intent_attempt_results (
        attempt_id TEXT NOT NULL REFERENCES deployment_attempts(id),
        intent_id TEXT NOT NULL REFERENCES deployment_intents(id),
        result TEXT NOT NULL CHECK(result IN ('joined', 'failed', 'ambiguous', 'satisfied', 'not_in_generation')),
        detail TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(attempt_id, intent_id)
      );

      CREATE TABLE IF NOT EXISTS deployment_incidents (
        id TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('open', 'stabilizing', 'diagnosing', 'awaiting_owner_fix', 'repairing', 'reviewing', 'deploying', 'verifying', 'learning', 'resolved', 'parked')),
        failure_fingerprint TEXT NOT NULL,
        last_attempt_id TEXT NOT NULL REFERENCES deployment_attempts(id),
        repair_provider_id TEXT,
        repair_session_uuid TEXT,
        repeated_fingerprint_count INTEGER NOT NULL DEFAULT 1,
        error TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME
      );
      CREATE UNIQUE INDEX IF NOT EXISTS deployment_incidents_one_active
        ON deployment_incidents(target) WHERE status NOT IN ('resolved', 'parked');

      CREATE TABLE IF NOT EXISTS deployment_repair_runs (
        incident_id TEXT PRIMARY KEY REFERENCES deployment_incidents(id),
        status TEXT NOT NULL CHECK(status IN ('prepared', 'launched', 'running', 'completed', 'ambiguous', 'parked')),
        base_commit TEXT NOT NULL,
        baseline_local_commit TEXT NOT NULL,
        repository_path TEXT NOT NULL,
        evidence_digest TEXT NOT NULL,
        provider_capability_digest TEXT NOT NULL,
        capability_expires_at_ms INTEGER NOT NULL,
        worker_unit TEXT NOT NULL,
        provider_launch_attempted INTEGER NOT NULL DEFAULT 0 CHECK(provider_launch_attempted IN (0, 1)),
        pending_provider_capability_digest TEXT,
        pending_capability_expires_at_ms INTEGER,
        provider_session_uuid TEXT,
        result_json TEXT,
        integrated_commit TEXT,
        error TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME
      );

      CREATE TABLE IF NOT EXISTS deployment_review_runs (
        id TEXT PRIMARY KEY,
        incident_id TEXT NOT NULL REFERENCES deployment_incidents(id),
        status TEXT NOT NULL CHECK(status IN ('prepared', 'launched', 'running', 'ship', 'no_ship', 'ambiguous', 'parked')),
        base_commit TEXT NOT NULL,
        head_commit TEXT NOT NULL,
        tree_digest TEXT NOT NULL,
        policy_digest TEXT NOT NULL,
        enforcement_digest TEXT NOT NULL,
        evidence_digest TEXT NOT NULL,
        repository_path TEXT NOT NULL,
        control_path TEXT NOT NULL,
        provider_capability_digest TEXT NOT NULL,
        capability_expires_at_ms INTEGER NOT NULL,
        worker_unit TEXT NOT NULL,
        provider_launch_attempted INTEGER NOT NULL DEFAULT 0 CHECK(provider_launch_attempted IN (0, 1)),
        provider_session_uuid TEXT,
        verdict_json TEXT,
        error TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        UNIQUE(incident_id, head_commit, tree_digest)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS deployment_review_runs_one_active
        ON deployment_review_runs(incident_id) WHERE status IN ('prepared', 'launched', 'running');

      CREATE TABLE IF NOT EXISTS deployment_handoffs (
        id TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('verification', 'commit_blocker')),
        attempt_id TEXT REFERENCES deployment_attempts(id),
        incident_id TEXT REFERENCES deployment_incidents(id),
        source_session_id INTEGER NOT NULL,
        slack_channel_id TEXT NOT NULL,
        slack_thread_ts TEXT NOT NULL,
        requested_by_user_id TEXT,
        provider_id TEXT NOT NULL CHECK(provider_id IN ('codex', 'claude-code')),
        provider_model TEXT,
        reasoning_effort TEXT,
        provider_session_uuid TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'delivered', 'parked')),
        owner_instance_id TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        error TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(kind, attempt_id, source_session_id, slack_channel_id, slack_thread_ts)
      );

      CREATE TABLE IF NOT EXISTS handoff_intents (
        handoff_id TEXT NOT NULL REFERENCES deployment_handoffs(id),
        intent_id TEXT NOT NULL REFERENCES deployment_intents(id),
        PRIMARY KEY(handoff_id, intent_id)
      );

      CREATE TABLE IF NOT EXISTS deployment_releases (
        id TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        git_commit TEXT NOT NULL,
        artifact_path TEXT NOT NULL,
        artifact_digest TEXT NOT NULL,
        runtime_digest TEXT NOT NULL,
        compatibility_digest TEXT NOT NULL,
        rollback_safe INTEGER NOT NULL CHECK(rollback_safe IN (0, 1)),
        status TEXT NOT NULL CHECK(status IN ('candidate', 'healthy', 'last_known_good', 'superseded', 'rollback_ineligible')),
        evidence_json TEXT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(target, git_commit, artifact_digest)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS deployment_releases_one_lkg
        ON deployment_releases(target) WHERE status='last_known_good';

      CREATE TABLE IF NOT EXISTS deployment_notifier_targets (
        target TEXT PRIMARY KEY,
        slack_channel_id TEXT NOT NULL,
        slack_channel_name TEXT NOT NULL,
        registry_code_path TEXT NOT NULL,
        bot_user_id TEXT,
        preflight_evidence_json TEXT,
        preflight_at DATETIME,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS deployment_notifications (
        id TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        incident_id TEXT NOT NULL REFERENCES deployment_incidents(id),
        kind TEXT NOT NULL CHECK(kind IN ('runtime_restored', 'repair_parked', 'forward_repair_succeeded')),
        payload_json TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        client_msg_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('prepared', 'sending', 'ambiguous', 'delivered', 'parked')),
        root_alert_id TEXT REFERENCES deployment_notifications(id),
        slack_ts TEXT,
        send_started_at DATETIME,
        error TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(incident_id, kind)
      );

      CREATE TABLE IF NOT EXISTS deployment_reviews (
        id TEXT PRIMARY KEY,
        incident_id TEXT NOT NULL REFERENCES deployment_incidents(id),
        review_kind TEXT NOT NULL CHECK(review_kind IN ('repair', 'learning', 'coordinator')),
        verdict TEXT NOT NULL CHECK(verdict IN ('ship', 'no_ship', 'promote', 'revise', 'reject')),
        base_commit TEXT NOT NULL,
        head_commit TEXT NOT NULL,
        tree_digest TEXT NOT NULL,
        policy_digest TEXT NOT NULL,
        enforcement_digest TEXT NOT NULL,
        evidence_digest TEXT NOT NULL,
        reviewer_identity TEXT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS deployment_learning (
        id TEXT PRIMARY KEY,
        incident_id TEXT NOT NULL REFERENCES deployment_incidents(id),
        classification TEXT NOT NULL CHECK(classification IN ('knowledge_gap', 'retrieval_miss', 'execution_miss', 'stale_knowledge', 'evidence_gap', 'novel_failure')),
        summary TEXT NOT NULL,
        retrieval_trace_json TEXT NOT NULL,
        production_evidence_json TEXT NOT NULL,
        promotion_review_id TEXT REFERENCES deployment_reviews(id),
        status TEXT NOT NULL CHECK(status IN ('recorded', 'proposed', 'promoted', 'rejected')),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(incident_id)
      );

      CREATE TABLE IF NOT EXISTS deployment_rollouts (
        id TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN (
          'staged', 'containing_application', 'staging_coordinator', 'proving',
          'review_pending', 'authorized', 'canary_activating', 'canary_probation',
          'recovery_proving', 'evidence_review_pending', 'production_authorized',
          'production_activating', 'production_probation', 'verified', 'revoking', 'parked'
        )),
        next_step TEXT NOT NULL,
        owner_unit TEXT NOT NULL,
        owner_invocation_id TEXT,
        owner_pid INTEGER,
        owner_boot_id TEXT,
        owner_start_ticks TEXT,
        lease_heartbeat_at DATETIME,
        identity_digest TEXT NOT NULL,
        evidence_digest TEXT,
        error TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME
      );
      CREATE UNIQUE INDEX IF NOT EXISTS deployment_rollouts_one_active
        ON deployment_rollouts(target) WHERE status NOT IN ('verified', 'parked');

      CREATE TABLE IF NOT EXISTS deployment_rollout_checks (
        rollout_id TEXT NOT NULL REFERENCES deployment_rollouts(id),
        name TEXT NOT NULL,
        phase TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('prepared', 'running', 'passed', 'failed', 'ambiguous')),
        evidence_digest TEXT,
        evidence_json TEXT,
        error TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        PRIMARY KEY(rollout_id, name)
      );

      CREATE TABLE IF NOT EXISTS deployment_rollout_reviews (
        id TEXT PRIMARY KEY,
        rollout_id TEXT NOT NULL REFERENCES deployment_rollouts(id),
        review_kind TEXT NOT NULL CHECK(review_kind IN ('implementation', 'live_evidence')),
        status TEXT NOT NULL CHECK(status IN ('ship', 'no_ship')),
        reviewed_digest TEXT NOT NULL,
        identity_digest TEXT NOT NULL,
        reviewer_session_uuid TEXT NOT NULL,
        verdict_json TEXT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(rollout_id, review_kind, reviewed_digest, identity_digest)
      );

      CREATE TABLE IF NOT EXISTS deployment_rollout_review_requests (
        id TEXT PRIMARY KEY,
        rollout_id TEXT NOT NULL REFERENCES deployment_rollouts(id),
        review_kind TEXT NOT NULL CHECK(review_kind IN ('implementation', 'live_evidence')),
        status TEXT NOT NULL CHECK(status IN ('prepared', 'running', 'ship', 'no_ship', 'ambiguous', 'parked')),
        reviewed_digest TEXT NOT NULL,
        identity_digest TEXT NOT NULL,
        worker_unit TEXT NOT NULL UNIQUE,
        owner_invocation_id TEXT,
        owner_pid INTEGER,
        owner_boot_id TEXT,
        owner_start_ticks TEXT,
        provider_launch_attempted INTEGER NOT NULL DEFAULT 0 CHECK(provider_launch_attempted IN (0, 1)),
        provider_session_uuid TEXT,
        verdict_json TEXT,
        error TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        UNIQUE(rollout_id, review_kind, reviewed_digest, identity_digest)
      );

      CREATE TABLE IF NOT EXISTS deployment_activation_generations (
        id TEXT PRIMARY KEY,
        rollout_id TEXT NOT NULL REFERENCES deployment_rollouts(id),
        target TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('canary', 'production')),
        status TEXT NOT NULL CHECK(status IN ('pending', 'exposed', 'revoked')),
        capabilities_json TEXT NOT NULL,
        identity_digest TEXT NOT NULL,
        evidence_digest TEXT,
        bot_acknowledged_at DATETIME,
        coordinator_acknowledged_at DATETIME,
        exposed_at DATETIME,
        revoked_at DATETIME,
        revocation_reason TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(rollout_id, kind, identity_digest, evidence_digest)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS deployment_activation_one_unsettled
        ON deployment_activation_generations(target) WHERE status IN ('pending', 'exposed');

      CREATE TABLE IF NOT EXISTS deployment_coordinator_handoffs (
        generation_id TEXT PRIMARY KEY REFERENCES deployment_activation_generations(id),
        rollout_id TEXT NOT NULL REFERENCES deployment_rollouts(id),
        target TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN (
          'prepared', 'start_requested', 'acknowledged', 'probation', 'promoted',
          'revocation_requested', 'recovered', 'ambiguous'
        )),
        candidate_slot TEXT NOT NULL CHECK(candidate_slot IN ('a', 'b')),
        candidate_version TEXT NOT NULL,
        candidate_unit TEXT NOT NULL,
        candidate_invocation_id TEXT,
        candidate_pid INTEGER,
        candidate_boot_id TEXT,
        candidate_start_ticks TEXT,
        incumbent_slot TEXT CHECK(incumbent_slot IN ('legacy', 'a', 'b')),
        incumbent_version TEXT,
        incumbent_unit TEXT,
        incumbent_was_active INTEGER NOT NULL CHECK(incumbent_was_active IN (0, 1)),
        candidate_start_requested_at DATETIME,
        candidate_started_at DATETIME,
        incumbent_stop_requested_at DATETIME,
        incumbent_stopped_at DATETIME,
        handshake_at DATETIME,
        heartbeat_at DATETIME,
        reconciliation_digest TEXT,
        probation_started_at DATETIME,
        probation_deadline_at DATETIME,
        promotion_requested_at DATETIME,
        promoted_at DATETIME,
        revocation_requested_at DATETIME,
        recovered_at DATETIME,
        recovery_invocation_id TEXT,
        failure_reason TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS deployment_coordinator_handoffs_one_live_slot
        ON deployment_coordinator_handoffs(candidate_slot)
        WHERE status IN ('prepared', 'start_requested', 'acknowledged', 'probation');

      CREATE TABLE IF NOT EXISTS deployment_rollout_gates (
        rollout_id TEXT PRIMARY KEY REFERENCES deployment_rollouts(id),
        target TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN (
          'prepared', 'holding', 'held', 'release_requested', 'released', 'ambiguous'
        )),
        deployment_token TEXT NOT NULL,
        capture_token TEXT NOT NULL,
        owner_pid INTEGER NOT NULL,
        owner_boot_id TEXT NOT NULL,
        owner_start_ticks TEXT NOT NULL,
        deployment_held_at DATETIME,
        capture_held_at DATETIME,
        held_at DATETIME,
        release_requested_at DATETIME,
        released_at DATETIME,
        error TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS deployment_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        target TEXT NOT NULL,
        entity_kind TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        event TEXT NOT NULL,
        detail_json TEXT NOT NULL DEFAULT '{}',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    for (const table of ["deployment_repair_runs", "deployment_review_runs"]) {
      const columns = this.database.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "provider_launch_attempted")) {
        this.database.exec(`ALTER TABLE ${table} ADD COLUMN provider_launch_attempted INTEGER NOT NULL DEFAULT 0
          CHECK(provider_launch_attempted IN (0, 1))`);
      }
    }
    const repairColumns = new Set(
      (this.database.query("PRAGMA table_info(deployment_repair_runs)").all() as Array<{ name: string }>)
        .map((column) => column.name),
    );
    if (!repairColumns.has("pending_provider_capability_digest")) {
      this.database.exec("ALTER TABLE deployment_repair_runs ADD COLUMN pending_provider_capability_digest TEXT");
    }
    if (!repairColumns.has("pending_capability_expires_at_ms")) {
      this.database.exec("ALTER TABLE deployment_repair_runs ADD COLUMN pending_capability_expires_at_ms INTEGER");
    }
  }

  private event(target: string, entityKind: string, entityId: string, event: string, detail: Record<string, unknown> = {}) {
    this.database.query(`INSERT INTO deployment_events
      (target, entity_kind, entity_id, event, detail_json) VALUES (?, ?, ?, ?, ?)`)
      .run(target, entityKind, entityId, event, JSON.stringify(detail));
  }

  beginCommand(input: {
    idempotencyKey: string;
    callerRole: string;
    commandKind: string;
    requestDigest: string;
  }): { disposition: "apply" | "replay" | "ambiguous"; response?: unknown } {
    requireNonEmpty(input.idempotencyKey, "idempotency key");
    requireNonEmpty(input.callerRole, "caller role");
    requireNonEmpty(input.commandKind, "command kind");
    assertDigest(input.requestDigest, "request digest");
    return this.database.transaction(() => {
      const existing = this.database.query("SELECT * FROM deployment_commands WHERE idempotency_key=?")
        .get(input.idempotencyKey) as any;
      if (existing) {
        if (existing.caller_role !== input.callerRole
          || existing.command_kind !== input.commandKind
          || existing.request_digest !== input.requestDigest) {
          throw new Error(`Idempotency key ${input.idempotencyKey} was reused for a different command.`);
        }
        if (existing.status === "applied" || existing.status === "rejected") {
          return { disposition: "replay", response: JSON.parse(existing.response_json) };
        }
        return { disposition: "ambiguous" };
      }
      this.database.query(`INSERT INTO deployment_commands
        (idempotency_key, caller_role, command_kind, request_digest, status)
        VALUES (?, ?, ?, ?, 'applying')`).run(
        input.idempotencyKey,
        input.callerRole,
        input.commandKind,
        input.requestDigest.toLowerCase(),
      );
      return { disposition: "apply" };
    })();
  }

  finishCommand(idempotencyKey: string, response: unknown, outcome: "applied" | "rejected" = "applied") {
    const updated = this.database.query(`UPDATE deployment_commands SET status=?, response_json=?,
      updated_at=CURRENT_TIMESTAMP WHERE idempotency_key=? AND status='applying'`)
      .run(outcome, JSON.stringify(response), idempotencyKey);
    if (updated.changes !== 1) throw new Error(`Command ${idempotencyKey} is no longer applying.`);
  }

  markCommandAmbiguous(idempotencyKey: string, error: string) {
    const response = { ok: false, ambiguous: true, error };
    this.database.query(`UPDATE deployment_commands SET status='ambiguous', response_json=?,
      updated_at=CURRENT_TIMESTAMP WHERE idempotency_key=? AND status='applying'`)
      .run(JSON.stringify(response), idempotencyKey);
    return response;
  }

  getRollout(id: string) {
    return this.database.query("SELECT * FROM deployment_rollouts WHERE id=?")
      .get(id) as DeploymentRolloutRow | null;
  }

  getActiveRollout(target = "concierge") {
    return this.database.query(`SELECT * FROM deployment_rollouts
      WHERE target=? AND status NOT IN ('verified', 'parked') ORDER BY created_at, id LIMIT 1`)
      .get(target) as DeploymentRolloutRow | null;
  }

  getLatestRollout(target = "concierge") {
    return this.database.query(`SELECT * FROM deployment_rollouts
      WHERE target=? ORDER BY created_at DESC, id DESC LIMIT 1`)
      .get(target) as DeploymentRolloutRow | null;
  }

  createRollout(input: {
    id: string;
    target?: string;
    ownerUnit: string;
    identityDigest: string;
    nextStep: string;
  }) {
    requireNonEmpty(input.id, "rollout ID");
    requireNonEmpty(input.ownerUnit, "rollout owner unit");
    requireNonEmpty(input.nextStep, "rollout next step");
    assertDigest(input.identityDigest, "rollout identity digest");
    const target = input.target || "concierge";
    return this.database.transaction(() => {
      const existing = this.getRollout(input.id);
      if (existing) {
        if (existing.target !== target
          || existing.owner_unit !== input.ownerUnit
          || existing.identity_digest !== input.identityDigest.toLowerCase()) {
          throw new Error(`Rollout ${input.id} already exists with different authority.`);
        }
        return existing;
      }
      const active = this.getActiveRollout(target);
      if (active) throw new Error(`Target ${target} already has active rollout ${active.id}.`);
      this.database.query(`INSERT INTO deployment_rollouts
        (id, target, status, next_step, owner_unit, identity_digest)
        VALUES (?, ?, 'staged', ?, ?, ?)`).run(
        input.id,
        target,
        input.nextStep,
        input.ownerUnit,
        input.identityDigest.toLowerCase(),
      );
      this.event(target, "rollout", input.id, "rollout_staged", {
        owner_unit: input.ownerUnit,
        identity_digest: input.identityDigest.toLowerCase(),
        next_step: input.nextStep,
      });
      return this.getRollout(input.id)!;
    })();
  }

  claimRolloutLease(input: {
    rolloutId: string;
    ownerUnit: string;
    invocationId: string;
    pid: number;
    bootId: string;
    startTicks: string;
    priorOwnerProvenDead?: boolean;
  }) {
    requireNonEmpty(input.ownerUnit, "rollout owner unit");
    requireNonEmpty(input.invocationId, "rollout invocation ID");
    requireNonEmpty(input.bootId, "rollout boot ID");
    requireNonEmpty(input.startTicks, "rollout process start ticks");
    if (!Number.isSafeInteger(input.pid) || input.pid <= 1) throw new Error("rollout owner PID is invalid.");
    return this.database.transaction(() => {
      const rollout = this.getRollout(input.rolloutId);
      if (!rollout) throw new Error(`Unknown rollout ${input.rolloutId}.`);
      if (["verified", "parked"].includes(rollout.status)) {
        throw new Error(`Rollout ${rollout.id} cannot be claimed from ${rollout.status}.`);
      }
      if (rollout.owner_unit !== input.ownerUnit) {
        throw new Error(`Rollout ${rollout.id} belongs to ${rollout.owner_unit}, not ${input.ownerUnit}.`);
      }
      const sameOwner = rollout.owner_invocation_id === input.invocationId
        && rollout.owner_pid === input.pid
        && rollout.owner_boot_id === input.bootId
        && rollout.owner_start_ticks === input.startTicks;
      if (sameOwner) return rollout;
      if (rollout.owner_invocation_id && !input.priorOwnerProvenDead) {
        throw new Error(`Rollout ${rollout.id} already has a live or unproven owner.`);
      }
      this.database.query(`UPDATE deployment_rollouts SET owner_invocation_id=?, owner_pid=?,
        owner_boot_id=?, owner_start_ticks=?, lease_heartbeat_at=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(
        input.invocationId,
        input.pid,
        input.bootId,
        input.startTicks,
        rollout.id,
      );
      this.event(rollout.target, "rollout", rollout.id,
        rollout.owner_invocation_id ? "rollout_owner_recovered" : "rollout_owner_claimed", {
          invocation_id: input.invocationId,
          pid: input.pid,
          boot_id: input.bootId,
          start_ticks: input.startTicks,
        });
      return this.getRollout(rollout.id)!;
    })();
  }

  private requireRolloutLease(input: {
    rolloutId: string;
    invocationId: string;
    pid: number;
    bootId: string;
    startTicks: string;
    identityDigest: string;
  }) {
    const rollout = this.getRollout(input.rolloutId);
    if (!rollout) throw new Error(`Unknown rollout ${input.rolloutId}.`);
    assertDigest(input.identityDigest, "rollout identity digest");
    if (rollout.identity_digest !== input.identityDigest.toLowerCase()) {
      throw new Error(`Rollout ${rollout.id} installed identity drifted.`);
    }
    if (rollout.owner_invocation_id !== input.invocationId
      || rollout.owner_pid !== input.pid
      || rollout.owner_boot_id !== input.bootId
      || rollout.owner_start_ticks !== input.startTicks) {
      throw new Error(`Rollout ${rollout.id} owner lease does not match.`);
    }
    return rollout;
  }

  heartbeatRollout(input: {
    rolloutId: string;
    invocationId: string;
    pid: number;
    bootId: string;
    startTicks: string;
    identityDigest: string;
  }) {
    return this.database.transaction(() => {
      const rollout = this.requireRolloutLease(input);
      this.database.query(`UPDATE deployment_rollouts SET lease_heartbeat_at=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(rollout.id);
      return this.getRollout(rollout.id)!;
    })();
  }

  getRolloutGates(rolloutId: string) {
    return this.database.query("SELECT * FROM deployment_rollout_gates WHERE rollout_id=?")
      .get(rolloutId) as DeploymentRolloutGateRow | null;
  }

  prepareRolloutGates(input: {
    rolloutId: string;
    deploymentToken: string;
    captureToken: string;
    gateOwner: { pid: number; bootId: string; startTicks: string };
    invocationId: string;
    pid: number;
    bootId: string;
    startTicks: string;
    identityDigest: string;
  }) {
    requireNonEmpty(input.deploymentToken, "deployment gate token");
    requireNonEmpty(input.captureToken, "capture gate token");
    return this.database.transaction(() => {
      const rollout = this.requireRolloutLease(input);
      if (!new Set<RolloutStatus>(["containing_application", "staging_coordinator", "authorized",
        "canary_activating", "canary_probation", "recovery_proving", "evidence_review_pending",
        "production_authorized", "production_activating", "production_probation", "revoking"])
        .has(rollout.status)) {
        throw new Error(`Rollout ${rollout.id} cannot hold admission from ${rollout.status}.`);
      }
      const existing = this.getRolloutGates(rollout.id);
      if (existing) return existing;
      this.database.query(`INSERT INTO deployment_rollout_gates
        (rollout_id, target, status, deployment_token, capture_token,
         owner_pid, owner_boot_id, owner_start_ticks)
        VALUES (?, ?, 'prepared', ?, ?, ?, ?, ?)`).run(
        rollout.id,
        rollout.target,
        input.deploymentToken,
        input.captureToken,
        input.gateOwner.pid,
        input.gateOwner.bootId,
        input.gateOwner.startTicks,
      );
      this.event(rollout.target, "rollout", rollout.id, "rollout_admission_hold_prepared");
      return this.getRolloutGates(rollout.id)!;
    })();
  }

  markRolloutGatesHolding(rolloutId: string) {
    this.database.query(`UPDATE deployment_rollout_gates SET status='holding',
      updated_at=CURRENT_TIMESTAMP WHERE rollout_id=? AND status IN ('prepared', 'holding')`).run(rolloutId);
    return this.getRolloutGates(rolloutId)!;
  }

  markRolloutGatePartHeld(rolloutId: string, part: "deployment" | "capture") {
    const column = part === "deployment" ? "deployment_held_at" : "capture_held_at";
    this.database.query(`UPDATE deployment_rollout_gates SET ${column}=COALESCE(${column}, CURRENT_TIMESTAMP),
      updated_at=CURRENT_TIMESTAMP WHERE rollout_id=? AND status='holding'`).run(rolloutId);
    const gate = this.getRolloutGates(rolloutId);
    if (!gate) throw new Error(`Unknown rollout gates ${rolloutId}.`);
    if (gate.deployment_held_at && gate.capture_held_at) {
      this.database.query(`UPDATE deployment_rollout_gates SET status='held', held_at=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP WHERE rollout_id=? AND status='holding'`).run(rolloutId);
      this.event(gate.target, "rollout", rolloutId, "rollout_admission_held");
    }
    return this.getRolloutGates(rolloutId)!;
  }

  requestRolloutGateRelease(input: {
    rolloutId: string;
    invocationId: string;
    pid: number;
    bootId: string;
    startTicks: string;
    identityDigest: string;
  }) {
    return this.database.transaction(() => {
      const rollout = this.requireRolloutLease(input);
      if (rollout.status !== "verified" && rollout.status !== "parked") {
        throw new Error(`Rollout ${rollout.id} cannot release admission from ${rollout.status}.`);
      }
      const gate = this.getRolloutGates(rollout.id);
      if (!gate) throw new Error(`Rollout ${rollout.id} has no admission hold to release.`);
      if (gate.status === "released") return gate;
      if (gate.status !== "held" && gate.status !== "release_requested") {
        throw new Error(`Rollout ${rollout.id} gates cannot release from ${gate.status}.`);
      }
      this.database.query(`UPDATE deployment_rollout_gates SET status='release_requested',
        release_requested_at=COALESCE(release_requested_at, CURRENT_TIMESTAMP),
        updated_at=CURRENT_TIMESTAMP WHERE rollout_id=?`).run(rollout.id);
      this.event(rollout.target, "rollout", rollout.id, "rollout_admission_release_requested");
      return this.getRolloutGates(rollout.id)!;
    })();
  }

  settleRolloutGateRelease(rolloutId: string) {
    const gate = this.getRolloutGates(rolloutId);
    if (!gate || gate.status !== "release_requested") {
      throw new Error(`Rollout ${rolloutId} gate release was not durably requested.`);
    }
    this.database.query(`UPDATE deployment_rollout_gates SET status='released',
      released_at=CURRENT_TIMESTAMP, error=NULL, updated_at=CURRENT_TIMESTAMP WHERE rollout_id=?`).run(rolloutId);
    this.event(gate.target, "rollout", rolloutId, "rollout_admission_released");
    return this.getRolloutGates(rolloutId)!;
  }

  markRolloutGatesAmbiguous(rolloutId: string, error: string) {
    requireNonEmpty(error, "rollout admission ambiguity");
    this.database.query(`UPDATE deployment_rollout_gates SET status='ambiguous', error=?,
      updated_at=CURRENT_TIMESTAMP WHERE rollout_id=?`).run(error, rolloutId);
    const gate = this.getRolloutGates(rolloutId);
    if (!gate) throw new Error(`Unknown rollout gates ${rolloutId}.`);
    this.event(gate.target, "rollout", rolloutId, "rollout_admission_ambiguous", { error });
    return gate;
  }

  transitionRollout(input: {
    rolloutId: string;
    expectedStatus: RolloutStatus;
    status: RolloutStatus;
    nextStep: string;
    invocationId: string;
    pid: number;
    bootId: string;
    startTicks: string;
    identityDigest: string;
    error?: string | null;
  }) {
    requireNonEmpty(input.nextStep, "rollout next step");
    if (!(input.status in ROLLOUT_TRANSITIONS)) throw new Error(`Unknown rollout status ${input.status}.`);
    return this.database.transaction(() => {
      const rollout = this.requireRolloutLease(input);
      if (rollout.status !== input.expectedStatus) {
        throw new Error(`Rollout ${rollout.id} expected ${input.expectedStatus}, found ${rollout.status}.`);
      }
      if (!["containing_application", "staging_coordinator", "proving", "review_pending",
        "recovery_proving", "evidence_review_pending", "revoking", "staged", "parked"].includes(input.status)) {
        throw new Error(`Rollout status ${input.status} is owned by a guarded review or activation transition.`);
      }
      if (!ROLLOUT_TRANSITIONS[rollout.status].includes(input.status)) {
        throw new Error(`Rollout ${rollout.id} cannot transition from ${rollout.status} to ${input.status}.`);
      }
      this.database.query(`UPDATE deployment_rollouts SET status=?, next_step=?, error=?,
        completed_at=CASE WHEN ?='parked' THEN CURRENT_TIMESTAMP ELSE NULL END,
        lease_heartbeat_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(
        input.status,
        input.nextStep,
        input.error || null,
        input.status,
        rollout.id,
      );
      this.event(rollout.target, "rollout", rollout.id, `rollout_${input.status}`, {
        prior_status: rollout.status,
        next_step: input.nextStep,
        ...(input.error ? { error: input.error } : {}),
      });
      return this.getRollout(rollout.id)!;
    })();
  }

  getRolloutCheck(rolloutId: string, name: string) {
    return this.database.query(`SELECT * FROM deployment_rollout_checks
      WHERE rollout_id=? AND name=?`).get(rolloutId, name) as DeploymentRolloutCheckRow | null;
  }

  listRolloutChecks(rolloutId: string) {
    return this.database.query(`SELECT * FROM deployment_rollout_checks
      WHERE rollout_id=? ORDER BY created_at, name`).all(rolloutId) as DeploymentRolloutCheckRow[];
  }

  recordRolloutCheck(input: {
    rolloutId: string;
    name: string;
    phase: string;
    status: RolloutCheckStatus;
    evidenceDigest?: string | null;
    evidence?: Record<string, unknown> | null;
    error?: string | null;
    invocationId: string;
    pid: number;
    bootId: string;
    startTicks: string;
    identityDigest: string;
  }) {
    requireNonEmpty(input.name, "rollout check name");
    requireNonEmpty(input.phase, "rollout check phase");
    if (!new Set<RolloutCheckStatus>(["prepared", "running", "passed", "failed", "ambiguous"]).has(input.status)) {
      throw new Error(`Unknown rollout check status ${input.status}.`);
    }
    if (input.evidenceDigest) assertDigest(input.evidenceDigest, "rollout check evidence digest");
    if (input.status === "passed" && !input.evidence) throw new Error("A passed rollout check requires bounded evidence.");
    return this.database.transaction(() => {
      const rollout = this.requireRolloutLease(input);
      const requiredPhase = {
        proving: "preactivation",
        canary_probation: "canary",
        recovery_proving: "recovery",
        production_probation: "production",
      }[rollout.status];
      if (!requiredPhase || input.phase !== requiredPhase) {
        throw new Error(`Rollout check phase ${input.phase} is not valid while rollout ${rollout.id} is ${rollout.status}.`);
      }
      const evidenceJson = input.evidence ? canonicalJson(input.evidence) : null;
      const computedEvidenceDigest = input.evidence
        ? evidenceDigest(input.name, input.phase, input.evidence)
        : null;
      if (input.evidenceDigest && input.evidenceDigest.toLowerCase() !== computedEvidenceDigest) {
        throw new Error(`Rollout check ${input.name} evidence digest was not computed by the kernel.`);
      }
      const existing = this.getRolloutCheck(rollout.id, input.name);
      if (existing && ["passed", "failed", "ambiguous"].includes(existing.status)) {
        if (existing.status === input.status
          && existing.evidence_digest === computedEvidenceDigest
          && existing.evidence_json === evidenceJson
          && existing.error === (input.error || null)) return existing;
        throw new Error(`Rollout check ${input.name} is already terminal.`);
      }
      if (existing?.phase !== undefined && existing.phase !== input.phase) {
        throw new Error(`Rollout check ${input.name} phase is immutable.`);
      }
      const allowedNext = existing?.status === "prepared"
        ? new Set<RolloutCheckStatus>(["prepared", "running", "passed", "failed", "ambiguous"])
        : existing?.status === "running"
          ? new Set<RolloutCheckStatus>(["running", "passed", "failed", "ambiguous"])
          : new Set<RolloutCheckStatus>(["prepared", "running", "passed", "failed", "ambiguous"]);
      if (!allowedNext.has(input.status)) {
        throw new Error(`Rollout check ${input.name} cannot transition ${existing?.status} -> ${input.status}.`);
      }
      this.database.query(`INSERT INTO deployment_rollout_checks
        (rollout_id, name, phase, status, evidence_digest, evidence_json, error, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, CASE WHEN ? IN ('passed', 'failed', 'ambiguous') THEN CURRENT_TIMESTAMP ELSE NULL END)
        ON CONFLICT(rollout_id, name) DO UPDATE SET status=excluded.status,
          evidence_digest=excluded.evidence_digest, evidence_json=excluded.evidence_json,
          error=excluded.error, completed_at=excluded.completed_at, updated_at=CURRENT_TIMESTAMP`).run(
        rollout.id,
        input.name,
        input.phase,
        input.status,
        computedEvidenceDigest,
        evidenceJson,
        input.error || null,
        input.status,
      );
      this.event(rollout.target, "rollout_check", `${rollout.id}:${input.name}`, `check_${input.status}`, {
        phase: input.phase,
        evidence_digest: computedEvidenceDigest,
      });
      return this.getRolloutCheck(rollout.id, input.name)!;
    })();
  }

  getRolloutReviewRequest(id: string) {
    return this.database.query("SELECT * FROM deployment_rollout_review_requests WHERE id=?")
      .get(id) as DeploymentRolloutReviewRequestRow | null;
  }

  getCurrentRolloutReviewRequest(rolloutId: string, reviewKind: RolloutReviewKind) {
    return this.database.query(`SELECT * FROM deployment_rollout_review_requests
      WHERE rollout_id=? AND review_kind=? ORDER BY created_at DESC, id DESC LIMIT 1`)
      .get(rolloutId, reviewKind) as DeploymentRolloutReviewRequestRow | null;
  }

  prepareRolloutReviewRequest(input: {
    rolloutId: string;
    reviewKind: RolloutReviewKind;
    invocationId: string;
    pid: number;
    bootId: string;
    startTicks: string;
    identityDigest: string;
  }) {
    return this.database.transaction(() => {
      const rollout = this.requireRolloutLease(input);
      const requiredStatus = input.reviewKind === "implementation" ? "review_pending" : "evidence_review_pending";
      if (rollout.status !== requiredStatus) {
        throw new Error(`${input.reviewKind} review request requires rollout ${requiredStatus}, found ${rollout.status}.`);
      }
      const reviewedDigest = input.reviewKind === "implementation" ? rollout.identity_digest : rollout.evidence_digest;
      if (!reviewedDigest) throw new Error(`${input.reviewKind} review has no frozen authority digest.`);
      const existing = this.getCurrentRolloutReviewRequest(rollout.id, input.reviewKind);
      if (existing && existing.reviewed_digest === reviewedDigest
        && existing.identity_digest === rollout.identity_digest) return existing;
      const id = randomUUID();
      const workerUnit = `concierge-deployment-review@${id}.service`;
      this.database.query(`INSERT INTO deployment_rollout_review_requests
        (id, rollout_id, review_kind, status, reviewed_digest, identity_digest, worker_unit)
        VALUES (?, ?, ?, 'prepared', ?, ?, ?)`).run(
        id,
        rollout.id,
        input.reviewKind,
        reviewedDigest,
        rollout.identity_digest,
        workerUnit,
      );
      this.event(rollout.target, "rollout_review_request", id, "rollout_review_prepared", {
        rollout_id: rollout.id,
        review_kind: input.reviewKind,
        reviewed_digest: reviewedDigest,
        worker_unit: workerUnit,
      });
      return this.getRolloutReviewRequest(id)!;
    })();
  }

  claimRolloutReviewRequest(input: {
    requestId: string;
    invocationId: string;
    pid: number;
    bootId: string;
    startTicks: string;
  }) {
    return this.database.transaction(() => {
      const request = this.getRolloutReviewRequest(input.requestId);
      if (!request) throw new Error(`Unknown rollout review request ${input.requestId}.`);
      const sameOwner = request.owner_invocation_id === input.invocationId
        && request.owner_pid === input.pid
        && request.owner_boot_id === input.bootId
        && request.owner_start_ticks === input.startTicks;
      if (request.status === "running" && sameOwner) return request;
      if (request.status !== "prepared" || request.owner_invocation_id) {
        throw new Error(`Rollout review request ${request.id} cannot be claimed from ${request.status}.`);
      }
      this.database.query(`UPDATE deployment_rollout_review_requests SET status='running',
        owner_invocation_id=?, owner_pid=?, owner_boot_id=?, owner_start_ticks=?,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(
        input.invocationId,
        input.pid,
        input.bootId,
        input.startTicks,
        request.id,
      );
      this.event("concierge", "rollout_review_request", request.id, "rollout_review_claimed", {
        worker_unit: request.worker_unit,
        owner_invocation_id: input.invocationId,
      });
      return this.getRolloutReviewRequest(request.id)!;
    })();
  }

  private requireRolloutReviewOwner(input: {
    requestId: string;
    invocationId: string;
    pid: number;
    bootId: string;
    startTicks: string;
  }) {
    const request = this.getRolloutReviewRequest(input.requestId);
    if (!request) throw new Error(`Unknown rollout review request ${input.requestId}.`);
    if (request.status !== "running"
      || request.owner_invocation_id !== input.invocationId
      || request.owner_pid !== input.pid
      || request.owner_boot_id !== input.bootId
      || request.owner_start_ticks !== input.startTicks) {
      throw new Error(`Rollout review request ${request.id} owner lease does not match.`);
    }
    return request;
  }

  admitRolloutReviewProvider(input: {
    requestId: string;
    invocationId: string;
    pid: number;
    bootId: string;
    startTicks: string;
  }) {
    return this.database.transaction(() => {
      const request = this.requireRolloutReviewOwner(input);
      if (request.provider_launch_attempted) return request;
      this.database.query(`UPDATE deployment_rollout_review_requests SET provider_launch_attempted=1,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(request.id);
      this.event("concierge", "rollout_review_request", request.id, "rollout_review_provider_admitted");
      return this.getRolloutReviewRequest(request.id)!;
    })();
  }

  bindRolloutReviewSession(input: {
    requestId: string;
    providerSessionUuid: string;
    invocationId: string;
    pid: number;
    bootId: string;
    startTicks: string;
  }) {
    requireNonEmpty(input.providerSessionUuid, "rollout reviewer session UUID");
    return this.database.transaction(() => {
      const request = this.requireRolloutReviewOwner(input);
      if (!request.provider_launch_attempted) {
        throw new Error(`Rollout review request ${request.id} has no durable provider launch admission.`);
      }
      if (request.provider_session_uuid && request.provider_session_uuid !== input.providerSessionUuid) {
        throw new Error(`Rollout review request ${request.id} provider session is immutable.`);
      }
      if (!request.provider_session_uuid) {
        this.database.query(`UPDATE deployment_rollout_review_requests SET provider_session_uuid=?,
          updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(input.providerSessionUuid, request.id);
        this.event("concierge", "rollout_review_request", request.id, "rollout_review_session_bound", {
          provider_session_uuid: input.providerSessionUuid,
        });
      }
      return this.getRolloutReviewRequest(request.id)!;
    })();
  }

  getRolloutReview(rolloutId: string, reviewKind: RolloutReviewKind) {
    return this.database.query(`SELECT * FROM deployment_rollout_reviews
      WHERE rollout_id=? AND review_kind=? ORDER BY created_at DESC, id DESC LIMIT 1`)
      .get(rolloutId, reviewKind) as DeploymentRolloutReviewRow | null;
  }

  recordRolloutReview(input: {
    requestId: string;
    verdict: "ship" | "no_ship";
    reviewerSessionUuid: string;
    verdictPayload: Record<string, unknown>;
    invocationId: string;
    pid: number;
    bootId: string;
    startTicks: string;
  }) {
    requireNonEmpty(input.reviewerSessionUuid, "reviewer session UUID");
    return this.database.transaction(() => {
      const request = this.requireRolloutReviewOwner(input);
      if (!request.provider_launch_attempted || request.provider_session_uuid !== input.reviewerSessionUuid) {
        throw new Error(`Rollout review request ${request.id} is not bound to reviewer session ${input.reviewerSessionUuid}.`);
      }
      const rollout = this.getRollout(request.rollout_id);
      if (!rollout) throw new Error(`Unknown rollout ${request.rollout_id}.`);
      const requiredStatus = request.review_kind === "implementation" ? "review_pending" : "evidence_review_pending";
      if (rollout.status !== requiredStatus) {
        throw new Error(`${request.review_kind} review requires rollout ${requiredStatus}, found ${rollout.status}.`);
      }
      if (rollout.identity_digest !== request.identity_digest) {
        throw new Error(`Rollout ${rollout.id} identity changed before review submission.`);
      }
      const expectedDigest = request.review_kind === "implementation" ? rollout.identity_digest : rollout.evidence_digest;
      if (!expectedDigest || expectedDigest !== request.reviewed_digest) {
        throw new Error(`${request.review_kind} review digest does not match the frozen rollout authority.`);
      }
      const existing = this.database.query(`SELECT * FROM deployment_rollout_reviews
        WHERE rollout_id=? AND review_kind=? AND reviewed_digest=? AND identity_digest=?`)
        .get(rollout.id, request.review_kind, request.reviewed_digest, request.identity_digest) as DeploymentRolloutReviewRow | null;
      if (existing) {
        if (existing.status !== input.verdict
          || existing.reviewer_session_uuid !== input.reviewerSessionUuid
          || existing.verdict_json !== canonicalJson(input.verdictPayload)) {
          throw new Error(`Rollout ${request.review_kind} review authority was reused with a different verdict.`);
        }
        return existing;
      }
      const id = randomUUID();
      this.database.query(`INSERT INTO deployment_rollout_reviews
        (id, rollout_id, review_kind, status, reviewed_digest, identity_digest,
         reviewer_session_uuid, verdict_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id,
        rollout.id,
        request.review_kind,
        input.verdict,
        request.reviewed_digest,
        request.identity_digest,
        input.reviewerSessionUuid,
        canonicalJson(input.verdictPayload),
      );
      this.database.query(`UPDATE deployment_rollout_review_requests SET status=?, verdict_json=?,
        completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(
        input.verdict,
        canonicalJson(input.verdictPayload),
        request.id,
      );
      const nextStatus: RolloutStatus = input.verdict === "ship"
        ? (request.review_kind === "implementation" ? "authorized" : "production_authorized")
        : (request.review_kind === "implementation" ? "proving" : "recovery_proving");
      const nextStep = input.verdict === "ship"
        ? (request.review_kind === "implementation" ? "prepare_canary_generation" : "prepare_production_generation")
        : (request.review_kind === "implementation" ? "correct_implementation_evidence" : "correct_live_evidence");
      this.database.query(`UPDATE deployment_rollouts SET status=?, next_step=?, error=?,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(
        nextStatus,
        nextStep,
        input.verdict === "ship" ? null : `${request.review_kind} review returned NO_SHIP`,
        rollout.id,
      );
      this.event(rollout.target, "rollout_review", id, `review_${input.verdict}`, {
        rollout_id: rollout.id,
        review_kind: request.review_kind,
        reviewed_digest: request.reviewed_digest,
        reviewer_session_uuid: input.reviewerSessionUuid,
      });
      return this.getRolloutReview(rollout.id, request.review_kind)!;
    })();
  }

  freezeRolloutEvidence(input: {
    rolloutId: string;
    invocationId: string;
    pid: number;
    bootId: string;
    startTicks: string;
    identityDigest: string;
  }) {
    return this.database.transaction(() => {
      const rollout = this.requireRolloutLease(input);
      if (rollout.status !== "recovery_proving") {
        throw new Error(`Rollout ${rollout.id} cannot freeze live evidence from ${rollout.status}.`);
      }
      const revokedCanary = this.database.query(`SELECT * FROM deployment_activation_generations
        WHERE rollout_id=? AND kind='canary' AND status='revoked'
        ORDER BY created_at DESC, id DESC LIMIT 1`).get(rollout.id) as DeploymentActivationGenerationRow | null;
      const coordinatorRecovery = revokedCanary ? this.getCoordinatorHandoff(revokedCanary.id) : null;
      if (!revokedCanary || coordinatorRecovery?.status !== "recovered") {
        throw new Error("Rollout evidence cannot freeze without proven coordinator incumbent recovery.");
      }
      const checks = this.listRolloutChecks(rollout.id);
      if (!checks.length) throw new Error("Rollout evidence cannot freeze without required checks.");
      if (!checks.some((check) => check.phase === "recovery")) {
        throw new Error("Rollout evidence cannot freeze without post-revocation recovery proof.");
      }
      const unsettled = checks
        .filter((check) => !["passed", "failed", "ambiguous"].includes(check.status));
      if (unsettled.length) throw new Error("Rollout evidence cannot freeze with unsettled checks.");
      const failed = checks.filter((check) => check.status !== "passed");
      if (failed.length) throw new Error("Rollout evidence cannot freeze while any required check is not passed.");
      const evidenceDigest = createHash("sha256").update(canonicalJson({
        rollout_id: rollout.id,
        identity_digest: rollout.identity_digest,
        evidence_epoch: "post_canary_revocation",
        rollout_status: rollout.status,
        checks: checks.map((check) => ({
          name: check.name,
          phase: check.phase,
          status: check.status,
          evidence_digest: check.evidence_digest,
          evidence: check.evidence_json ? JSON.parse(check.evidence_json) : null,
          error: check.error,
        })),
      })).digest("hex");
      this.database.query(`UPDATE deployment_rollouts SET evidence_digest=?,
        status='evidence_review_pending', next_step='launch_live_evidence_review',
        lease_heartbeat_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(
        evidenceDigest,
        rollout.id,
      );
      this.event(rollout.target, "rollout", rollout.id, "rollout_evidence_frozen", {
        evidence_digest: evidenceDigest,
      });
      return this.getRollout(rollout.id)!;
    })();
  }

  getActivationGeneration(id: string) {
    return this.database.query("SELECT * FROM deployment_activation_generations WHERE id=?")
      .get(id) as DeploymentActivationGenerationRow | null;
  }

  getExposedActivation(target = "concierge", kind?: ActivationGenerationKind) {
    return this.database.query(`SELECT * FROM deployment_activation_generations
      WHERE target=? AND status='exposed' ${kind ? "AND kind=?" : ""}
      ORDER BY created_at DESC, id DESC LIMIT 1`).get(...(kind ? [target, kind] : [target])) as DeploymentActivationGenerationRow | null;
  }

  getCurrentActivation(target = "concierge") {
    return this.database.query(`SELECT * FROM deployment_activation_generations
      WHERE target=? AND status IN ('pending', 'exposed') ORDER BY created_at DESC, id DESC LIMIT 1`)
      .get(target) as DeploymentActivationGenerationRow | null;
  }

  prepareActivationGeneration(input: {
    rolloutId: string;
    kind: ActivationGenerationKind;
    coordinator: {
      candidateSlot: "a" | "b";
      candidateVersion: string;
      candidateUnit: string;
      incumbentSlot: CoordinatorSlot | null;
      incumbentVersion: string | null;
      incumbentUnit: string | null;
      incumbentWasActive: boolean;
    };
    invocationId: string;
    pid: number;
    bootId: string;
    startTicks: string;
    identityDigest: string;
  }) {
    assertDigest(input.coordinator.candidateVersion, "coordinator candidate version");
    if (input.coordinator.candidateUnit !== `concierge-deployment-coordinator@${input.coordinator.candidateSlot}.service`) {
      throw new Error("Coordinator candidate unit does not match its A/B slot.");
    }
    if (input.coordinator.incumbentVersion) {
      assertDigest(input.coordinator.incumbentVersion, "coordinator incumbent version");
    }
    return this.database.transaction(() => {
      const rollout = this.requireRolloutLease(input);
      const requiredStatus = input.kind === "canary" ? "authorized" : "production_authorized";
      if (rollout.status !== requiredStatus) {
        throw new Error(`${input.kind} activation requires rollout ${requiredStatus}, found ${rollout.status}.`);
      }
      const reviewKind: RolloutReviewKind = input.kind === "canary" ? "implementation" : "live_evidence";
      const review = this.getRolloutReview(rollout.id, reviewKind);
      const reviewedDigest = input.kind === "canary" ? rollout.identity_digest : rollout.evidence_digest;
      if (!review || review.status !== "ship" || review.reviewed_digest !== reviewedDigest
        || review.identity_digest !== rollout.identity_digest) {
        throw new Error(`${input.kind} activation lacks a matching kernel-owned SHIP review receipt.`);
      }
      const existing = this.database.query(`SELECT * FROM deployment_activation_generations
        WHERE rollout_id=? AND kind=? AND status='pending' ORDER BY created_at DESC, id DESC LIMIT 1`)
        .get(rollout.id, input.kind) as DeploymentActivationGenerationRow | null;
      if (existing) return existing;
      if (this.getExposedActivation(rollout.target)) {
        throw new Error(`Target ${rollout.target} already has an exposed activation generation.`);
      }
      const id = randomUUID();
      const capabilities = input.kind === "canary"
        ? ["rollout_canary"]
        : ["intent_routing", "attempt_reconciliation", "autonomous_repair"];
      this.database.query(`INSERT INTO deployment_activation_generations
        (id, rollout_id, target, kind, status, capabilities_json, identity_digest, evidence_digest)
        VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`).run(
        id,
        rollout.id,
        rollout.target,
        input.kind,
        JSON.stringify(capabilities),
        rollout.identity_digest,
        input.kind === "production" ? rollout.evidence_digest : null,
      );
      this.database.query(`INSERT INTO deployment_coordinator_handoffs
        (generation_id, rollout_id, target, status, candidate_slot, candidate_version,
         candidate_unit, incumbent_slot, incumbent_version, incumbent_unit, incumbent_was_active)
        VALUES (?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?, ?)`).run(
        id,
        rollout.id,
        rollout.target,
        input.coordinator.candidateSlot,
        input.coordinator.candidateVersion.toLowerCase(),
        input.coordinator.candidateUnit,
        input.coordinator.incumbentSlot,
        input.coordinator.incumbentVersion?.toLowerCase() || null,
        input.coordinator.incumbentUnit,
        input.coordinator.incumbentWasActive ? 1 : 0,
      );
      const nextStatus: RolloutStatus = input.kind === "canary" ? "canary_activating" : "production_activating";
      this.database.query(`UPDATE deployment_rollouts SET status=?, next_step='await_activation_acknowledgements',
        lease_heartbeat_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(nextStatus, rollout.id);
      this.event(rollout.target, "activation", id, "activation_prepared", {
        rollout_id: rollout.id,
        kind: input.kind,
        capabilities,
        identity_digest: rollout.identity_digest,
        evidence_digest: input.kind === "production" ? rollout.evidence_digest : null,
        coordinator_candidate_slot: input.coordinator.candidateSlot,
        coordinator_candidate_version: input.coordinator.candidateVersion.toLowerCase(),
        coordinator_incumbent_slot: input.coordinator.incumbentSlot,
      });
      return this.getActivationGeneration(id)!;
    })();
  }

  getCoordinatorHandoff(generationId: string) {
    return this.database.query("SELECT * FROM deployment_coordinator_handoffs WHERE generation_id=?")
      .get(generationId) as DeploymentCoordinatorHandoffRow | null;
  }

  listCoordinatorWatchdogs(target = "concierge") {
    return this.database.query(`SELECT * FROM deployment_coordinator_handoffs
      WHERE target=? AND status IN ('probation', 'promoted', 'revocation_requested', 'ambiguous')
      ORDER BY created_at, generation_id`).all(target) as DeploymentCoordinatorHandoffRow[];
  }

  requestCoordinatorCandidateStart(input: {
    generationId: string;
    rolloutId: string;
    invocationId: string;
    pid: number;
    bootId: string;
    startTicks: string;
    identityDigest: string;
  }) {
    return this.database.transaction(() => {
      const rollout = this.requireRolloutLease(input);
      const generation = this.getActivationGeneration(input.generationId);
      const handoff = this.getCoordinatorHandoff(input.generationId);
      if (!generation || generation.rollout_id !== rollout.id || generation.status !== "pending" || !handoff) {
        throw new Error(`Coordinator candidate ${input.generationId} is not a pending rollout activation.`);
      }
      if (!["prepared", "start_requested"].includes(handoff.status)) {
        return handoff;
      }
      this.database.query(`UPDATE deployment_coordinator_handoffs SET status='start_requested',
        candidate_start_requested_at=COALESCE(candidate_start_requested_at, CURRENT_TIMESTAMP),
        updated_at=CURRENT_TIMESTAMP WHERE generation_id=?`).run(generation.id);
      this.event(generation.target, "activation", generation.id, "coordinator_candidate_start_requested", {
        candidate_slot: handoff.candidate_slot,
        candidate_version: handoff.candidate_version,
        candidate_unit: handoff.candidate_unit,
      });
      return this.getCoordinatorHandoff(generation.id)!;
    })();
  }

  recordCoordinatorCandidateStarted(input: { generationId: string; invocationId: string }) {
    requireNonEmpty(input.invocationId, "coordinator candidate invocation ID");
    return this.database.transaction(() => {
      const generation = this.getActivationGeneration(input.generationId);
      const handoff = this.getCoordinatorHandoff(input.generationId);
      if (!generation || generation.status !== "pending" || !handoff || handoff.status !== "start_requested") {
        throw new Error(`Coordinator candidate ${input.generationId} start is not pending.`);
      }
      this.database.query(`UPDATE deployment_coordinator_handoffs SET candidate_started_at=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP WHERE generation_id=?`).run(generation.id);
      this.event(generation.target, "activation", generation.id, "coordinator_candidate_started", {
        candidate_unit: handoff.candidate_unit,
        observed_invocation_id: input.invocationId,
      });
      return this.getCoordinatorHandoff(generation.id)!;
    })();
  }

  acknowledgeActivation(input: {
    generationId: string;
    role: "bot" | "coordinator";
    identityDigest: string;
    coordinatorOwner?: {
      invocationId: string;
      pid: number;
      bootId: string;
      startTicks: string;
      slot: "a" | "b";
      version: string;
    };
    priorCoordinatorProvenDead?: boolean;
  }) {
    assertDigest(input.identityDigest, "activation identity digest");
    return this.database.transaction(() => {
      const generation = this.getActivationGeneration(input.generationId);
      if (!generation) throw new Error(`Unknown activation generation ${input.generationId}.`);
      const handoff = this.getCoordinatorHandoff(generation.id);
      const promotedRebind = input.role === "coordinator"
        && generation.status === "exposed"
        && handoff?.status === "promoted"
        && input.priorCoordinatorProvenDead;
      if (generation.status !== "pending" && !promotedRebind) {
        throw new Error(`Activation generation ${generation.id} cannot acknowledge from ${generation.status}.`);
      }
      if (generation.identity_digest !== input.identityDigest.toLowerCase()) {
        throw new Error(`Activation generation ${generation.id} identity drifted before acknowledgment.`);
      }
      if (input.role === "coordinator") {
        const coordinator = input.coordinatorOwner;
        if (!handoff || !coordinator) {
          throw new Error(`Activation generation ${generation.id} requires a bound coordinator candidate.`);
        }
        if (!promotedRebind && !["start_requested", "acknowledged"].includes(handoff.status)) {
          throw new Error(`Activation generation ${generation.id} coordinator start was not durably requested.`);
        }
        assertDigest(coordinator.version, "coordinator candidate version");
        if (handoff.candidate_slot !== coordinator.slot
          || handoff.candidate_version !== coordinator.version.toLowerCase()) {
          throw new Error(`Activation generation ${generation.id} coordinator slot or version drifted.`);
        }
        const sameOwner = handoff.candidate_invocation_id === coordinator.invocationId
          && handoff.candidate_pid === coordinator.pid
          && handoff.candidate_boot_id === coordinator.bootId
          && handoff.candidate_start_ticks === coordinator.startTicks;
        if (handoff.candidate_invocation_id && !sameOwner && !promotedRebind) {
          throw new Error(`Activation generation ${generation.id} already belongs to another coordinator process.`);
        }
        this.database.query(`UPDATE deployment_coordinator_handoffs SET status=?,
          candidate_invocation_id=?, candidate_pid=?, candidate_boot_id=?, candidate_start_ticks=?,
          candidate_started_at=COALESCE(candidate_started_at, CURRENT_TIMESTAMP),
          heartbeat_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE generation_id=?`).run(
          promotedRebind ? "promoted" : "acknowledged",
          coordinator.invocationId,
          coordinator.pid,
          coordinator.bootId,
          coordinator.startTicks,
          generation.id,
        );
      }
      const column = input.role === "bot" ? "bot_acknowledged_at" : "coordinator_acknowledged_at";
      this.database.query(`UPDATE deployment_activation_generations SET ${column}=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(generation.id);
      this.event(generation.target, "activation", generation.id,
        promotedRebind ? "coordinator_promoted_process_rebound" : `activation_acknowledged_${input.role}`,
        input.role === "coordinator" ? {
          coordinator_slot: input.coordinatorOwner!.slot,
          coordinator_version: input.coordinatorOwner!.version.toLowerCase(),
          coordinator_invocation_id: input.coordinatorOwner!.invocationId,
        } : {});
      return this.getActivationGeneration(generation.id)!;
    })();
  }

  heartbeatCoordinator(input: {
    generationId: string;
    invocationId: string;
    pid: number;
    bootId: string;
    startTicks: string;
    reconciliationDigest: string;
    handshake: boolean;
  }) {
    assertDigest(input.reconciliationDigest, "coordinator reconciliation digest");
    return this.database.transaction(() => {
      const generation = this.getActivationGeneration(input.generationId);
      const handoff = this.getCoordinatorHandoff(input.generationId);
      if (!generation || !handoff || !["pending", "exposed"].includes(generation.status)) {
        throw new Error(`Coordinator generation ${input.generationId} is not current.`);
      }
      if (handoff.candidate_invocation_id !== input.invocationId
        || handoff.candidate_pid !== input.pid
        || handoff.candidate_boot_id !== input.bootId
        || handoff.candidate_start_ticks !== input.startTicks) {
        throw new Error(`Coordinator generation ${generation.id} heartbeat owner does not match.`);
      }
      if (input.handshake && generation.status !== "exposed") {
        throw new Error(`Coordinator generation ${generation.id} cannot handshake before exposure.`);
      }
      this.database.query(`UPDATE deployment_coordinator_handoffs SET heartbeat_at=CURRENT_TIMESTAMP,
        handshake_at=CASE WHEN ? THEN COALESCE(handshake_at, CURRENT_TIMESTAMP) ELSE handshake_at END,
        reconciliation_digest=?, updated_at=CURRENT_TIMESTAMP WHERE generation_id=?`).run(
        input.handshake ? 1 : 0,
        input.reconciliationDigest.toLowerCase(),
        generation.id,
      );
      this.event(generation.target, "activation", generation.id,
        input.handshake ? "coordinator_handshake" : "coordinator_heartbeat", {
          coordinator_invocation_id: input.invocationId,
          reconciliation_digest: input.reconciliationDigest.toLowerCase(),
        });
      return this.getCoordinatorHandoff(generation.id)!;
    })();
  }

  exposeActivationGeneration(input: {
    generationId: string;
    rolloutId: string;
    invocationId: string;
    pid: number;
    bootId: string;
    startTicks: string;
    identityDigest: string;
    probationSeconds?: number;
  }) {
    return this.database.transaction(() => {
      const rollout = this.requireRolloutLease(input);
      const generation = this.getActivationGeneration(input.generationId);
      if (!generation || generation.rollout_id !== rollout.id) {
        throw new Error(`Activation generation ${input.generationId} does not belong to rollout ${rollout.id}.`);
      }
      if (generation.status !== "pending") {
        throw new Error(`Activation generation ${generation.id} cannot expose from ${generation.status}.`);
      }
      const requiredStatus = generation.kind === "canary" ? "canary_activating" : "production_activating";
      if (rollout.status !== requiredStatus) {
        throw new Error(`Rollout ${rollout.id} cannot expose ${generation.kind} from ${rollout.status}.`);
      }
      if (!generation.bot_acknowledged_at || !generation.coordinator_acknowledged_at) {
        throw new Error(`Activation generation ${generation.id} requires bot and coordinator acknowledgments.`);
      }
      const handoff = this.getCoordinatorHandoff(generation.id);
      if (!handoff || handoff.status !== "acknowledged" || !handoff.candidate_invocation_id
        || !handoff.candidate_started_at) {
        throw new Error(`Activation generation ${generation.id} requires one started, acknowledged coordinator candidate.`);
      }
      if (generation.identity_digest !== rollout.identity_digest
        || (generation.kind === "production" && generation.evidence_digest !== rollout.evidence_digest)) {
        throw new Error(`Activation generation ${generation.id} authority drifted before exposure.`);
      }
      this.database.query(`UPDATE deployment_activation_generations SET status='exposed',
        exposed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(generation.id);
      const probationSeconds = input.probationSeconds ?? 30;
      if (!Number.isSafeInteger(probationSeconds) || probationSeconds < 5 || probationSeconds > 3600) {
        throw new Error("Coordinator probation must be between 5 and 3600 seconds.");
      }
      this.database.query(`UPDATE deployment_coordinator_handoffs SET status='probation',
        probation_started_at=CURRENT_TIMESTAMP,
        probation_deadline_at=datetime(CURRENT_TIMESTAMP, ?),
        incumbent_stop_requested_at=CASE WHEN incumbent_was_active=1 THEN CURRENT_TIMESTAMP ELSE NULL END,
        updated_at=CURRENT_TIMESTAMP WHERE generation_id=?`).run(`+${probationSeconds} seconds`, generation.id);
      const nextStatus: RolloutStatus = generation.kind === "canary" ? "canary_probation" : "production_probation";
      const nextStep = generation.kind === "canary" ? "run_canary_and_recovery_proof" : "run_production_probation";
      this.database.query(`UPDATE deployment_rollouts SET status=?, next_step=?,
        lease_heartbeat_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(nextStatus, nextStep, rollout.id);
      this.event(rollout.target, "activation", generation.id, "activation_exposed", { kind: generation.kind });
      return this.getActivationGeneration(generation.id)!;
    })();
  }

  recordCoordinatorIncumbentStopped(input: { generationId: string }) {
    return this.database.transaction(() => {
      const generation = this.getActivationGeneration(input.generationId);
      const handoff = this.getCoordinatorHandoff(input.generationId);
      if (!generation || generation.status !== "exposed" || !handoff || handoff.status !== "probation") {
        throw new Error(`Coordinator handoff ${input.generationId} is not in probation.`);
      }
      this.database.query(`UPDATE deployment_coordinator_handoffs SET incumbent_stopped_at=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP WHERE generation_id=?`).run(generation.id);
      this.event(generation.target, "activation", generation.id, "coordinator_incumbent_stopped", {
        incumbent_unit: handoff.incumbent_unit,
      });
      return this.getCoordinatorHandoff(generation.id)!;
    })();
  }

  requestCoordinatorPromotion(input: {
    generationId: string;
    rolloutId: string;
    invocationId: string;
    pid: number;
    bootId: string;
    startTicks: string;
    identityDigest: string;
    now?: Date;
    maximumHeartbeatAgeSeconds?: number;
  }) {
    return this.database.transaction(() => {
      const rollout = this.requireRolloutLease(input);
      const generation = this.getActivationGeneration(input.generationId);
      const handoff = this.getCoordinatorHandoff(input.generationId);
      if (!generation || generation.rollout_id !== rollout.id || generation.kind !== "production"
        || generation.status !== "exposed" || !handoff || handoff.status !== "probation") {
        throw new Error(`Coordinator generation ${input.generationId} is not promotable production probation.`);
      }
      if (!handoff.handshake_at || !handoff.heartbeat_at || !handoff.probation_deadline_at) {
        throw new Error(`Coordinator generation ${generation.id} lacks handshake or heartbeat proof.`);
      }
      const now = input.now || new Date();
      if (now.getTime() < Date.parse(`${handoff.probation_deadline_at.replace(" ", "T")}Z`)) {
        throw new Error(`Coordinator generation ${generation.id} probation has not completed.`);
      }
      const heartbeatAge = now.getTime() - Date.parse(`${handoff.heartbeat_at.replace(" ", "T")}Z`);
      if (heartbeatAge > (input.maximumHeartbeatAgeSeconds ?? 15) * 1000) {
        throw new Error(`Coordinator generation ${generation.id} heartbeat is stale.`);
      }
      this.database.query(`UPDATE deployment_coordinator_handoffs SET promotion_requested_at=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP WHERE generation_id=?`).run(generation.id);
      this.event(generation.target, "activation", generation.id, "coordinator_promotion_requested", {
        candidate_slot: handoff.candidate_slot,
        candidate_version: handoff.candidate_version,
      });
      return this.getCoordinatorHandoff(generation.id)!;
    })();
  }

  completeCoordinatorPromotion(input: { generationId: string }) {
    return this.database.transaction(() => {
      const generation = this.getActivationGeneration(input.generationId);
      const handoff = this.getCoordinatorHandoff(input.generationId);
      if (!generation || generation.status !== "exposed" || generation.kind !== "production"
        || !handoff || handoff.status !== "probation" || !handoff.promotion_requested_at) {
        throw new Error(`Coordinator generation ${input.generationId} promotion was not durably requested.`);
      }
      this.database.query(`UPDATE deployment_coordinator_handoffs SET status='promoted',
        promoted_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE generation_id=?`).run(generation.id);
      this.event(generation.target, "activation", generation.id, "coordinator_promoted", {
        candidate_slot: handoff.candidate_slot,
        candidate_version: handoff.candidate_version,
        candidate_unit: handoff.candidate_unit,
      });
      return this.getCoordinatorHandoff(generation.id)!;
    })();
  }

  revokeActivationGeneration(input: {
    generationId: string;
    rolloutId: string;
    reason: string;
    invocationId: string;
    pid: number;
    bootId: string;
    startTicks: string;
    identityDigest: string;
  }) {
    requireNonEmpty(input.reason, "activation revocation reason");
    return this.database.transaction(() => {
      const rollout = this.requireRolloutLease(input);
      const generation = this.getActivationGeneration(input.generationId);
      if (!generation || generation.rollout_id !== rollout.id) {
        throw new Error(`Activation generation ${input.generationId} does not belong to rollout ${rollout.id}.`);
      }
      if (generation.status === "revoked") return generation;
      this.database.query(`UPDATE deployment_activation_generations SET status='revoked',
        revoked_at=CURRENT_TIMESTAMP, revocation_reason=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(input.reason, generation.id);
      this.database.query(`UPDATE deployment_coordinator_handoffs SET status='revocation_requested',
        revocation_requested_at=COALESCE(revocation_requested_at, CURRENT_TIMESTAMP),
        failure_reason=?, updated_at=CURRENT_TIMESTAMP WHERE generation_id=?`).run(
        input.reason,
        generation.id,
      );
      const expectedCanary = generation.kind === "canary" && rollout.status === "canary_probation";
      const nextStatus: RolloutStatus = expectedCanary ? "recovery_proving" : "revoking";
      const nextStep = expectedCanary ? "prove_recovery_and_freeze_evidence" : "restore_last_known_good_and_park_or_stage";
      this.database.query(`UPDATE deployment_rollouts SET status=?, next_step=?, error=?,
        lease_heartbeat_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(
        nextStatus,
        nextStep,
        expectedCanary ? null : input.reason,
        rollout.id,
      );
      this.event(rollout.target, "activation", generation.id, "activation_revoked", {
        kind: generation.kind,
        reason: input.reason,
        rollout_status: nextStatus,
      });
      return this.getActivationGeneration(generation.id)!;
    })();
  }

  revokeActivationByWatchdog(input: { generationId: string; reason: string }) {
    requireNonEmpty(input.reason, "coordinator watchdog revocation reason");
    return this.database.transaction(() => {
      const generation = this.getActivationGeneration(input.generationId);
      const handoff = this.getCoordinatorHandoff(input.generationId);
      if (!generation || !handoff) throw new Error(`Unknown coordinator generation ${input.generationId}.`);
      if (generation.status === "revoked") return generation;
      if (generation.status !== "exposed" || !["probation", "promoted", "ambiguous"].includes(handoff.status)) {
        throw new Error(`Coordinator generation ${generation.id} is not watchdog-revocable.`);
      }
      this.database.query(`UPDATE deployment_activation_generations SET status='revoked',
        revoked_at=CURRENT_TIMESTAMP, revocation_reason=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(
        input.reason,
        generation.id,
      );
      this.database.query(`UPDATE deployment_coordinator_handoffs SET status='revocation_requested',
        revocation_requested_at=COALESCE(revocation_requested_at, CURRENT_TIMESTAMP),
        failure_reason=?, updated_at=CURRENT_TIMESTAMP WHERE generation_id=?`).run(input.reason, generation.id);
      const rollout = this.getRollout(generation.rollout_id);
      if (rollout && !["verified", "parked"].includes(rollout.status)) {
        const expectedCanary = generation.kind === "canary" && rollout.status === "canary_probation";
        this.database.query(`UPDATE deployment_rollouts SET status=?, next_step=?, error=?,
          lease_heartbeat_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(
          expectedCanary ? "recovery_proving" : "revoking",
          expectedCanary ? "prove_recovery_and_freeze_evidence" : "restore_last_known_good_and_park_or_stage",
          expectedCanary ? null : input.reason,
          rollout.id,
        );
      }
      this.event(generation.target, "activation", generation.id, "coordinator_watchdog_revoked", {
        kind: generation.kind,
        reason: input.reason,
      });
      return this.getActivationGeneration(generation.id)!;
    })();
  }

  recordCoordinatorRecovery(input: { generationId: string; recoveryInvocationId: string | null }) {
    return this.database.transaction(() => {
      const generation = this.getActivationGeneration(input.generationId);
      const handoff = this.getCoordinatorHandoff(input.generationId);
      if (!generation || generation.status !== "revoked" || !handoff
        || !["revocation_requested", "ambiguous", "recovered"].includes(handoff.status)) {
        throw new Error(`Coordinator generation ${input.generationId} has no revocation recovery intent.`);
      }
      if (handoff.status === "recovered") {
        if (handoff.recovery_invocation_id !== input.recoveryInvocationId) {
          throw new Error(`Coordinator generation ${generation.id} recovery evidence is immutable.`);
        }
        return handoff;
      }
      if (handoff.incumbent_was_active && !input.recoveryInvocationId) {
        throw new Error(`Coordinator generation ${generation.id} did not recover its active incumbent.`);
      }
      this.database.query(`UPDATE deployment_coordinator_handoffs SET status='recovered',
        recovered_at=CURRENT_TIMESTAMP, recovery_invocation_id=?, updated_at=CURRENT_TIMESTAMP
        WHERE generation_id=?`).run(input.recoveryInvocationId, generation.id);
      this.event(generation.target, "activation", generation.id, "coordinator_incumbent_recovered", {
        incumbent_unit: handoff.incumbent_unit,
        recovery_invocation_id: input.recoveryInvocationId,
      });
      return this.getCoordinatorHandoff(generation.id)!;
    })();
  }

  markCoordinatorHandoffAmbiguous(input: { generationId: string; error: string }) {
    requireNonEmpty(input.error, "coordinator handoff ambiguity");
    return this.database.transaction(() => {
      const handoff = this.getCoordinatorHandoff(input.generationId);
      if (!handoff) throw new Error(`Unknown coordinator generation ${input.generationId}.`);
      this.database.query(`UPDATE deployment_coordinator_handoffs SET status='ambiguous',
        failure_reason=?, updated_at=CURRENT_TIMESTAMP WHERE generation_id=?`).run(input.error, input.generationId);
      this.event(handoff.target, "activation", input.generationId, "coordinator_handoff_ambiguous", {
        error: input.error,
      });
      return this.getCoordinatorHandoff(input.generationId)!;
    })();
  }

  verifyProductionRollout(input: {
    rolloutId: string;
    generationId: string;
    invocationId: string;
    pid: number;
    bootId: string;
    startTicks: string;
    identityDigest: string;
  }) {
    return this.database.transaction(() => {
      const rollout = this.requireRolloutLease(input);
      const generation = this.getActivationGeneration(input.generationId);
      if (rollout.status !== "production_probation"
        || !generation
        || generation.rollout_id !== rollout.id
        || generation.kind !== "production"
        || generation.status !== "exposed"
        || this.getCoordinatorHandoff(generation.id)?.status !== "promoted") {
        throw new Error(`Rollout ${rollout.id} has no exposed production generation in probation.`);
      }
      this.database.query(`UPDATE deployment_rollouts SET status='verified', next_step='monitor',
        error=NULL, completed_at=CURRENT_TIMESTAMP, lease_heartbeat_at=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(rollout.id);
      this.event(rollout.target, "rollout", rollout.id, "rollout_verified", {
        activation_generation_id: generation.id,
      });
      return this.getRollout(rollout.id)!;
    })();
  }

  getIntent(id: string) {
    return this.database.query("SELECT * FROM deployment_intents WHERE id=?")
      .get(id) as DeploymentIntentRow | null;
  }

  listIntents(target: string, statuses?: IntentStatus[]) {
    if (!statuses?.length) {
      return this.database.query("SELECT * FROM deployment_intents WHERE target=? ORDER BY created_at, id")
        .all(target) as DeploymentIntentRow[];
    }
    const placeholders = statuses.map(() => "?").join(", ");
    return this.database.query(`SELECT * FROM deployment_intents
      WHERE target=? AND status IN (${placeholders}) ORDER BY created_at, id`)
      .all(target, ...statuses) as DeploymentIntentRow[];
  }

  parkIntent(intentId: string, error: string) {
    requireNonEmpty(error, "intent park reason");
    return this.database.transaction(() => {
      const intent = this.getIntent(intentId);
      if (!intent) throw new Error(`Unknown intent ${intentId}.`);
      if (["verified", "cancelled"].includes(intent.status)) {
        throw new Error(`Intent ${intentId} cannot be parked from ${intent.status}.`);
      }
      this.database.query(`UPDATE deployment_intents SET status='parked', error=?,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(error, intentId);
      this.event(intent.target, "intent", intent.id, "parked", { error });
      return this.getIntent(intentId)!;
    })();
  }

  requestIntent(input: {
    target?: string;
    expectedCommit: string;
    continuation: ContinuationSnapshot;
  }) {
    assertCommit(input.expectedCommit, "expected commit");
    const target = input.target || "concierge";
    requireNonEmpty(input.continuation.providerSessionUuid, "provider session UUID");
    return this.database.transaction(() => {
      const existing = this.database.query(`SELECT * FROM deployment_intents
        WHERE source_turn_id=? AND expected_commit=?`)
        .get(input.continuation.sourceTurnId, input.expectedCommit.toLowerCase()) as DeploymentIntentRow | null;
      if (existing) return existing;
      const id = randomUUID();
      this.database.query(`INSERT INTO deployment_intents (
        id, target, expected_commit, source_turn_id, source_session_id,
        slack_channel_id, slack_thread_ts, requested_by_user_id, provider_id,
        provider_model, reasoning_effort, provider_session_uuid, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`).run(
        id,
        target,
        input.expectedCommit.toLowerCase(),
        input.continuation.sourceTurnId,
        input.continuation.sourceSessionId,
        input.continuation.slackChannelId,
        input.continuation.slackThreadTs,
        input.continuation.requestedByUserId,
        input.continuation.providerId,
        input.continuation.providerModel,
        input.continuation.reasoningEffort,
        input.continuation.providerSessionUuid,
      );
      this.event(target, "intent", id, "intent_requested", { expected_commit: input.expectedCommit.toLowerCase() });
      return this.getIntent(id)!;
    })();
  }

  getGeneration(id: string) {
    return this.database.query("SELECT * FROM target_generations WHERE id=?")
      .get(id) as TargetGenerationRow | null;
  }

  getActiveGeneration(target = "concierge") {
    return this.database.query(`SELECT * FROM target_generations
      WHERE target=? AND status IN ('prepared', 'active') ORDER BY created_at, id LIMIT 1`)
      .get(target) as TargetGenerationRow | null;
  }

  prepareGeneration(input: {
    target?: string;
    desiredCommit: string;
    originUrl: string;
    originObservedAt: string;
    includedIntentIds: string[];
  }) {
    assertCommit(input.desiredCommit, "desired commit");
    requireNonEmpty(input.originUrl, "origin URL");
    const target = input.target || "concierge";
    return this.database.transaction(() => {
      const active = this.getActiveGeneration(target);
      if (active) {
        if (active.desired_commit !== input.desiredCommit.toLowerCase()) {
          throw new Error(`Target ${target} already has active generation ${active.id}.`);
        }
        return active;
      }
      const intents = input.includedIntentIds.map((id) => this.getIntent(id));
      if (intents.some((intent) => !intent || intent.target !== target || intent.status !== "pending")) {
        throw new Error("A generation may contain only existing pending intents for its target.");
      }
      const id = randomUUID();
      this.database.query(`INSERT INTO target_generations
        (id, target, desired_commit, origin_url, origin_observed_at, status)
        VALUES (?, ?, ?, ?, ?, 'prepared')`).run(
        id,
        target,
        input.desiredCommit.toLowerCase(),
        input.originUrl,
        input.originObservedAt,
      );
      for (const intentId of new Set(input.includedIntentIds)) {
        this.database.query("INSERT INTO generation_intents (generation_id, intent_id) VALUES (?, ?)")
          .run(id, intentId);
      }
      this.event(target, "generation", id, "generation_prepared", {
        desired_commit: input.desiredCommit.toLowerCase(),
        intent_ids: [...new Set(input.includedIntentIds)],
      });
      return this.getGeneration(id)!;
    })();
  }

  attachIntentToGeneration(generationId: string, intentId: string) {
    return this.database.transaction(() => {
      const generation = this.getGeneration(generationId);
      const intent = this.getIntent(intentId);
      if (!generation || !["prepared", "active"].includes(generation.status)) {
        throw new Error(`Generation ${generationId} is not active.`);
      }
      if (!intent || intent.target !== generation.target || intent.status !== "pending") {
        throw new Error(`Intent ${intentId} cannot join generation ${generationId}.`);
      }
      this.database.query(`INSERT INTO generation_intents (generation_id, intent_id)
        VALUES (?, ?) ON CONFLICT DO NOTHING`).run(generationId, intentId);
      this.event(generation.target, "generation", generationId, "intent_joined", { intent_id: intentId });
      return generation;
    })();
  }

  getAttempt(id: string) {
    return this.database.query("SELECT * FROM deployment_attempts WHERE id=?")
      .get(id) as DeploymentAttemptRow | null;
  }

  getActiveAttempt(target = "concierge") {
    return this.database.query(`SELECT * FROM deployment_attempts
      WHERE target=? AND status IN ('prepared', 'draining', 'updating', 'activating', 'verifying', 'releasing')
      ORDER BY created_at, id LIMIT 1`).get(target) as DeploymentAttemptRow | null;
  }

  createAttempt(generationId: string) {
    return this.database.transaction(() => {
      const generation = this.getGeneration(generationId);
      if (!generation || !["prepared", "active"].includes(generation.status)) {
        throw new Error(`Generation ${generationId} cannot start an attempt.`);
      }
      const existing = this.database.query(`SELECT * FROM deployment_attempts
        WHERE generation_id=? AND status IN ('prepared', 'draining', 'updating', 'activating', 'verifying', 'releasing')
        ORDER BY created_at, id LIMIT 1`).get(generationId) as DeploymentAttemptRow | null;
      if (existing) return existing;
      const id = randomUUID();
      this.database.query(`INSERT INTO deployment_attempts
        (id, generation_id, target, status) VALUES (?, ?, ?, 'prepared')`)
        .run(id, generationId, generation.target);
      this.database.query("UPDATE target_generations SET status='active', updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(generationId);
      const intents = this.database.query(`SELECT intent_id FROM generation_intents WHERE generation_id=?`)
        .all(generationId) as Array<{ intent_id: string }>;
      for (const { intent_id } of intents) {
        this.database.query(`INSERT INTO intent_attempt_results (attempt_id, intent_id, result)
          VALUES (?, ?, 'joined')`).run(id, intent_id);
      }
      this.event(generation.target, "attempt", id, "attempt_prepared", { generation_id: generationId });
      return this.getAttempt(id)!;
    })();
  }

  claimAttempt(input: { attemptId: string; pid: number; bootId: string; startTicks: string }) {
    return this.database.transaction(() => {
      const attempt = this.getAttempt(input.attemptId);
      if (!attempt) throw new Error(`Unknown attempt ${input.attemptId}.`);
      if (attempt.status === "draining"
        && attempt.runner_pid === input.pid
        && attempt.runner_boot_id === input.bootId
        && attempt.runner_start_ticks === input.startTicks) return attempt;
      if (attempt.status !== "prepared" || attempt.runner_pid != null) {
        throw new Error(`Attempt ${input.attemptId} cannot be claimed from ${attempt.status}.`);
      }
      this.database.query(`UPDATE deployment_attempts SET status='draining', runner_pid=?,
        runner_boot_id=?, runner_start_ticks=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(input.pid, input.bootId, input.startTicks, input.attemptId);
      this.event(attempt.target, "attempt", attempt.id, "draining", { runner_pid: input.pid });
      return this.getAttempt(attempt.id)!;
    })();
  }

  transitionAttempt(attemptId: string, phase: "updating" | "activating" | "verifying" | "releasing", detail: Record<string, unknown> = {}) {
    return this.database.transaction(() => {
      const attempt = this.getAttempt(attemptId);
      if (!attempt) throw new Error(`Unknown attempt ${attemptId}.`);
      const current = ATTEMPT_PHASES.indexOf(attempt.status);
      const next = ATTEMPT_PHASES.indexOf(phase);
      if (current < 0 || next !== current + 1) {
        throw new Error(`Attempt ${attemptId} cannot transition ${attempt.status} -> ${phase}.`);
      }
      this.database.query("UPDATE deployment_attempts SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(phase, attemptId);
      this.event(attempt.target, "attempt", attemptId, phase, detail);
      return this.getAttempt(attemptId)!;
    })();
  }

  failAttempt(input: {
    attemptId: string;
    outcome: "failed" | "ambiguous";
    error: string;
    failureFingerprint: string;
  }) {
    requireNonEmpty(input.error, "attempt error");
    requireNonEmpty(input.failureFingerprint, "failure fingerprint");
    return this.database.transaction(() => {
      const attempt = this.getAttempt(input.attemptId);
      if (!attempt) throw new Error(`Unknown attempt ${input.attemptId}.`);
      if (["succeeded", "restored"].includes(attempt.status)) {
        throw new Error(`Successful attempt ${input.attemptId} cannot fail.`);
      }
      if (["failed", "ambiguous"].includes(attempt.status)) {
        return { attempt, incident: this.activeIncident(attempt.target) };
      }
      this.database.query(`UPDATE deployment_attempts SET status=?, error=?, completed_at=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(input.outcome, input.error, input.attemptId);
      this.database.query(`UPDATE intent_attempt_results SET result=?, detail=?, updated_at=CURRENT_TIMESTAMP
        WHERE attempt_id=? AND result='joined'`).run(input.outcome, input.error, input.attemptId);
      this.database.query(`UPDATE target_generations SET status=?, completed_at=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(input.outcome, attempt.generation_id);
      this.event(attempt.target, "attempt", attempt.id, input.outcome, {
        error: input.error,
        failure_fingerprint: input.failureFingerprint,
      });
      const incident = this.openOrUpdateIncident(attempt.target, attempt.id, input.failureFingerprint, input.error);
      return { attempt: this.getAttempt(attempt.id)!, incident };
    })();
  }

  markAttemptRestored(input: {
    attemptId: string;
    releaseId: string;
    deployedCommit: string;
    serviceInvocationId: string;
    evidence: Record<string, unknown>;
  }) {
    assertCommit(input.deployedCommit, "restored commit");
    return this.database.transaction(() => {
      const attempt = this.getAttempt(input.attemptId);
      const release = this.getRelease(input.releaseId);
      if (!attempt || !release) throw new Error("Restored attempt and release must exist.");
      if (!new Set(["failed", "ambiguous", "restored"]).has(attempt.status)) {
        throw new Error(`Attempt ${attempt.id} cannot restore from ${attempt.status}.`);
      }
      if (release.status !== "last_known_good" || release.git_commit !== input.deployedCommit.toLowerCase()) {
        throw new Error("Restored runtime must be the exact last-known-good release.");
      }
      if (attempt.status !== "restored") {
        this.database.query(`UPDATE deployment_attempts SET status='restored', deployed_commit=?,
          service_invocation_id=?, evidence_json=?, error=NULL, updated_at=CURRENT_TIMESTAMP,
          completed_at=CURRENT_TIMESTAMP WHERE id=?`).run(
          input.deployedCommit.toLowerCase(),
          input.serviceInvocationId,
          JSON.stringify(input.evidence),
          input.attemptId,
        );
        this.event(attempt.target, "attempt", attempt.id, "restored", {
          release_id: release.id,
          deployed_commit: input.deployedCommit.toLowerCase(),
          service_invocation_id: input.serviceInvocationId,
        });
      }
      return this.getAttempt(attempt.id)!;
    })();
  }

  private activeIncident(target: string) {
    return this.database.query(`SELECT * FROM deployment_incidents
      WHERE target=? AND status NOT IN ('resolved', 'parked') ORDER BY created_at, id LIMIT 1`)
      .get(target) as DeploymentIncidentRow | null;
  }

  getIncident(id: string) {
    return this.database.query("SELECT * FROM deployment_incidents WHERE id=?")
      .get(id) as DeploymentIncidentRow | null;
  }

  getActiveIncident(target = "concierge") {
    return this.activeIncident(target);
  }

  private openOrUpdateIncident(target: string, attemptId: string, fingerprint: string, error: string) {
    const active = this.activeIncident(target);
    if (active) {
      const repeated = active.failure_fingerprint === fingerprint
        ? active.repeated_fingerprint_count + 1
        : 1;
      const repair = this.getRepairRun(active.id);
      this.database.query(`UPDATE deployment_incidents SET last_attempt_id=?, failure_fingerprint=?,
        repeated_fingerprint_count=?, error=?,
        status=CASE WHEN status IN ('deploying', 'verifying') THEN 'diagnosing' ELSE status END,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(attemptId, fingerprint, repeated, error, active.id);
      if (repair?.provider_session_uuid && repair.result_json) {
        this.database.query(`UPDATE deployment_repair_runs SET error=?, updated_at=CURRENT_TIMESTAMP
          WHERE incident_id=?`).run("A later deployment attempt failed; refresh against current origin is required.", active.id);
      }
      this.event(target, "incident", active.id, "attempt_failed", {
        attempt_id: attemptId,
        failure_fingerprint: fingerprint,
        repeated_fingerprint_count: repeated,
      });
      return this.database.query("SELECT * FROM deployment_incidents WHERE id=?")
        .get(active.id) as DeploymentIncidentRow;
    }
    const id = randomUUID();
    this.database.query(`INSERT INTO deployment_incidents
      (id, target, status, failure_fingerprint, last_attempt_id, error)
      VALUES (?, ?, 'open', ?, ?, ?)`).run(id, target, fingerprint, attemptId, error);
    this.event(target, "incident", id, "incident_opened", { attempt_id: attemptId, failure_fingerprint: fingerprint });
    return this.database.query("SELECT * FROM deployment_incidents WHERE id=?")
      .get(id) as DeploymentIncidentRow;
  }

  transitionIncident(incidentId: string, next: IncidentStatus, error: string | null = null) {
    return this.database.transaction(() => {
      const incident = this.database.query("SELECT * FROM deployment_incidents WHERE id=?")
        .get(incidentId) as DeploymentIncidentRow | null;
      if (!incident) throw new Error(`Unknown incident ${incidentId}.`);
      if (!INCIDENT_TRANSITIONS[incident.status].includes(next)) {
        throw new Error(`Incident ${incidentId} cannot transition ${incident.status} -> ${next}.`);
      }
      if (incident.status === "parked" && next !== "parked") {
        const active = this.activeIncident(incident.target);
        if (active && active.id !== incident.id) {
          throw new Error(`Incident ${incidentId} cannot resume while incident ${active.id} is active.`);
        }
      }
      this.database.query(`UPDATE deployment_incidents SET status=?, error=?,
        completed_at=CASE WHEN ? IN ('resolved', 'parked') THEN CURRENT_TIMESTAMP ELSE NULL END,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(next, error, next, incidentId);
      this.event(incident.target, "incident", incident.id, next, error ? { error } : {});
      return this.database.query("SELECT * FROM deployment_incidents WHERE id=?")
        .get(incidentId) as DeploymentIncidentRow;
    })();
  }

  bindRepairSession(incidentId: string, providerId: string, providerSessionUuid: string) {
    requireNonEmpty(providerId, "repair provider ID");
    requireNonEmpty(providerSessionUuid, "repair provider session UUID");
    return this.database.transaction(() => {
      const incident = this.database.query("SELECT * FROM deployment_incidents WHERE id=?")
        .get(incidentId) as DeploymentIncidentRow | null;
      if (!incident || ["resolved", "parked"].includes(incident.status)) {
        throw new Error(`Incident ${incidentId} cannot bind a repair session.`);
      }
      if (incident.repair_session_uuid && incident.repair_session_uuid !== providerSessionUuid) {
        throw new Error(`Incident ${incidentId} is already bound to another repair session.`);
      }
      this.database.query(`UPDATE deployment_incidents SET repair_provider_id=?, repair_session_uuid=?,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(providerId, providerSessionUuid, incidentId);
      this.database.query(`UPDATE deployment_repair_runs SET status='running', provider_session_uuid=?,
        updated_at=CURRENT_TIMESTAMP
        WHERE incident_id=? AND status IN ('prepared', 'launched', 'running')
          AND (provider_session_uuid IS NULL OR provider_session_uuid=?)`)
        .run(providerSessionUuid, incidentId, providerSessionUuid);
      this.event(incident.target, "incident", incidentId, "repair_session_bound", { provider_id: providerId });
      return this.database.query("SELECT * FROM deployment_incidents WHERE id=?")
        .get(incidentId) as DeploymentIncidentRow;
    })();
  }

  beginRepairProviderLaunch(incidentId: string) {
    return this.database.transaction(() => {
      const incident = this.getIncident(incidentId);
      const repair = this.getRepairRun(incidentId);
      if (!incident || incident.status !== "repairing" || !repair
        || !["launched", "running"].includes(repair.status)) {
        throw new Error(`Repair ${incidentId} is not admitted to launch its provider.`);
      }
      if (repair.provider_launch_attempted === 0) {
        this.database.query(`UPDATE deployment_repair_runs SET provider_launch_attempted=1,
          updated_at=CURRENT_TIMESTAMP WHERE incident_id=?`).run(incidentId);
        this.event(incident.target, "repair_run", incidentId, "provider_launch_admitted", {});
        return repair.provider_session_uuid
          ? { outcome: "resume" as const, providerSessionUuid: repair.provider_session_uuid }
          : { outcome: "fresh" as const, providerSessionUuid: null };
      }
      const error = repair.provider_session_uuid
        ? "Repair provider turn is ambiguous; replay into the bound session was refused."
        : "Repair provider session creation is ambiguous; a fresh session was refused.";
      this.database.query(`UPDATE deployment_repair_runs SET status='ambiguous', error=?,
        result_json=?, completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE incident_id=?`).run(
        error,
        JSON.stringify({ outcome: "ambiguous", next_action: "park", root_cause: error }),
        incidentId,
      );
      this.database.query(`UPDATE deployment_incidents SET status='awaiting_owner_fix', error=?,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(error, incidentId);
      this.event(incident.target, "repair_run", incidentId, "provider_launch_ambiguous", { error });
      return { outcome: "parked" as const, providerSessionUuid: null, error };
    })();
  }

  getRepairRun(incidentId: string) {
    return this.database.query("SELECT * FROM deployment_repair_runs WHERE incident_id=?")
      .get(incidentId) as DeploymentRepairRunRow | null;
  }

  prepareRepairRun(input: {
    incidentId: string;
    baseCommit: string;
    baselineLocalCommit: string;
    repositoryPath: string;
    evidenceDigest: string;
    providerCapabilityDigest: string;
    capabilityExpiresAtMs: number;
    workerUnit: string;
  }) {
    assertCommit(input.baseCommit, "repair base commit");
    assertCommit(input.baselineLocalCommit, "repair local baseline commit");
    assertDigest(input.evidenceDigest, "repair evidence digest");
    assertDigest(input.providerCapabilityDigest, "repair provider capability digest");
    requireNonEmpty(input.repositoryPath, "repair repository path");
    requireNonEmpty(input.workerUnit, "repair worker unit");
    if (!Number.isSafeInteger(input.capabilityExpiresAtMs) || input.capabilityExpiresAtMs <= 0) {
      throw new Error("Repair provider capability expiry is invalid.");
    }
    return this.database.transaction(() => {
      const incident = this.getIncident(input.incidentId);
      if (!incident || incident.status !== "diagnosing") {
        throw new Error(`Incident ${input.incidentId} cannot prepare repair from ${incident?.status || "missing"}.`);
      }
      const existing = this.getRepairRun(input.incidentId);
      if (existing) {
        const unchanged = existing.base_commit === input.baseCommit.toLowerCase()
          && existing.baseline_local_commit === input.baselineLocalCommit.toLowerCase()
          && existing.repository_path === input.repositoryPath
          && existing.evidence_digest === input.evidenceDigest.toLowerCase()
          && existing.provider_capability_digest === input.providerCapabilityDigest.toLowerCase()
          && existing.capability_expires_at_ms === input.capabilityExpiresAtMs
          && existing.worker_unit === input.workerUnit;
        if (unchanged) return existing;
        if (!existing.provider_session_uuid || !existing.result_json) {
          throw new Error("Repair run identity changed before an exact-session refresh was available.");
        }
        this.database.query(`UPDATE deployment_repair_runs SET status='prepared', base_commit=?,
          baseline_local_commit=?, repository_path=?, evidence_digest=?, provider_capability_digest=?,
          capability_expires_at_ms=?, worker_unit=?, result_json=NULL, integrated_commit=NULL,
          provider_launch_attempted=0, pending_provider_capability_digest=NULL,
          pending_capability_expires_at_ms=NULL, error=NULL, completed_at=NULL,
          updated_at=CURRENT_TIMESTAMP WHERE incident_id=?`).run(
          input.baseCommit.toLowerCase(),
          input.baselineLocalCommit.toLowerCase(),
          input.repositoryPath,
          input.evidenceDigest.toLowerCase(),
          input.providerCapabilityDigest.toLowerCase(),
          input.capabilityExpiresAtMs,
          input.workerUnit,
          input.incidentId,
        );
        this.database.query("UPDATE deployment_incidents SET status='repairing', updated_at=CURRENT_TIMESTAMP WHERE id=?")
          .run(input.incidentId);
        this.event(incident.target, "repair_run", input.incidentId, "refreshed", {
          base_commit: input.baseCommit.toLowerCase(),
          evidence_digest: input.evidenceDigest.toLowerCase(),
        });
        return this.getRepairRun(input.incidentId)!;
      }
      this.database.query(`INSERT INTO deployment_repair_runs (
        incident_id, status, base_commit, baseline_local_commit, repository_path,
        evidence_digest, provider_capability_digest, capability_expires_at_ms, worker_unit
      ) VALUES (?, 'prepared', ?, ?, ?, ?, ?, ?, ?)`).run(
        input.incidentId,
        input.baseCommit.toLowerCase(),
        input.baselineLocalCommit.toLowerCase(),
        input.repositoryPath,
        input.evidenceDigest.toLowerCase(),
        input.providerCapabilityDigest.toLowerCase(),
        input.capabilityExpiresAtMs,
        input.workerUnit,
      );
      this.database.query("UPDATE deployment_incidents SET status='repairing', updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(input.incidentId);
      this.event(incident.target, "repair_run", input.incidentId, "prepared", {
        base_commit: input.baseCommit.toLowerCase(),
        evidence_digest: input.evidenceDigest.toLowerCase(),
      });
      return this.getRepairRun(input.incidentId)!;
    })();
  }

  requireRepairRefresh(incidentId: string, error: string) {
    requireNonEmpty(error, "repair refresh reason");
    return this.database.transaction(() => {
      const incident = this.getIncident(incidentId);
      const repair = this.getRepairRun(incidentId);
      if (!incident || incident.status !== "reviewing" || !repair?.provider_session_uuid || !repair.result_json) {
        throw new Error(`Incident ${incidentId} cannot invalidate its reviewed repair.`);
      }
      this.database.query(`UPDATE deployment_incidents SET status='diagnosing', error=?, updated_at=CURRENT_TIMESTAMP
        WHERE id=?`).run(error, incidentId);
      this.database.query(`UPDATE deployment_repair_runs SET error=?, updated_at=CURRENT_TIMESTAMP
        WHERE incident_id=?`).run(error, incidentId);
      this.event(incident.target, "repair_run", incidentId, "refresh_required", { error });
      return this.getIncident(incidentId)!;
    })();
  }

  markRepairRunLaunched(incidentId: string) {
    return this.database.transaction(() => {
      const current = this.getRepairRun(incidentId);
      if (!current) throw new Error(`Unknown repair run ${incidentId}.`);
      if (["launched", "running"].includes(current.status)) return current;
      if (current.status !== "prepared") throw new Error(`Repair run ${incidentId} cannot launch from ${current.status}.`);
      this.database.query("UPDATE deployment_repair_runs SET status='launched', updated_at=CURRENT_TIMESTAMP WHERE incident_id=?")
        .run(incidentId);
      this.event("concierge", "repair_run", incidentId, "launched", { worker_unit: current.worker_unit });
      return this.getRepairRun(incidentId)!;
    })();
  }

  beginRepairCapabilityRotation(incidentId: string, capabilityDigest: string, expiresAtMs: number) {
    assertDigest(capabilityDigest, "repair provider capability digest");
    if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0) {
      throw new Error("Repair provider capability expiry is invalid.");
    }
    return this.database.transaction(() => {
      const incident = this.getIncident(incidentId);
      const repair = this.getRepairRun(incidentId);
      if (!incident || incident.status !== "repairing" || !repair || repair.status !== "prepared"
        || !repair.provider_session_uuid) {
        throw new Error(`Repair ${incidentId} cannot rotate its resume capability.`);
      }
      if (repair.pending_provider_capability_digest) {
        if (repair.pending_provider_capability_digest !== capabilityDigest.toLowerCase()
          || repair.pending_capability_expires_at_ms !== expiresAtMs) {
          throw new Error(`Repair ${incidentId} already has another pending capability rotation.`);
        }
        return repair;
      }
      this.database.query(`UPDATE deployment_repair_runs SET pending_provider_capability_digest=?,
        pending_capability_expires_at_ms=?, updated_at=CURRENT_TIMESTAMP WHERE incident_id=?`).run(
        capabilityDigest.toLowerCase(), expiresAtMs, incidentId,
      );
      this.event(incident.target, "repair_run", incidentId, "provider_capability_rotation_prepared", {
        capability_expires_at_ms: expiresAtMs,
      });
      return this.getRepairRun(incidentId)!;
    })();
  }

  completeRepairCapabilityRotation(incidentId: string, capabilityDigest: string, expiresAtMs: number) {
    assertDigest(capabilityDigest, "repair provider capability digest");
    return this.database.transaction(() => {
      const incident = this.getIncident(incidentId);
      const repair = this.getRepairRun(incidentId);
      if (!incident || incident.status !== "repairing" || !repair || repair.status !== "prepared"
        || repair.pending_provider_capability_digest !== capabilityDigest.toLowerCase()
        || repair.pending_capability_expires_at_ms !== expiresAtMs) {
        throw new Error(`Repair ${incidentId} has no matching pending capability rotation.`);
      }
      this.database.query(`UPDATE deployment_repair_runs SET provider_capability_digest=?,
        capability_expires_at_ms=?, pending_provider_capability_digest=NULL,
        pending_capability_expires_at_ms=NULL, provider_launch_attempted=0,
        updated_at=CURRENT_TIMESTAMP WHERE incident_id=?`).run(
        capabilityDigest.toLowerCase(), expiresAtMs, incidentId,
      );
      this.event(incident.target, "repair_run", incidentId, "provider_capability_rotated", {
        capability_expires_at_ms: expiresAtMs,
      });
      return this.getRepairRun(incidentId)!;
    })();
  }

  completeRepairRun(input: {
    incidentId: string;
    providerSessionUuid: string;
    result: Record<string, unknown>;
  }) {
    return this.database.transaction(() => {
      const incident = this.getIncident(input.incidentId);
      const current = this.getRepairRun(input.incidentId);
      if (!incident || !current || incident.status !== "repairing") {
        throw new Error(`Repair run ${input.incidentId} is not active.`);
      }
      if (incident.repair_session_uuid !== input.providerSessionUuid
        || current.provider_session_uuid !== input.providerSessionUuid) {
        throw new Error("Repair completion does not match the bound provider session.");
      }
      if (current.status === "completed") return current;
      if (current.status !== "running") throw new Error(`Repair run cannot complete from ${current.status}.`);
      this.database.query(`UPDATE deployment_repair_runs SET status='completed', result_json=?,
        completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE incident_id=?`)
        .run(JSON.stringify(input.result), input.incidentId);
      this.database.query("UPDATE deployment_incidents SET status='reviewing', updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(input.incidentId);
      this.event(incident.target, "repair_run", input.incidentId, "completed", {});
      return this.getRepairRun(input.incidentId)!;
    })();
  }

  blockRepairRun(input: {
    incidentId: string;
    providerSessionUuid: string;
    result: Record<string, unknown>;
    error: string;
  }) {
    requireNonEmpty(input.error, "repair blocker");
    return this.database.transaction(() => {
      const incident = this.getIncident(input.incidentId);
      const current = this.getRepairRun(input.incidentId);
      if (!incident || incident.status !== "repairing" || !current || current.status !== "running") {
        throw new Error(`Repair run ${input.incidentId} is not active for parking.`);
      }
      if (incident.repair_session_uuid !== input.providerSessionUuid
        || current.provider_session_uuid !== input.providerSessionUuid) {
        throw new Error("Repair blocker does not match the bound provider session.");
      }
      this.database.query(`UPDATE deployment_repair_runs SET status='parked', result_json=?, error=?,
        completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE incident_id=?`).run(
        JSON.stringify(input.result),
        input.error,
        input.incidentId,
      );
      this.database.query(`UPDATE deployment_incidents SET status='awaiting_owner_fix', error=?,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(input.error, input.incidentId);
      this.event(incident.target, "repair_run", input.incidentId, "blocked", { error: input.error });
      return { incident: this.getIncident(input.incidentId)!, repairRun: this.getRepairRun(input.incidentId)! };
    })();
  }

  latestReviewRun(incidentId: string) {
    return this.database.query(`SELECT * FROM deployment_review_runs WHERE incident_id=?
      ORDER BY created_at DESC, id DESC LIMIT 1`).get(incidentId) as DeploymentReviewRunRow | null;
  }

  getReviewRun(id: string) {
    return this.database.query("SELECT * FROM deployment_review_runs WHERE id=?")
      .get(id) as DeploymentReviewRunRow | null;
  }

  prepareReviewRun(input: {
    reviewId: string;
    incidentId: string;
    baseCommit: string;
    headCommit: string;
    treeDigest: string;
    policyDigest: string;
    enforcementDigest: string;
    evidenceDigest: string;
    repositoryPath: string;
    controlPath: string;
    providerCapabilityDigest: string;
    capabilityExpiresAtMs: number;
    workerUnit: string;
  }) {
    assertCommit(input.baseCommit, "review base commit");
    assertCommit(input.headCommit, "review head commit");
    for (const [value, label] of [
      [input.treeDigest, "review tree digest"],
      [input.policyDigest, "review policy digest"],
      [input.enforcementDigest, "review enforcement digest"],
      [input.evidenceDigest, "review evidence digest"],
      [input.providerCapabilityDigest, "review provider capability digest"],
    ]) assertDigest(value, label);
    requireNonEmpty(input.repositoryPath, "review repository path");
    requireNonEmpty(input.controlPath, "review control path");
    requireNonEmpty(input.workerUnit, "review worker unit");
    return this.database.transaction(() => {
      const incident = this.getIncident(input.incidentId);
      const repair = this.getRepairRun(input.incidentId);
      if (!incident || incident.status !== "reviewing" || !repair || repair.status !== "completed") {
        throw new Error(`Incident ${input.incidentId} is not ready for independent review.`);
      }
      const existing = this.database.query(`SELECT * FROM deployment_review_runs
        WHERE incident_id=? AND head_commit=? AND tree_digest=?`).get(
        input.incidentId,
        input.headCommit.toLowerCase(),
        input.treeDigest.toLowerCase(),
      ) as DeploymentReviewRunRow | null;
      if (existing) return existing;
      requireNonEmpty(input.reviewId, "review run ID");
      const id = input.reviewId;
      this.database.query(`INSERT INTO deployment_review_runs (
        id, incident_id, status, base_commit, head_commit, tree_digest, policy_digest,
        enforcement_digest, evidence_digest, repository_path, control_path,
        provider_capability_digest, capability_expires_at_ms, worker_unit
      ) VALUES (?, ?, 'prepared', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id,
        input.incidentId,
        input.baseCommit.toLowerCase(),
        input.headCommit.toLowerCase(),
        input.treeDigest.toLowerCase(),
        input.policyDigest.toLowerCase(),
        input.enforcementDigest.toLowerCase(),
        input.evidenceDigest.toLowerCase(),
        input.repositoryPath,
        input.controlPath,
        input.providerCapabilityDigest.toLowerCase(),
        input.capabilityExpiresAtMs,
        input.workerUnit,
      );
      this.event(incident.target, "review_run", id, "prepared", { head_commit: input.headCommit.toLowerCase() });
      return this.getReviewRun(id)!;
    })();
  }

  markReviewRunLaunched(id: string) {
    return this.database.transaction(() => {
      const review = this.getReviewRun(id);
      if (!review) throw new Error(`Unknown review run ${id}.`);
      if (["launched", "running"].includes(review.status)) return review;
      if (review.status !== "prepared") throw new Error(`Review ${id} cannot launch from ${review.status}.`);
      this.database.query("UPDATE deployment_review_runs SET status='launched', updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(id);
      this.event("concierge", "review_run", id, "launched", { worker_unit: review.worker_unit });
      return this.getReviewRun(id)!;
    })();
  }

  beginReviewProviderLaunch(incidentId: string, reviewId: string) {
    return this.database.transaction(() => {
      const incident = this.getIncident(incidentId);
      const review = this.getReviewRun(reviewId);
      if (!incident || incident.status !== "reviewing" || !review || review.incident_id !== incidentId
        || !["launched", "running"].includes(review.status)) {
        throw new Error(`Review ${reviewId} is not admitted to launch its provider.`);
      }
      if (review.provider_launch_attempted === 0) {
        this.database.query(`UPDATE deployment_review_runs SET provider_launch_attempted=1,
          updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(reviewId);
        this.event(incident.target, "review_run", reviewId, "provider_launch_admitted", {});
        return review.provider_session_uuid
          ? { outcome: "resume" as const, providerSessionUuid: review.provider_session_uuid }
          : { outcome: "fresh" as const, providerSessionUuid: null };
      }
      const error = review.provider_session_uuid
        ? "Review provider turn is ambiguous; replay into the bound session was refused."
        : "Review provider session creation is ambiguous; a fresh session was refused.";
      this.database.query(`UPDATE deployment_review_runs SET status='ambiguous', error=?,
        completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(error, reviewId);
      this.database.query(`UPDATE deployment_incidents SET status='awaiting_owner_fix', error=?,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(error, incidentId);
      this.event(incident.target, "review_run", reviewId, "provider_launch_ambiguous", { error });
      return { outcome: "parked" as const, providerSessionUuid: null, error };
    })();
  }

  bindReviewSession(incidentId: string, reviewId: string, providerSessionUuid: string) {
    requireNonEmpty(providerSessionUuid, "review provider session UUID");
    return this.database.transaction(() => {
      const incident = this.getIncident(incidentId);
      const review = this.getReviewRun(reviewId);
      if (!incident || incident.status !== "reviewing" || !review || review.incident_id !== incidentId) {
        throw new Error("Review session does not match an active reviewing incident.");
      }
      if (review.provider_session_uuid && review.provider_session_uuid !== providerSessionUuid) {
        throw new Error(`Review ${reviewId} is already bound to another provider session.`);
      }
      if (!["prepared", "launched", "running"].includes(review.status)) {
        throw new Error(`Review ${reviewId} cannot bind from ${review.status}.`);
      }
      this.database.query(`UPDATE deployment_review_runs SET status='running', provider_session_uuid=?,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(providerSessionUuid, reviewId);
      this.event(incident.target, "review_run", reviewId, "session_bound", {});
      return this.getReviewRun(reviewId)!;
    })();
  }

  completeReviewRun(input: {
    incidentId: string;
    reviewId: string;
    providerSessionUuid: string;
    verdict: "ship" | "no_ship";
    result: Record<string, unknown>;
  }) {
    return this.database.transaction(() => {
      const incident = this.getIncident(input.incidentId);
      const review = this.getReviewRun(input.reviewId);
      if (!incident || incident.status !== "reviewing" || !review || review.incident_id !== input.incidentId) {
        throw new Error("Review completion does not match an active reviewing incident.");
      }
      if (review.provider_session_uuid !== input.providerSessionUuid || review.status !== "running") {
        throw new Error("Review completion does not match the bound running provider session.");
      }
      this.database.query(`UPDATE deployment_review_runs SET status=?, verdict_json=?, completed_at=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(input.verdict, JSON.stringify(input.result), review.id);
      const repair = this.getRepairRun(input.incidentId)!;
      if (input.verdict === "no_ship") {
        this.database.query(`UPDATE deployment_repair_runs SET status='prepared', result_json=NULL,
          provider_launch_attempted=0, completed_at=NULL, updated_at=CURRENT_TIMESTAMP
          WHERE incident_id=?`).run(input.incidentId);
        this.database.query("UPDATE deployment_incidents SET status='repairing', updated_at=CURRENT_TIMESTAMP WHERE id=?")
          .run(input.incidentId);
      }
      this.recordReview({
        incidentId: input.incidentId,
        reviewKind: "repair",
        verdict: input.verdict,
        baseCommit: review.base_commit,
        headCommit: review.head_commit,
        treeDigest: review.tree_digest,
        policyDigest: review.policy_digest,
        enforcementDigest: review.enforcement_digest,
        evidenceDigest: review.evidence_digest,
        reviewerIdentity: input.providerSessionUuid,
      });
      this.event(incident.target, "review_run", review.id, input.verdict, { repair_session: repair.provider_session_uuid });
      return this.getReviewRun(review.id)!;
    })();
  }

  markRepairIntegrated(incidentId: string, integratedCommit: string) {
    assertCommit(integratedCommit, "integrated repair commit");
    return this.database.transaction(() => {
      const incident = this.getIncident(incidentId);
      const repair = this.getRepairRun(incidentId);
      const review = this.latestReviewRun(incidentId);
      if (!incident || incident.status !== "reviewing" || !repair || !review || review.status !== "ship") {
        throw new Error(`Incident ${incidentId} has no promotable reviewed repair.`);
      }
      this.database.query(`UPDATE deployment_repair_runs SET integrated_commit=?, updated_at=CURRENT_TIMESTAMP
        WHERE incident_id=?`).run(integratedCommit.toLowerCase(), incidentId);
      this.database.query("UPDATE deployment_incidents SET status='deploying', updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(incidentId);
      this.event(incident.target, "repair_run", incidentId, "integrated", { integrated_commit: integratedCommit.toLowerCase() });
      return this.getRepairRun(incidentId)!;
    })();
  }

  succeedAttempt(input: {
    attemptId: string;
    deployedCommit: string;
    serviceInvocationId: string;
    evidence: Record<string, unknown>;
    satisfiedIntentIds: string[];
  }) {
    assertCommit(input.deployedCommit, "deployed commit");
    requireNonEmpty(input.serviceInvocationId, "service invocation ID");
    return this.database.transaction(() => {
      const attempt = this.getAttempt(input.attemptId);
      if (!attempt) throw new Error(`Unknown attempt ${input.attemptId}.`);
      if (attempt.status === "succeeded") return attempt;
      if (attempt.status !== "releasing") {
        throw new Error(`Attempt ${attempt.id} cannot succeed from ${attempt.status}.`);
      }
      const intents = [...new Set(input.satisfiedIntentIds)].map((id) => this.getIntent(id));
      if (intents.some((intent) => !intent || intent.target !== attempt.target || intent.status !== "pending")) {
        throw new Error("Only pending intents for the attempt target may be satisfied.");
      }
      this.database.query(`UPDATE deployment_attempts SET status='succeeded', deployed_commit=?,
        service_invocation_id=?, evidence_json=?, error=NULL, completed_at=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(
        input.deployedCommit.toLowerCase(),
        input.serviceInvocationId,
        JSON.stringify(input.evidence),
        attempt.id,
      );
      this.database.query(`UPDATE target_generations SET status='succeeded', completed_at=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(attempt.generation_id);
      for (const intent of intents as DeploymentIntentRow[]) {
        this.database.query(`UPDATE deployment_intents SET status='satisfied', error=NULL,
          updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'`).run(intent.id);
        this.database.query(`INSERT INTO intent_attempt_results (attempt_id, intent_id, result)
          VALUES (?, ?, 'satisfied')
          ON CONFLICT(attempt_id, intent_id) DO UPDATE SET result='satisfied', detail=NULL,
            updated_at=CURRENT_TIMESTAMP`).run(attempt.id, intent.id);
      }
      this.queueVerificationHandoffs(attempt, input.deployedCommit.toLowerCase(), input.serviceInvocationId, input.evidence, intents as DeploymentIntentRow[]);
      this.event(attempt.target, "attempt", attempt.id, "succeeded", {
        deployed_commit: input.deployedCommit.toLowerCase(),
        service_invocation_id: input.serviceInvocationId,
        satisfied_intent_ids: input.satisfiedIntentIds,
      });
      const incident = this.activeIncident(attempt.target);
      if (incident?.status === "deploying") {
        this.database.query(`UPDATE deployment_incidents SET status='verifying', last_attempt_id=?,
          updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(attempt.id, incident.id);
        this.event(attempt.target, "incident", incident.id, "verifying", { attempt_id: attempt.id });
      }
      return this.getAttempt(attempt.id)!;
    })();
  }

  private queueVerificationHandoffs(
    attempt: DeploymentAttemptRow,
    deployedCommit: string,
    serviceInvocationId: string,
    evidence: Record<string, unknown>,
    intents: DeploymentIntentRow[],
  ) {
    const groups = new Map<string, DeploymentIntentRow[]>();
    for (const intent of intents) {
      const key = [intent.source_session_id, intent.slack_channel_id, intent.slack_thread_ts].join("\u0000");
      const group = groups.get(key) || [];
      group.push(intent);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      const latest = group.at(-1)!;
      const id = randomUUID();
      const idempotencyKey = `deployment-verification:${attempt.id}:${latest.source_session_id}:${latest.slack_channel_id}:${latest.slack_thread_ts}`;
      const payload = {
        attempt_id: attempt.id,
        requested_commits: [...new Set(group.map((intent) => intent.expected_commit))],
        deployed_commit: deployedCommit,
        service_invocation_id: serviceInvocationId,
        evidence,
      };
      this.database.query(`INSERT INTO deployment_handoffs (
        id, target, kind, attempt_id, source_session_id, slack_channel_id,
        slack_thread_ts, requested_by_user_id, provider_id, provider_model, reasoning_effort,
        provider_session_uuid, payload_json, status, idempotency_key
      ) VALUES (?, ?, 'verification', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      ON CONFLICT(kind, attempt_id, source_session_id, slack_channel_id, slack_thread_ts) DO NOTHING`).run(
        id,
        attempt.target,
        attempt.id,
        latest.source_session_id,
        latest.slack_channel_id,
        latest.slack_thread_ts,
        latest.requested_by_user_id,
        latest.provider_id,
        latest.provider_model,
        latest.reasoning_effort,
        latest.provider_session_uuid,
        JSON.stringify(payload),
        idempotencyKey,
      );
      const handoff = this.database.query("SELECT * FROM deployment_handoffs WHERE idempotency_key=?")
        .get(idempotencyKey) as DeploymentHandoffRow;
      for (const intent of group) {
        this.database.query(`INSERT INTO handoff_intents (handoff_id, intent_id) VALUES (?, ?)
          ON CONFLICT DO NOTHING`).run(handoff.id, intent.id);
        this.database.query(`UPDATE deployment_intents SET status='verification_pending',
          updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='satisfied'`).run(intent.id);
      }
      this.event(attempt.target, "handoff", handoff.id, "verification_pending", { intent_ids: group.map((intent) => intent.id) });
    }
  }

  listPendingHandoffs(target = "concierge") {
    return this.database.query(`SELECT * FROM deployment_handoffs
      WHERE target=? AND status='pending' ORDER BY created_at, id`).all(target) as DeploymentHandoffRow[];
  }

  listUnsettledHandoffs(target = "concierge") {
    return this.database.query(`SELECT * FROM deployment_handoffs
      WHERE target=? AND status IN ('pending', 'claimed') ORDER BY created_at, id`)
      .all(target) as DeploymentHandoffRow[];
  }

  getHandoff(id: string) {
    return this.database.query("SELECT * FROM deployment_handoffs WHERE id=?")
      .get(id) as DeploymentHandoffRow | null;
  }

  claimHandoff(handoffId: string, ownerInstanceId: string) {
    requireNonEmpty(ownerInstanceId, "handoff owner instance ID");
    return this.database.transaction(() => {
      const updated = this.database.query(`UPDATE deployment_handoffs SET status='claimed',
        owner_instance_id=?, error=NULL, updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND status='pending'`).run(ownerInstanceId, handoffId);
      if (updated.changes !== 1) return null;
      const handoff = this.database.query("SELECT * FROM deployment_handoffs WHERE id=?")
        .get(handoffId) as DeploymentHandoffRow;
      this.event(handoff.target, "handoff", handoff.id, "claimed", { owner_instance_id: ownerInstanceId });
      return handoff;
    })();
  }

  settleHandoff(handoffId: string, ownerInstanceId: string, outcome: "delivered" | "parked", error: string | null = null) {
    return this.database.transaction(() => {
      const handoff = this.database.query("SELECT * FROM deployment_handoffs WHERE id=?")
        .get(handoffId) as DeploymentHandoffRow | null;
      if (!handoff) throw new Error(`Unknown handoff ${handoffId}.`);
      if (handoff.status === outcome) return handoff;
      if (handoff.status !== "claimed" || handoff.owner_instance_id !== ownerInstanceId) {
        throw new Error(`Handoff ${handoffId} is not owned by ${ownerInstanceId}.`);
      }
      this.database.query(`UPDATE deployment_handoffs SET status=?, owner_instance_id=NULL,
        error=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(outcome, error, handoffId);
      const nextIntentStatus = outcome === "delivered" ? "verified" : "parked";
      this.database.query(`UPDATE deployment_intents SET status=?, error=?, updated_at=CURRENT_TIMESTAMP
        WHERE id IN (SELECT intent_id FROM handoff_intents WHERE handoff_id=?)`)
        .run(nextIntentStatus, error, handoffId);
      this.event(handoff.target, "handoff", handoff.id, outcome, error ? { error } : {});
      return this.database.query("SELECT * FROM deployment_handoffs WHERE id=?")
        .get(handoffId) as DeploymentHandoffRow;
    })();
  }

  linkCorrectingIntent(blockedIntentId: string, correctingIntentId: string) {
    return this.database.transaction(() => {
      const blocked = this.getIntent(blockedIntentId);
      const correcting = this.getIntent(correctingIntentId);
      if (!blocked || !correcting || blocked.target !== correcting.target) {
        throw new Error("Blocked and correcting intents must exist for the same target.");
      }
      if (["verified", "cancelled"].includes(blocked.status)) {
        throw new Error(`Intent ${blocked.id} is already terminal.`);
      }
      this.database.query(`UPDATE deployment_intents SET correcting_intent_id=?,
        status='pending', error=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(correcting.id, blocked.id);
      this.event(blocked.target, "intent", blocked.id, "correction_linked", { correcting_intent_id: correcting.id });
      return this.getIntent(blocked.id)!;
    })();
  }

  recordRelease(input: {
    target?: string;
    gitCommit: string;
    artifactPath: string;
    artifactDigest: string;
    runtimeDigest: string;
    compatibilityDigest: string;
    rollbackSafe: boolean;
    evidence: Record<string, unknown>;
  }) {
    assertCommit(input.gitCommit, "release commit");
    requireNonEmpty(input.artifactPath, "release artifact path");
    assertDigest(input.artifactDigest, "artifact digest");
    assertDigest(input.runtimeDigest, "runtime digest");
    assertDigest(input.compatibilityDigest, "compatibility digest");
    const target = input.target || "concierge";
    return this.database.transaction(() => {
      const existing = this.database.query(`SELECT * FROM deployment_releases
        WHERE target=? AND git_commit=? AND artifact_digest=?`)
        .get(target, input.gitCommit.toLowerCase(), input.artifactDigest.toLowerCase()) as ReleaseRow | null;
      if (existing) return existing;
      const id = randomUUID();
      this.database.query(`INSERT INTO deployment_releases (
        id, target, git_commit, artifact_path, artifact_digest, runtime_digest, compatibility_digest,
        rollback_safe, status, evidence_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?)`).run(
        id,
        target,
        input.gitCommit.toLowerCase(),
        input.artifactPath,
        input.artifactDigest.toLowerCase(),
        input.runtimeDigest.toLowerCase(),
        input.compatibilityDigest.toLowerCase(),
        input.rollbackSafe ? 1 : 0,
        JSON.stringify(input.evidence),
      );
      this.event(target, "release", id, "candidate_recorded", { git_commit: input.gitCommit.toLowerCase() });
      return this.database.query("SELECT * FROM deployment_releases WHERE id=?").get(id) as ReleaseRow;
    })();
  }

  markReleaseHealthy(releaseId: string, evidence: Record<string, unknown>) {
    return this.database.transaction(() => {
      const release = this.getRelease(releaseId);
      if (!release) throw new Error(`Unknown release ${releaseId}.`);
      if (release.status === "healthy" || release.status === "last_known_good") return release;
      if (release.status !== "candidate") {
        throw new Error(`Release ${releaseId} cannot become healthy from ${release.status}.`);
      }
      this.database.query(`UPDATE deployment_releases SET status='healthy', evidence_json=?,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(JSON.stringify(evidence), releaseId);
      this.event(release.target, "release", release.id, "health_proven", evidence);
      return this.getRelease(releaseId)!;
    })();
  }

  promoteRelease(releaseId: string, evidence: Record<string, unknown>) {
    return this.database.transaction(() => {
      const release = this.database.query("SELECT * FROM deployment_releases WHERE id=?")
        .get(releaseId) as ReleaseRow | null;
      if (!release) throw new Error(`Unknown release ${releaseId}.`);
      if (release.status === "last_known_good") return release;
      if (release.status !== "healthy") {
        throw new Error(`Release ${releaseId} cannot be promoted from ${release.status}.`);
      }
      this.database.query(`UPDATE deployment_releases SET status='superseded', updated_at=CURRENT_TIMESTAMP
        WHERE target=? AND status='last_known_good'`).run(release.target);
      this.database.query(`UPDATE deployment_releases SET status='last_known_good', evidence_json=?,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(JSON.stringify(evidence), releaseId);
      this.event(release.target, "release", release.id, "promoted_last_known_good");
      return this.database.query("SELECT * FROM deployment_releases WHERE id=?").get(releaseId) as ReleaseRow;
    })();
  }

  lastKnownGood(target = "concierge") {
    return this.database.query(`SELECT * FROM deployment_releases
      WHERE target=? AND status='last_known_good'`).get(target) as ReleaseRow | null;
  }

  getRelease(id: string) {
    return this.database.query("SELECT * FROM deployment_releases WHERE id=?")
      .get(id) as ReleaseRow | null;
  }

  getReleaseForCommit(gitCommit: string, target = "concierge") {
    assertCommit(gitCommit, "release commit");
    return this.database.query(`SELECT * FROM deployment_releases
      WHERE target=? AND git_commit=? ORDER BY created_at DESC, id DESC LIMIT 1`)
      .get(target, gitCommit.toLowerCase()) as ReleaseRow | null;
  }

  bootstrapNotifierTarget(input: {
    target?: string;
    slackChannelId: string;
    slackChannelName: string;
    registryCodePath: string;
  }) {
    const target = input.target || "concierge";
    requireNonEmpty(input.slackChannelId, "Slack channel ID");
    requireNonEmpty(input.slackChannelName, "Slack channel name");
    requireNonEmpty(input.registryCodePath, "registry code path");
    return this.database.transaction(() => {
      const existing = this.getNotifierTarget(target);
      if (existing) {
        if (existing.slack_channel_id !== input.slackChannelId
          || existing.slack_channel_name !== input.slackChannelName
          || existing.registry_code_path !== input.registryCodePath) {
          throw new Error("Notifier target drift requires a separate reviewed operator change.");
        }
        return existing;
      }
      this.database.query(`INSERT INTO deployment_notifier_targets
        (target, slack_channel_id, slack_channel_name, registry_code_path)
        VALUES (?, ?, ?, ?)`).run(
        target,
        input.slackChannelId,
        input.slackChannelName,
        input.registryCodePath,
      );
      this.event(target, "notifier_target", target, "bootstrapped", {
        slack_channel_id: input.slackChannelId,
        slack_channel_name: input.slackChannelName,
        registry_code_path: input.registryCodePath,
      });
      return this.getNotifierTarget(target)!;
    })();
  }

  getNotifierTarget(target = "concierge") {
    return this.database.query("SELECT * FROM deployment_notifier_targets WHERE target=?")
      .get(target) as NotifierTargetRow | null;
  }

  recordNotifierPreflight(target: string, botUserId: string, evidence: Record<string, unknown>) {
    requireNonEmpty(botUserId, "notifier bot user ID");
    const updated = this.database.query(`UPDATE deployment_notifier_targets
      SET bot_user_id=?, preflight_evidence_json=?, preflight_at=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP WHERE target=?`)
      .run(botUserId, JSON.stringify(evidence), target);
    if (updated.changes !== 1) throw new Error(`Notifier target ${target} is not bootstrapped.`);
    this.event(target, "notifier_target", target, "preflight_passed", evidence);
    return this.getNotifierTarget(target)!;
  }

  prepareNotification(input: {
    incidentId: string;
    kind: NotificationKind;
    payload: Record<string, unknown>;
    payloadDigest: string;
    clientMessageId: string;
  }) {
    assertDigest(input.payloadDigest, "notification payload digest");
    requireNonEmpty(input.clientMessageId, "notification client message ID");
    return this.database.transaction(() => {
      const incident = this.getIncident(input.incidentId);
      if (!incident) throw new Error(`Unknown incident ${input.incidentId}.`);
      const existing = this.database.query(`SELECT * FROM deployment_notifications
        WHERE incident_id=? AND kind=?`).get(input.incidentId, input.kind) as DeploymentNotificationRow | null;
      if (existing) {
        if (existing.payload_digest !== input.payloadDigest || existing.client_msg_id !== input.clientMessageId) {
          throw new Error(`Notification ${input.incidentId}/${input.kind} changed after persistence.`);
        }
        return existing;
      }
      const root = this.database.query(`SELECT * FROM deployment_notifications
        WHERE incident_id=? AND root_alert_id IS NULL
        ORDER BY created_at, id LIMIT 1`).get(input.incidentId) as DeploymentNotificationRow | null;
      if (input.kind === "forward_repair_succeeded" && !root) {
        throw new Error("A terminal repair update cannot create a new incident root.");
      }
      if (root && !root.slack_ts) {
        throw new Error("A follow-up cannot send until its incident root has a proven Slack timestamp.");
      }
      const id = randomUUID();
      this.database.query(`INSERT INTO deployment_notifications (
        id, target, incident_id, kind, payload_json, payload_digest, client_msg_id,
        status, root_alert_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', ?)`).run(
        id,
        incident.target,
        incident.id,
        input.kind,
        JSON.stringify(input.payload),
        input.payloadDigest,
        input.clientMessageId,
        root?.id || null,
      );
      this.event(incident.target, "notification", id, "prepared", { kind: input.kind });
      return this.getNotification(id)!;
    })();
  }

  getNotification(id: string) {
    return this.database.query("SELECT * FROM deployment_notifications WHERE id=?")
      .get(id) as DeploymentNotificationRow | null;
  }

  claimNotification(id: string) {
    return this.database.transaction(() => {
      const notification = this.getNotification(id);
      if (!notification) throw new Error(`Unknown notification ${id}.`);
      if (notification.status === "sending") return notification;
      if (notification.status !== "prepared") {
        throw new Error(`Notification ${id} cannot send from ${notification.status}.`);
      }
      this.database.query(`UPDATE deployment_notifications SET status='sending',
        send_started_at=CURRENT_TIMESTAMP, error=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(id);
      this.event(notification.target, "notification", id, "sending", { kind: notification.kind });
      return this.getNotification(id)!;
    })();
  }

  settleNotification(id: string, outcome: "delivered" | "ambiguous" | "parked", input: {
    slackTs?: string | null;
    error?: string | null;
  } = {}) {
    return this.database.transaction(() => {
      const notification = this.getNotification(id);
      if (!notification) throw new Error(`Unknown notification ${id}.`);
      if (notification.status === outcome) return notification;
      if (!new Set(["sending", "ambiguous"]).has(notification.status)) {
        throw new Error(`Notification ${id} cannot settle ${notification.status} -> ${outcome}.`);
      }
      if (outcome === "delivered" && !input.slackTs) throw new Error("Delivered notification requires a Slack timestamp.");
      this.database.query(`UPDATE deployment_notifications SET status=?, slack_ts=COALESCE(?, slack_ts),
        error=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(outcome, input.slackTs || null, input.error || null, id);
      this.event(notification.target, "notification", id, outcome, input.error ? { error: input.error } : {});
      return this.getNotification(id)!;
    })();
  }

  listUnsettledNotifications(target = "concierge") {
    return this.database.query(`SELECT * FROM deployment_notifications
      WHERE target=? AND status IN ('prepared', 'sending', 'ambiguous') ORDER BY created_at, id`)
      .all(target) as DeploymentNotificationRow[];
  }

  listIncidentNotifications(incidentId: string) {
    return this.database.query(`SELECT * FROM deployment_notifications
      WHERE incident_id=? ORDER BY created_at, id`).all(incidentId) as DeploymentNotificationRow[];
  }

  recordReview(input: {
    incidentId: string;
    reviewKind: "repair" | "learning" | "coordinator";
    verdict: "ship" | "no_ship" | "promote" | "revise" | "reject";
    baseCommit: string;
    headCommit: string;
    treeDigest: string;
    policyDigest: string;
    enforcementDigest: string;
    evidenceDigest: string;
    reviewerIdentity: string;
  }) {
    assertCommit(input.baseCommit, "review base commit");
    assertCommit(input.headCommit, "review head commit");
    assertDigest(input.treeDigest, "tree digest");
    assertDigest(input.policyDigest, "policy digest");
    assertDigest(input.enforcementDigest, "enforcement digest");
    assertDigest(input.evidenceDigest, "evidence digest");
    requireNonEmpty(input.reviewerIdentity, "reviewer identity");
    return this.database.transaction(() => {
      const incident = this.database.query("SELECT * FROM deployment_incidents WHERE id=?")
        .get(input.incidentId) as DeploymentIncidentRow | null;
      if (!incident) throw new Error(`Unknown incident ${input.incidentId}.`);
      const id = randomUUID();
      this.database.query(`INSERT INTO deployment_reviews (
        id, incident_id, review_kind, verdict, base_commit, head_commit, tree_digest,
        policy_digest, enforcement_digest, evidence_digest, reviewer_identity
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id,
        input.incidentId,
        input.reviewKind,
        input.verdict,
        input.baseCommit.toLowerCase(),
        input.headCommit.toLowerCase(),
        input.treeDigest.toLowerCase(),
        input.policyDigest.toLowerCase(),
        input.enforcementDigest.toLowerCase(),
        input.evidenceDigest.toLowerCase(),
        input.reviewerIdentity,
      );
      this.event(incident.target, "review", id, input.verdict, { review_kind: input.reviewKind });
      return id;
    })();
  }

  recordLearning(input: {
    incidentId: string;
    classification: GapClassification;
    summary: string;
    retrievalTrace: Record<string, unknown>;
    productionEvidence: Record<string, unknown>;
  }) {
    requireNonEmpty(input.summary, "learning summary");
    return this.database.transaction(() => {
      const incident = this.database.query("SELECT * FROM deployment_incidents WHERE id=?")
        .get(input.incidentId) as DeploymentIncidentRow | null;
      if (!incident) throw new Error(`Unknown incident ${input.incidentId}.`);
      const id = randomUUID();
      this.database.query(`INSERT INTO deployment_learning (
        id, incident_id, classification, summary, retrieval_trace_json,
        production_evidence_json, status
      ) VALUES (?, ?, ?, ?, ?, ?, 'recorded')`).run(
        id,
        input.incidentId,
        input.classification,
        input.summary,
        JSON.stringify(input.retrievalTrace),
        JSON.stringify(input.productionEvidence),
      );
      this.event(incident.target, "learning", id, "recorded", { classification: input.classification });
      return id;
    })();
  }

  getLearning(incidentId: string) {
    return this.database.query("SELECT * FROM deployment_learning WHERE incident_id=?")
      .get(incidentId) as Record<string, unknown> | null;
  }

  recentResolvedLearning(target = "concierge", limit = 20) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Learning retrieval limit is invalid.");
    return this.database.query(`SELECT learning.id, learning.incident_id, learning.classification,
      learning.summary, learning.retrieval_trace_json, incidents.failure_fingerprint,
      incidents.completed_at
      FROM deployment_learning learning
      JOIN deployment_incidents incidents ON incidents.id=learning.incident_id
      WHERE incidents.target=? AND incidents.status='resolved'
      ORDER BY incidents.completed_at DESC, learning.id DESC LIMIT ?`).all(target, limit) as Array<Record<string, unknown>>;
  }

  listEvents(target = "concierge") {
    return this.database.query(`SELECT * FROM deployment_events
      WHERE target=? ORDER BY sequence`).all(target) as Array<Record<string, unknown>>;
  }
}
