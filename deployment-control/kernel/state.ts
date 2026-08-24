import { randomUUID } from "node:crypto";
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

function assertCommit(value: string, label = "commit") {
  if (!/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error(`${label} must be a full 40-character Git SHA.`);
  }
}

function assertDigest(value: string, label: string) {
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error(`${label} must be a SHA-256 digest.`);
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
      this.database.query(`UPDATE deployment_incidents SET last_attempt_id=?, failure_fingerprint=?,
        repeated_fingerprint_count=?, error=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(attemptId, fingerprint, repeated, error, active.id);
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
      this.event(incident.target, "incident", incidentId, "repair_session_bound", { provider_id: providerId });
      return this.database.query("SELECT * FROM deployment_incidents WHERE id=?")
        .get(incidentId) as DeploymentIncidentRow;
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

  listEvents(target = "concierge") {
    return this.database.query(`SELECT * FROM deployment_events
      WHERE target=? ORDER BY sequence`).all(target) as Array<Record<string, unknown>>;
  }
}
