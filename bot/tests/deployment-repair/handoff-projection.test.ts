import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { acquireDatabaseTestLock } from "../db-lock";
import type { DeploymentHandoffRow } from "../../../deployment-control/kernel/state";
import { reconcileDeploymentWork } from "../../src/deployment-worker";
import type { ControlHandoffKernelServices } from "../../src/deployment-repair/handoff-worker";
import { getControlHandoffProjection } from "../../src/deployment-repair/handoff-projection";

const state = require("../../src/state");
const { db, getSession, upsertChannel, upsertSession } = state;
let releaseDatabaseTestLock: (() => void) | null = null;

function clearState() {
  db.query("DELETE FROM deployment_control_handoff_projections").run();
  db.query("DELETE FROM deployment_notices").run();
  db.query("DELETE FROM deployment_wakes").run();
  db.query("DELETE FROM deployment_requests").run();
  db.query("DELETE FROM deployment_run_events").run();
  db.query("DELETE FROM deployment_runs").run();
  db.query("DELETE FROM slack_thread_statuses").run();
  db.query("DELETE FROM slack_user_input_claims").run();
  db.query("DELETE FROM turn_steering_messages").run();
  db.query("DELETE FROM turn_delivery_chunks").run();
  db.query("DELETE FROM turn_artifact_deliveries").run();
  db.query("DELETE FROM turn_artifact_batches").run();
  db.query("DELETE FROM turn_reaction_cleanups").run();
  db.query("DELETE FROM turns").run();
  db.query("DELETE FROM sessions").run();
  db.query("DELETE FROM process_instances").run();
  db.query("DELETE FROM channels").run();
}

function session(providerSession = "provider-session") {
  upsertChannel({
    slack_channel_id: "C-project",
    slack_channel_name: "project",
    group_name: null,
    name: "Project",
    vault_path: "/tmp",
    code_path: "/tmp",
  });
  upsertSession("C-project", "1700000000.000001", "codex", providerSession, { status: "idle" });
  return getSession("C-project", "1700000000.000001", "codex");
}

function handoff(sessionId: number, providerSession = "provider-session"): DeploymentHandoffRow {
  return {
    id: "handoff-1",
    target: "concierge",
    kind: "verification",
    attempt_id: "attempt-1",
    incident_id: null,
    source_session_id: sessionId,
    slack_channel_id: "C-project",
    slack_thread_ts: "1700000000.000001",
    requested_by_user_id: "U-operator",
    provider_id: "codex",
    provider_model: "gpt-5.6",
    reasoning_effort: "high",
    provider_session_uuid: providerSession,
    payload_json: JSON.stringify({
      attempt_id: "attempt-1",
      requested_commits: ["a".repeat(40)],
      deployed_commit: "b".repeat(40),
      service_invocation_id: "invocation-1",
      evidence: { service_probe: "passed", capture_probe: "passed" },
    }),
    status: "pending",
    owner_instance_id: null,
    idempotency_key: "deployment-verification:attempt-1:session",
    error: null,
    created_at: "2026-08-24 00:00:00",
    updated_at: "2026-08-24 00:00:00",
  };
}

function kernelServices(item: DeploymentHandoffRow) {
  const calls: string[] = [];
  const services: ControlHandoffKernelServices = {
    list: async () => [item],
    claim: async (candidate, owner) => { calls.push(`claim:${candidate.id}:${owner}`); },
    settle: async (id, owner, outcome) => { calls.push(`settle:${id}:${owner}:${outcome}`); },
  };
  return { calls, services };
}

beforeEach(async () => {
  releaseDatabaseTestLock = await acquireDatabaseTestLock();
  clearState();
});

afterEach(() => {
  clearState();
  releaseDatabaseTestLock?.();
  releaseDatabaseTestLock = null;
});

describe("control-plane verification handoff projection", () => {
  test("projects one kernel handoff into the exact provider turn and settles it monotonically", async () => {
    const existing = session();
    const fixture = kernelServices(handoff(existing.id));
    let executed = 0;
    const result = await reconcileDeploymentWork({
      client: {},
      ownerInstanceId: "bot-instance",
      isOwnerAlive: () => true,
      shouldStop: () => false,
      services: {
        launchRun: async () => { throw new Error("legacy run launch was not expected"); },
        controlHandoffs: fixture.services,
        executeWake: async (claim) => {
          executed += 1;
          expect(claim.session.agent_session_uuid).toBe("provider-session");
          expect(claim.wake.prompt).toContain("Deployment attempt: attempt-1");
          db.query("UPDATE turns SET status='done', agent_text='verified' WHERE id=?").run(claim.turnId);
          db.query("UPDATE sessions SET status='idle' WHERE id=?").run(claim.session.id);
        },
      },
    });

    expect(result.wakesStarted).toBe(1);
    expect(executed).toBe(1);
    expect(fixture.calls).toEqual([
      "claim:handoff-1:projection:handoff-1",
      "settle:handoff-1:projection:handoff-1:delivered",
    ]);
    expect(getControlHandoffProjection("handoff-1")).toMatchObject({
      status: "settled",
      outcome: "delivered",
    });
  });

  test("mapping drift parks without posting an infrastructure failure to the feature thread", async () => {
    const existing = session("current-provider-session");
    const fixture = kernelServices(handoff(existing.id, "stale-provider-session"));
    let executed = 0;
    const result = await reconcileDeploymentWork({
      client: {},
      ownerInstanceId: "bot-instance",
      isOwnerAlive: () => true,
      shouldStop: () => false,
      services: {
        launchRun: async () => { throw new Error("legacy run launch was not expected"); },
        controlHandoffs: fixture.services,
        executeWake: async () => { executed += 1; },
      },
    });

    expect(result.wakesStarted).toBe(0);
    expect(executed).toBe(0);
    expect(fixture.calls.at(-1)).toBe("settle:handoff-1:projection:handoff-1:parked");
    expect(db.query("SELECT count(*) AS count FROM deployment_notices").get()).toEqual({ count: 0 });
    expect(getControlHandoffProjection("handoff-1")).toMatchObject({ status: "settled", outcome: "parked" });
  });
});
