import { createHash, randomUUID } from "node:crypto";
import { db, type ProviderId, type SessionRow } from "./state";

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

export interface DeploymentRunRow {
  id: string;
  target: string;
  unit_name: string;
  status: DeploymentRunStatus;
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
`);

const deploymentWakeColumns = new Set(
  (db.query("PRAGMA table_info(deployment_wakes)").all() as Array<{ name: string }>).map((column) => column.name),
);
if (!deploymentWakeColumns.has("control_handoff_id")) {
  db.exec("ALTER TABLE deployment_wakes ADD COLUMN control_handoff_id TEXT");
}

function appendRunEvent(runId: string, event: string, detail: Record<string, unknown> = {}) {
  db.query(`INSERT INTO deployment_run_events (run_id, event, detail_json) VALUES (?, ?, ?)`)
    .run(runId, event, JSON.stringify(detail));
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

function assertCommit(value: string) {
  if (!/^[0-9a-f]{40}$/i.test(value)) throw new Error("Expected commit must be a full 40-character Git SHA.");
}

const deploymentContinuationSelect = `
    SELECT turn.id AS turn_id, turn.session_id, turn.status AS turn_status,
           turn.owner_instance_id, turn.slack_user_msg_ts, turn.slack_reply_thread_ts,
           turn.requested_by_user_id, turn.provider_model, turn.reasoning_effort,
           session.slack_channel_id, session.slack_thread_ts AS session_thread_ts,
           session.provider_id, session.agent_session_uuid,
           COALESCE(channel.code_path, channel.vault_path) AS project_path,
           claim.user_id AS claim_user_id
    FROM turns turn
    JOIN sessions session ON session.id=turn.session_id
    JOIN channels channel ON channel.slack_channel_id=session.slack_channel_id
    LEFT JOIN slack_user_input_claims claim
      ON claim.slack_channel_id=session.slack_channel_id
     AND claim.slack_user_msg_ts=turn.slack_user_msg_ts
`;

export interface DeploymentContinuation {
  sourceTurnId: number;
  sourceSessionId: number;
  ownerInstanceId: string;
  slackChannelId: string;
  slackThreadTs: string;
  requestedByUserId: string | null;
  providerId: ProviderId;
  providerModel: string | null;
  reasoningEffort: string | null;
  providerSessionUuid: string;
  projectPath: string;
}

function continuationFromSource(source: any): DeploymentContinuation {
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
    projectPath: String(source.project_path),
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

export function deploymentIntentCapabilityDigest(capability: string) {
  if (!/^[0-9a-f]{64}$/.test(capability)) {
    throw new Error("Deployment intent capability is invalid.");
  }
  return createHash("sha256").update(capability).digest("hex");
}

export function deploymentContinuationForCapability(input: {
  capability: string;
  sourceTurnId: number;
  sourceSessionId: number;
  slackChannelId: string;
  slackThreadTs: string;
}) {
  const digest = deploymentIntentCapabilityDigest(input.capability);
  const source = db.query(`${deploymentContinuationSelect}
    WHERE turn.deployment_intent_capability_digest=?`).get(digest) as any;
  if (!source) throw new Error("Deployment intent capability is not authorized.");
  const boundThreadTs = String(source.slack_reply_thread_ts || source.session_thread_ts);
  if (Number(source.turn_id) !== input.sourceTurnId
    || Number(source.session_id) !== input.sourceSessionId
    || String(source.slack_channel_id) !== input.slackChannelId
    || boundThreadTs !== input.slackThreadTs) {
    throw new Error("Deployment intent capability does not match its persisted turn context.");
  }
  if (source.turn_status === "running" && source.owner_instance_id) {
    return continuationFromSource(source);
  }
  return deploymentContinuationForActiveSession({
    sourceSessionId: Number(source.session_id),
    slackChannelId: String(source.slack_channel_id),
    slackThreadTs: boundThreadTs,
  });
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
      throw new Error(`Deployment run ${input.runId} cannot be claimed from ${run.status}.`);
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
}) {
  if (input.kind === "commit_not_included") {
    return `Deployment ${input.runId} passed its health gate, but it did not contain the commit this agent requested (${(input.expectedCommits || []).join(", ")}). No verification agent was started. ${input.error}`;
  }
  if (input.kind === "wake_parked") {
    return `Deployment ${input.runId} succeeded, but Concierge could not safely resume the original provider session for verification. No fresh session was substituted. ${input.error}`;
  }
  return `Deployment ${input.runId} did not complete successfully. No verification agent was started. ${input.error}`;
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

function verificationPrompt(input: {
  run: DeploymentRunRow;
  requests: DeploymentRequestRow[];
  deployedCommit: string;
  serviceInvocationId: string;
  evidence: Record<string, unknown>;
}) {
  const requestedCommits = [...new Set(input.requests.map((request) => request.expected_commit))];
  return [
    "The deployment you requested has completed and passed its functional health gate.",
    "This is an internal deployment-verification turn in the same durable provider session and Slack thread; it is not a new user request.",
    `Deployment run: ${input.run.id}`,
    `Requested commit(s): ${requestedCommits.join(", ")}`,
    `Deployed commit: ${input.deployedCommit}`,
    `Service invocation: ${input.serviceInvocationId}`,
    `Health evidence: ${JSON.stringify(input.evidence)}`,
    "Inspect the live service and verify that the change represented by the requested commit(s) is actually working. Run the smallest meaningful live checks. If it is broken, diagnose and fix it, commit and push the correction, deploy through bot/scripts/deploy.sh, and verify again. Report concrete evidence in the thread; do not merely acknowledge this message.",
  ].join("\n\n");
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
    const includedGroups: DeploymentRequestRow[][] = [];
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
      } else {
        includedGroups.push(requestsForSession);
      }
    }

    db.query(`UPDATE deployment_runs
      SET status='succeeded', deployed_commit=?, service_invocation_id=?, evidence_json=?,
          error=NULL, completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND status='releasing'`)
      .run(
        input.deployedCommit.toLowerCase(),
        input.serviceInvocationId,
        JSON.stringify(input.evidence),
        input.runId,
      );
    const completedRun = getDeploymentRun(input.runId)!;
    appendRunEvent(input.runId, "succeeded", {
      deployed_commit: input.deployedCommit.toLowerCase(),
      service_invocation_id: input.serviceInvocationId,
      included_request_count: settledRequests.filter((request) => request.status === "included").length,
    });

    for (const requestsForSession of includedGroups) {
      const latest = requestsForSession.at(-1)!;
      const wakeId = randomUUID();
      db.query(`
        INSERT INTO deployment_wakes (
          id, run_id, session_id, slack_channel_id, slack_thread_ts,
          requested_by_user_id, provider_id, provider_model, reasoning_effort,
          provider_session_uuid, prompt, status, next_attempt_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0)
        ON CONFLICT(run_id, session_id, slack_channel_id, slack_thread_ts) DO NOTHING
      `).run(
        wakeId,
        input.runId,
        latest.source_session_id,
        latest.slack_channel_id,
        latest.slack_thread_ts,
        latest.requested_by_user_id,
        latest.provider_id,
        latest.provider_model,
        latest.reasoning_effort,
        latest.provider_session_uuid,
        verificationPrompt({
          run: completedRun,
          requests: requestsForSession,
          deployedCommit: input.deployedCommit.toLowerCase(),
          serviceInvocationId: input.serviceInvocationId,
          evidence: input.evidence,
        }),
      );
    }
    return completedRun;
  })();
}

export function failDeploymentRun(
  runId: string,
  error: string,
  outcome: "failed" | "ambiguous" = "failed",
): DeploymentRunRow | null {
  return db.transaction(() => {
    const run = getDeploymentRun(runId);
    if (!run) return null;
    if (!ACTIVE_RUN_STATUSES.includes(run.status)) return run;
    db.query(`UPDATE deployment_runs
      SET status=?, error=?, completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
      WHERE id=?`).run(outcome, error, runId);
    db.query(`UPDATE deployment_requests
      SET status='failed', error=?, updated_at=CURRENT_TIMESTAMP
      WHERE run_id=? AND status='pending'`).run(error, runId);
    appendRunEvent(runId, outcome, { error });
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
        error,
      });
    }
    return getDeploymentRun(runId);
  })();
}

export function listPreparedDeploymentRuns(): DeploymentRunRow[] {
  return db.query("SELECT * FROM deployment_runs WHERE status='prepared' ORDER BY created_at, id")
    .all() as DeploymentRunRow[];
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
    if (failDeploymentRun(
      run.id,
      `Deployment runner stopped while the durable run was in ${run.status}; its external outcome is ambiguous.`,
      "ambiguous",
    )) recovered += 1;
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
  deploymentIntentCapabilityDigest: string,
) {
  if (!/^[0-9a-f]{64}$/.test(deploymentIntentCapabilityDigest)) {
    throw new Error("Deployment intent capability digest is invalid.");
  }
  db.transaction(() => {
    const wake = db.query(`UPDATE deployment_wakes
      SET provider_admission_intended_at=COALESCE(provider_admission_intended_at, CURRENT_TIMESTAMP),
          updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND turn_id=? AND status='running' AND owner_instance_id=?`)
      .run(wakeId, turnId, ownerInstanceId);
    if (wake.changes !== 1) throw new Error(`Deployment wake ${wakeId} lost its execution lease.`);
    const turn = db.query(`UPDATE turns
      SET provider_admission_intended_at=COALESCE(provider_admission_intended_at, CURRENT_TIMESTAMP),
          deployment_intent_capability_digest=?
      WHERE id=? AND status='running' AND owner_instance_id=?`)
      .run(deploymentIntentCapabilityDigest, turnId, ownerInstanceId);
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
