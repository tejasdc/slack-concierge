import { db } from "../state";
import type { DeploymentHandoffRow } from "../../../deployment-control/kernel/state";

export interface ControlHandoffProjectionRow {
  handoff_id: string;
  attempt_id: string;
  handoff_json: string;
  kernel_owner_key: string;
  status: "prepared" | "claimed" | "settled" | "ambiguous";
  outcome: "delivered" | "parked" | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

db.exec(`
CREATE TABLE IF NOT EXISTS deployment_control_handoff_projections (
  handoff_id       TEXT PRIMARY KEY,
  attempt_id       TEXT NOT NULL,
  handoff_json     TEXT NOT NULL,
  kernel_owner_key TEXT NOT NULL,
  status           TEXT NOT NULL CHECK(status IN ('prepared', 'claimed', 'settled', 'ambiguous')),
  outcome          TEXT CHECK(outcome IN ('delivered', 'parked')),
  error            TEXT,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

function parsePayload(handoff: DeploymentHandoffRow) {
  if (handoff.kind !== "verification" || !handoff.attempt_id) {
    throw new Error(`Control handoff ${handoff.id} is not a deployment verification handoff.`);
  }
  const payload = JSON.parse(handoff.payload_json);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`Control handoff ${handoff.id} has an invalid payload.`);
  }
  const commits = payload.requested_commits;
  if (!Array.isArray(commits) || commits.length < 1 || commits.some((commit) => !/^[0-9a-f]{40}$/.test(String(commit)))) {
    throw new Error(`Control handoff ${handoff.id} has invalid requested commits.`);
  }
  if (!/^[0-9a-f]{40}$/.test(String(payload.deployed_commit))) {
    throw new Error(`Control handoff ${handoff.id} has an invalid deployed commit.`);
  }
  if (typeof payload.service_invocation_id !== "string" || !payload.service_invocation_id) {
    throw new Error(`Control handoff ${handoff.id} has an invalid service invocation.`);
  }
  return payload as {
    requested_commits: string[];
    deployed_commit: string;
    service_invocation_id: string;
    evidence: Record<string, unknown>;
  };
}

function prompt(handoff: DeploymentHandoffRow) {
  const payload = parsePayload(handoff);
  return [
    "The deployment you requested has completed and passed its functional health gate.",
    "This is an internal deployment-verification turn in the same durable provider session and Slack thread; it is not a new user request.",
    `Deployment attempt: ${handoff.attempt_id}`,
    `Requested commit(s): ${payload.requested_commits.join(", ")}`,
    `Deployed commit: ${payload.deployed_commit}`,
    `Service invocation: ${payload.service_invocation_id}`,
    `Health evidence: ${JSON.stringify(payload.evidence)}`,
    "Inspect the live service and verify that the requested changes are working. Run the smallest meaningful live checks. If the change is broken, diagnose and fix it, obtain independent review, commit and push the correction, request deployment through bot/scripts/deploy.sh, and verify again. Report concrete evidence in the thread; do not merely acknowledge this message.",
  ].join("\n\n");
}

export function getControlHandoffProjection(handoffId: string) {
  return db.query("SELECT * FROM deployment_control_handoff_projections WHERE handoff_id=?")
    .get(handoffId) as ControlHandoffProjectionRow | null;
}

export function prepareControlHandoffProjection(handoff: DeploymentHandoffRow) {
  parsePayload(handoff);
  db.query(`INSERT INTO deployment_control_handoff_projections
    (handoff_id, attempt_id, handoff_json, kernel_owner_key, status)
    VALUES (?, ?, ?, ?, 'prepared') ON CONFLICT(handoff_id) DO NOTHING`)
    .run(handoff.id, handoff.attempt_id!, JSON.stringify(handoff), `projection:${handoff.id}`);
  const projection = getControlHandoffProjection(handoff.id)!;
  if (projection.handoff_json !== JSON.stringify(handoff)) {
    throw new Error(`Control handoff ${handoff.id} changed after projection was persisted.`);
  }
  return projection;
}

export function listUnsettledControlHandoffProjections() {
  return db.query(`SELECT * FROM deployment_control_handoff_projections
    WHERE status IN ('prepared', 'claimed') ORDER BY created_at, handoff_id`)
    .all() as ControlHandoffProjectionRow[];
}

export function activateControlHandoffProjection(handoffId: string) {
  return db.transaction(() => {
    const projection = getControlHandoffProjection(handoffId);
    if (!projection) throw new Error(`Unknown control handoff projection ${handoffId}.`);
    if (projection.status === "claimed") return projection;
    if (projection.status !== "prepared") throw new Error(`Control handoff ${handoffId} cannot activate from ${projection.status}.`);
    const handoff = JSON.parse(projection.handoff_json) as DeploymentHandoffRow;
    const payload = parsePayload(handoff);
    const unitName = `control-projection-${projection.attempt_id}`;
    db.query(`INSERT INTO deployment_runs (
      id, target, unit_name, status, deployed_commit, service_invocation_id,
      evidence_json, created_at, updated_at, completed_at
    ) VALUES (?, 'concierge-control-projection', ?, 'succeeded', ?, ?, ?,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO NOTHING`).run(
      projection.attempt_id,
      unitName,
      payload.deployed_commit,
      payload.service_invocation_id,
      JSON.stringify(payload.evidence),
    );
    db.query(`INSERT INTO deployment_wakes (
      id, run_id, session_id, slack_channel_id, slack_thread_ts,
      requested_by_user_id, provider_id, provider_model, reasoning_effort,
      provider_session_uuid, control_handoff_id, prompt, status, next_attempt_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0)
    ON CONFLICT(id) DO NOTHING`).run(
      handoff.id,
      projection.attempt_id,
      handoff.source_session_id,
      handoff.slack_channel_id,
      handoff.slack_thread_ts,
      handoff.requested_by_user_id,
      handoff.provider_id,
      handoff.provider_model,
      handoff.reasoning_effort,
      handoff.provider_session_uuid,
      handoff.id,
      prompt(handoff),
    );
    db.query(`UPDATE deployment_control_handoff_projections
      SET status='claimed', error=NULL, updated_at=CURRENT_TIMESTAMP
      WHERE handoff_id=? AND status='prepared'`).run(handoffId);
    return getControlHandoffProjection(handoffId)!;
  })();
}

export function controlHandoffSettlements() {
  return db.query(`SELECT projection.*, wake.status AS wake_status, wake.error AS wake_error
    FROM deployment_control_handoff_projections projection
    JOIN deployment_wakes wake ON wake.control_handoff_id=projection.handoff_id
    WHERE projection.status='claimed' AND wake.status IN ('delivered', 'parked')
    ORDER BY projection.created_at, projection.handoff_id`).all() as Array<ControlHandoffProjectionRow & {
      wake_status: "delivered" | "parked";
      wake_error: string | null;
    }>;
}

export function settleControlHandoffProjection(
  handoffId: string,
  outcome: "delivered" | "parked",
  error: string | null,
) {
  const updated = db.query(`UPDATE deployment_control_handoff_projections
    SET status='settled', outcome=?, error=?, updated_at=CURRENT_TIMESTAMP
    WHERE handoff_id=? AND status='claimed'`).run(outcome, error, handoffId);
  if (updated.changes !== 1) {
    const existing = getControlHandoffProjection(handoffId);
    if (existing?.status === "settled" && existing.outcome === outcome) return existing;
    throw new Error(`Control handoff projection ${handoffId} could not settle as ${outcome}.`);
  }
  return getControlHandoffProjection(handoffId)!;
}

export function markControlHandoffProjectionAmbiguous(handoffId: string, error: string) {
  db.query(`UPDATE deployment_control_handoff_projections
    SET status='ambiguous', error=?, updated_at=CURRENT_TIMESTAMP
    WHERE handoff_id=? AND status IN ('prepared', 'claimed')`).run(error, handoffId);
  return getControlHandoffProjection(handoffId);
}
