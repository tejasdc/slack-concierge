import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { acquireDatabaseTestLock } from "./db-lock";
import {
  claimDeploymentRun,
  claimDeploymentWake,
  completeDeploymentRun,
  deploymentContinuationForAgent,
  deploymentContinuationForCapability,
  deploymentIntentCapabilityDigest,
  failDeploymentRun,
  getDeploymentRun,
  getDeploymentWake,
  listDeploymentRequests,
  listDeploymentRunEvents,
  listPendingDeploymentNotices,
  listPendingDeploymentWakes,
  markDeploymentWakeAdmissionIntended,
  recordDeploymentRunPhase,
  recoverDeadDeploymentRuns,
  recoverDeploymentWakeClaims,
  requestDeployment,
  settleDeploymentWakeFromTurn,
} from "../src/deployment-state";
import { reconcileDeploymentWork } from "../src/deployment-worker";
import { assertAgentDeploymentProject } from "../src/deployment-repair/intent-request";
import { slackBucket } from "../src/rate-limit";

const state = require("../src/state");
const {
  acquireSessionTurn,
  claimNextQueuedTurn,
  db,
  finishTurn,
  getSession,
  upsertChannel,
  upsertSession,
} = state;

let releaseDatabaseTestLock: (() => void) | null = null;

function clearDeploymentState() {
  db.query("DELETE FROM deployment_notices").run();
  db.query("DELETE FROM deployment_wakes").run();
  db.query("DELETE FROM deployment_requests").run();
  db.query("DELETE FROM deployment_run_events").run();
  db.query("DELETE FROM deployment_runs").run();
  db.query("DELETE FROM turns").run();
  db.query("DELETE FROM sessions").run();
  db.query("DELETE FROM process_instances").run();
  db.query("DELETE FROM channels").run();
}

beforeEach(async () => {
  releaseDatabaseTestLock = await acquireDatabaseTestLock();
  clearDeploymentState();
  slackBucket.reset();
});

afterEach(() => {
  clearDeploymentState();
  releaseDatabaseTestLock?.();
  releaseDatabaseTestLock = null;
});

function sourceTurn(input: {
  channel?: string;
  thread?: string;
  owner?: string;
  provider?: "codex" | "claude-code";
  providerSession?: string;
  user?: string;
  model?: string;
  reasoningEffort?: string;
}) {
  const channel = input.channel || "C1";
  const thread = input.thread || "100.000001";
  const owner = input.owner || `owner-${thread}`;
  const provider = input.provider || "codex";
  upsertChannel({
    slack_channel_id: channel,
    slack_channel_name: channel.toLowerCase(),
    group_name: null,
    name: channel,
    vault_path: "/tmp",
    code_path: "/tmp",
  });
  upsertSession(channel, thread, provider, input.providerSession || `provider-${thread}`, {
    status: "running",
  });
  const session = getSession(channel, thread, provider);
  const turn = db.query(`INSERT INTO turns (
    session_id, slack_user_msg_ts, slack_reply_thread_ts, user_text, status,
    owner_instance_id, requested_by_user_id, provider_model, reasoning_effort
  ) VALUES (?, ?, ?, 'deploy', 'running', ?, ?, ?, ?) RETURNING id`).get(
    session.id,
    `${thread}-message`,
    thread,
    owner,
    input.user || "U1",
    input.model || "gpt-test",
    input.reasoningEffort || "high",
  ) as { id: number };
  return { turnId: turn.id, sessionId: session.id, owner, channel, thread, provider };
}

function advanceToRelease(runId: string) {
  claimDeploymentRun({ runId, pid: 123, bootId: "boot", startTicks: "ticks" });
  recordDeploymentRunPhase(runId, "updating", { gate: "claimed" });
  recordDeploymentRunPhase(runId, "restarting", { deployed_commit: "candidate" });
  recordDeploymentRunPhase(runId, "verifying", { probe: "started" });
  recordDeploymentRunPhase(runId, "releasing", { gates: "released" });
}

describe("durable deployment coordination", () => {
  test("resolves the one current turn when a resumed provider thread retains stale turn environment", () => {
    const stale = sourceTurn({ thread: "45.000001", owner: "owner-before-restart" });
    const capability = "a".repeat(64);
    db.query("UPDATE turns SET deployment_intent_capability_digest=? WHERE id=?")
      .run(deploymentIntentCapabilityDigest(capability), stale.turnId);
    db.query("UPDATE turns SET status='done', owner_instance_id=NULL WHERE id=?").run(stale.turnId);
    db.query("UPDATE sessions SET slack_thread_ts='single-persistent:C1' WHERE id=?").run(stale.sessionId);
    const current = db.query(`INSERT INTO turns (
      session_id, slack_user_msg_ts, slack_reply_thread_ts, user_text, status,
      owner_instance_id, requested_by_user_id
    ) VALUES (?, '45.000003', ?, 'deploy now', 'running', 'owner-current', 'U1') RETURNING id`).get(
      stale.sessionId,
      stale.thread,
    ) as { id: number };

    const continuation = deploymentContinuationForCapability({
      capability,
      sourceTurnId: stale.turnId,
      sourceSessionId: stale.sessionId,
      slackChannelId: stale.channel,
      slackThreadTs: stale.thread,
    });

    expect(continuation).toMatchObject({
      sourceTurnId: current.id,
      sourceSessionId: stale.sessionId,
      ownerInstanceId: "owner-current",
      slackChannelId: stale.channel,
      slackThreadTs: stale.thread,
      projectPath: "/tmp",
    });
    const registry = {
      schema_version: 1 as const,
      projects: [{
        id: "project-a",
        stable_path: "/tmp",
        socket_path: "/run/provider/project-a.sock",
        scratch_path: "/var/lib/provider-scratch/project-a",
        allowed_paths: ["/tmp"],
      }],
    };
    expect(assertAgentDeploymentProject(continuation, "project-a", registry).id).toBe("project-a");
    expect(() => assertAgentDeploymentProject(continuation, "project-b", registry))
      .toThrow("does not own the current provider session");
    expect(() => deploymentContinuationForAgent({
      sourceTurnId: current.id,
      ownerInstanceId: "wrong-current-owner",
      sourceSessionId: stale.sessionId,
      slackChannelId: stale.channel,
      slackThreadTs: stale.thread,
    })).toThrow(`Deployment source turn ${current.id} is not owned by this live agent turn.`);
    expect(() => deploymentContinuationForAgent({
      sourceTurnId: stale.turnId,
      ownerInstanceId: stale.owner,
      sourceSessionId: stale.sessionId,
      slackChannelId: stale.channel,
      slackThreadTs: "wrong-thread",
    })).toThrow("must have exactly one owned running turn; found 0");
  });

  test("a turn capability cannot select another running turn in the same project", () => {
    const authorized = sourceTurn({ thread: "46.000001", owner: "owner-authorized" });
    const other = sourceTurn({ thread: "46.000002", owner: "owner-other" });
    const capability = "b".repeat(64);
    db.query("UPDATE turns SET deployment_intent_capability_digest=? WHERE id=?")
      .run(deploymentIntentCapabilityDigest(capability), authorized.turnId);

    expect(() => deploymentContinuationForCapability({
      capability,
      sourceTurnId: other.turnId,
      sourceSessionId: other.sessionId,
      slackChannelId: other.channel,
      slackThreadTs: other.thread,
    })).toThrow("does not match its persisted turn context");
    expect(deploymentContinuationForCapability({
      capability,
      sourceTurnId: authorized.turnId,
      sourceSessionId: authorized.sessionId,
      slackChannelId: authorized.channel,
      slackThreadTs: authorized.thread,
    })).toMatchObject({ sourceTurnId: authorized.turnId, sourceSessionId: authorized.sessionId });
  });

  test("snapshots the user and provider configuration captured at normal turn admission", () => {
    upsertChannel({
      slack_channel_id: "C_METADATA",
      slack_channel_name: "metadata",
      group_name: null,
      name: "Metadata",
      vault_path: "/tmp",
      code_path: "/tmp",
    });
    upsertSession("C_METADATA", "50.000001", "codex", "provider-metadata", { status: "idle" });
    const session = getSession("C_METADATA", "50.000001", "codex");
    const turn = acquireSessionTurn(
      session.id,
      "50.000010",
      "deploy",
      "owner-metadata",
      undefined,
      "50.000001",
      { userId: "U_METADATA", providerModel: "gpt-metadata", reasoningEffort: "xhigh" },
    );

    const request = requestDeployment({
      sourceTurnId: turn.id,
      ownerInstanceId: "owner-metadata",
      expectedCommit: "1".repeat(40),
    }).request;

    expect(request).toMatchObject({
      requested_by_user_id: "U_METADATA",
      provider_model: "gpt-metadata",
      reasoning_effort: "xhigh",
      provider_session_uuid: "provider-metadata",
    });
  });

  test("coalesces concurrent agent requests into one fixed run and preserves each request", () => {
    const first = sourceTurn({ thread: "100.000001", owner: "owner-1" });
    const second = sourceTurn({ thread: "200.000001", owner: "owner-2", provider: "claude-code" });
    const firstRequest = requestDeployment({
      sourceTurnId: first.turnId,
      ownerInstanceId: first.owner,
      expectedCommit: "a".repeat(40),
    });
    const secondRequest = requestDeployment({
      sourceTurnId: second.turnId,
      ownerInstanceId: second.owner,
      expectedCommit: "b".repeat(40),
    });
    const retried = requestDeployment({
      sourceTurnId: first.turnId,
      ownerInstanceId: first.owner,
      expectedCommit: "a".repeat(40),
    });

    expect(firstRequest.launchRequired).toBeTrue();
    expect(secondRequest.launchRequired).toBeFalse();
    expect(secondRequest.run.id).toBe(firstRequest.run.id);
    expect(retried.request.id).toBe(firstRequest.request.id);
    expect(listDeploymentRequests(firstRequest.run.id)).toHaveLength(2);
    expect(firstRequest.run.unit_name).toBe(`concierge-deploy-${firstRequest.run.id.slice(0, 12)}`);
    expect(listDeploymentRunEvents(firstRequest.run.id).map((event) => event.event)).toEqual([
      "prepared",
      "request_joined",
      "request_joined",
    ]);
  });

  test("creates one real wake per exact session/thread only after provenance-checked success", () => {
    const first = sourceTurn({ thread: "300.000001", owner: "owner-1", providerSession: "codex-1" });
    const second = sourceTurn({
      thread: "400.000001",
      owner: "owner-2",
      provider: "claude-code",
      providerSession: "claude-1",
      user: "U2",
    });
    const requestedCommit = "c".repeat(40);
    const firstRequest = requestDeployment({
      sourceTurnId: first.turnId,
      ownerInstanceId: first.owner,
      expectedCommit: requestedCommit,
    });
    requestDeployment({
      sourceTurnId: second.turnId,
      ownerInstanceId: second.owner,
      expectedCommit: requestedCommit,
    });
    advanceToRelease(firstRequest.run.id);

    expect(listPendingDeploymentWakes()).toHaveLength(0);
    completeDeploymentRun({
      runId: firstRequest.run.id,
      repo: "/repo",
      deployedCommit: "d".repeat(40),
      serviceInvocationId: "invocation-1",
      evidence: { service: "ok", runtime_sha: "d".repeat(40) },
      isAncestor: () => true,
    });

    const wakes = listPendingDeploymentWakes();
    expect(wakes).toHaveLength(2);
    expect(new Set(wakes.map((wake) => wake.provider_session_uuid))).toEqual(
      new Set(["codex-1", "claude-1"]),
    );
    expect(wakes[0].prompt).toContain(`Requested commit(s): ${requestedCommit}`);
    expect(wakes[0].prompt).toContain(`Deployed commit: ${"d".repeat(40)}`);
    expect(wakes[0].prompt).toContain("Service invocation: invocation-1");
    expect(getDeploymentRun(firstRequest.run.id)).toMatchObject({
      status: "succeeded",
      deployed_commit: "d".repeat(40),
      service_invocation_id: "invocation-1",
    });
  });

  test("never starts verification for a failed or non-including deployment", () => {
    const failedSource = sourceTurn({ thread: "500.000001", owner: "owner-failed" });
    const failed = requestDeployment({
      sourceTurnId: failedSource.turnId,
      ownerInstanceId: failedSource.owner,
      expectedCommit: "e".repeat(40),
    });
    failDeploymentRun(failed.run.id, "health gate failed");

    expect(listPendingDeploymentWakes()).toHaveLength(0);
    expect(listPendingDeploymentNotices()).toHaveLength(1);
    expect(listPendingDeploymentNotices()[0]).toMatchObject({ kind: "deploy_failed" });

    const omittedSource = sourceTurn({ thread: "600.000001", owner: "owner-omitted" });
    const omitted = requestDeployment({
      sourceTurnId: omittedSource.turnId,
      ownerInstanceId: omittedSource.owner,
      expectedCommit: "f".repeat(40),
    });
    requestDeployment({
      sourceTurnId: omittedSource.turnId,
      ownerInstanceId: omittedSource.owner,
      expectedCommit: "0".repeat(40),
    });
    requestDeployment({
      sourceTurnId: omittedSource.turnId,
      ownerInstanceId: omittedSource.owner,
      expectedCommit: "9".repeat(40),
    });
    advanceToRelease(omitted.run.id);
    completeDeploymentRun({
      runId: omitted.run.id,
      repo: "/repo",
      deployedCommit: "1".repeat(40),
      serviceInvocationId: "invocation-omitted",
      evidence: { service: "ok" },
      isAncestor: (_repo, ancestor) => ancestor === "f".repeat(40),
    });

    expect(listPendingDeploymentWakes()).toHaveLength(0);
    expect(listPendingDeploymentNotices().map((notice) => notice.kind).sort()).toEqual([
      "commit_not_included",
      "deploy_failed",
    ]);
    const omittedNotice = listPendingDeploymentNotices()
      .find((notice) => notice.kind === "commit_not_included")!;
    expect(omittedNotice.text).toContain("0".repeat(40));
    expect(omittedNotice.text).toContain("9".repeat(40));
    expect(omittedNotice.text).not.toContain(`(${"f".repeat(40)}`);
  });

  test("claims a synthetic turn only against the unchanged provider session and settles it", () => {
    const source = sourceTurn({ thread: "700.000001", owner: "owner-wake", providerSession: "provider-exact" });
    const request = requestDeployment({
      sourceTurnId: source.turnId,
      ownerInstanceId: source.owner,
      expectedCommit: "2".repeat(40),
    });
    advanceToRelease(request.run.id);
    completeDeploymentRun({
      runId: request.run.id,
      repo: "/repo",
      deployedCommit: "3".repeat(40),
      serviceInvocationId: "invocation-wake",
      evidence: { service: "ok" },
      isAncestor: () => true,
    });
    db.query("UPDATE turns SET status='done' WHERE id=?").run(source.turnId);
    db.query("UPDATE sessions SET status='idle' WHERE id=?").run(source.sessionId);
    const wake = listPendingDeploymentWakes()[0];

    const claim = claimDeploymentWake(wake.id, "new-runtime");
    expect(claim?.session.agent_session_uuid).toBe("provider-exact");
    expect(claimDeploymentWake(wake.id, "other-runtime")).toBeNull();
    expect(db.query(`SELECT turn_kind, trigger_key, slack_reply_thread_ts, status
      FROM turns WHERE id=?`).get(claim!.turnId)).toMatchObject({
      turn_kind: "deployment_verification",
      trigger_key: wake.id,
      slack_reply_thread_ts: source.thread,
      status: "running",
    });

    markDeploymentWakeAdmissionIntended(wake.id, claim!.turnId, "new-runtime", "c".repeat(64));
    db.query("UPDATE turns SET status='done', agent_text='verified' WHERE id=?").run(claim!.turnId);
    expect(settleDeploymentWakeFromTurn(wake.id)).toMatchObject({ status: "delivered" });
  });

  test("keeps a verification wake behind queued work and rejects a stale-idle concurrent owner", () => {
    const source = sourceTurn({
      thread: "750.000001",
      owner: "owner-ordered-wake",
      providerSession: "provider-ordered-wake",
    });
    const request = requestDeployment({
      sourceTurnId: source.turnId,
      ownerInstanceId: source.owner,
      expectedCommit: "3".repeat(40),
    });
    advanceToRelease(request.run.id);
    completeDeploymentRun({
      runId: request.run.id,
      repo: "/repo",
      deployedCommit: "4".repeat(40),
      serviceInvocationId: "invocation-ordered-wake",
      evidence: { service: "ok" },
      isAncestor: () => true,
    });
    db.query("UPDATE turns SET status='done', owner_instance_id=NULL WHERE id=?").run(source.turnId);
    db.query("UPDATE sessions SET status='idle' WHERE id=?").run(source.sessionId);

    const live = acquireSessionTurn(source.sessionId, "750.000002", "live Slack turn", "slack-runtime");
    const queued = acquireSessionTurn(source.sessionId, "750.000003", "queued Slack turn", "slack-runtime");
    const wake = listPendingDeploymentWakes()[0];
    expect(live.acquired).toBeTrue();
    expect(queued.queued).toBeTrue();

    db.query("UPDATE sessions SET status='idle' WHERE id=?").run(source.sessionId);
    expect(claimDeploymentWake(wake.id, "wake-runtime")).toBeNull();
    expect(db.query("SELECT COUNT(*) AS count FROM turns WHERE turn_kind='deployment_verification'").get())
      .toEqual({ count: 0 });

    finishTurn(live.id, "done", "live done");
    db.query("UPDATE sessions SET status='idle' WHERE id=?").run(source.sessionId);
    expect(claimDeploymentWake(wake.id, "wake-runtime")).toBeNull();
    expect(claimNextQueuedTurn("queue-runtime")).toMatchObject({ turn_id: queued.id });

    db.query("UPDATE sessions SET status='idle' WHERE id=?").run(source.sessionId);
    expect(claimDeploymentWake(wake.id, "wake-runtime")).toBeNull();
    expect(db.query(`SELECT COUNT(*) AS count FROM turns
      WHERE session_id=? AND status IN ('running', 'delivering')`).get(source.sessionId))
      .toEqual({ count: 1 });

    finishTurn(queued.id, "done", "queued done");
    db.query("UPDATE sessions SET status='idle' WHERE id=?").run(source.sessionId);
    expect(claimDeploymentWake(wake.id, "wake-runtime")?.turnId).toBeNumber();
  });

  test("parks rather than substituting a fresh session when provider mapping changed", () => {
    const source = sourceTurn({ thread: "800.000001", owner: "owner-map", providerSession: "provider-original" });
    const request = requestDeployment({
      sourceTurnId: source.turnId,
      ownerInstanceId: source.owner,
      expectedCommit: "4".repeat(40),
    });
    advanceToRelease(request.run.id);
    completeDeploymentRun({
      runId: request.run.id,
      repo: "/repo",
      deployedCommit: "5".repeat(40),
      serviceInvocationId: "invocation-map",
      evidence: { service: "ok" },
      isAncestor: () => true,
    });
    db.query("UPDATE turns SET status='done' WHERE id=?").run(source.turnId);
    db.query("UPDATE sessions SET status='idle', agent_session_uuid='provider-replaced' WHERE id=?")
      .run(source.sessionId);
    const wake = listPendingDeploymentWakes()[0];

    expect(claimDeploymentWake(wake.id, "new-runtime")).toBeNull();
    expect(getDeploymentWake(wake.id)).toMatchObject({ status: "parked" });
    expect(listPendingDeploymentNotices()[0]).toMatchObject({ kind: "wake_parked" });
    expect(db.query("SELECT COUNT(*) AS count FROM turns WHERE turn_kind='deployment_verification'")
      .get()).toMatchObject({ count: 0 });
  });

  test("parks an errored provider session without creating or executing a verification turn", async () => {
    const source = sourceTurn({
      thread: "850.000001",
      owner: "owner-error",
      providerSession: "provider-error",
    });
    const request = requestDeployment({
      sourceTurnId: source.turnId,
      ownerInstanceId: source.owner,
      expectedCommit: "5".repeat(40),
    });
    advanceToRelease(request.run.id);
    completeDeploymentRun({
      runId: request.run.id,
      repo: "/repo",
      deployedCommit: "6".repeat(40),
      serviceInvocationId: "invocation-error",
      evidence: { service: "ok" },
      isAncestor: () => true,
    });
    db.query("UPDATE turns SET status='error' WHERE id=?").run(source.turnId);
    db.query("UPDATE sessions SET status='error' WHERE id=?").run(source.sessionId);
    let providerCalls = 0;

    const result = await reconcileDeploymentWork({
      client: {},
      ownerInstanceId: "worker-runtime",
      isOwnerAlive: () => true,
      shouldStop: () => false,
      services: {
        launchRun: async () => { throw new Error("no launch expected"); },
        executeWake: async () => { providerCalls += 1; },
      },
    });

    expect(result.wakesStarted).toBe(0);
    expect(providerCalls).toBe(0);
    expect(db.query("SELECT status FROM deployment_wakes WHERE run_id=?").get(request.run.id))
      .toMatchObject({ status: "parked" });
    expect(db.query("SELECT COUNT(*) AS count FROM turns WHERE turn_kind='deployment_verification'")
      .get()).toMatchObject({ count: 0 });
  });

  test("retries only before provider admission and parks ambiguous post-admission recovery", () => {
    const before = sourceTurn({ thread: "900.000001", owner: "owner-before", providerSession: "provider-before" });
    const beforeRequest = requestDeployment({
      sourceTurnId: before.turnId,
      ownerInstanceId: before.owner,
      expectedCommit: "6".repeat(40),
    });
    advanceToRelease(beforeRequest.run.id);
    completeDeploymentRun({
      runId: beforeRequest.run.id,
      repo: "/repo",
      deployedCommit: "7".repeat(40),
      serviceInvocationId: "invocation-before",
      evidence: { service: "ok" },
      isAncestor: () => true,
    });
    db.query("UPDATE turns SET status='done' WHERE id=?").run(before.turnId);
    db.query("UPDATE sessions SET status='idle' WHERE id=?").run(before.sessionId);
    const beforeWake = listPendingDeploymentWakes()[0];
    claimDeploymentWake(beforeWake.id, "dead-before");

    expect(recoverDeploymentWakeClaims(() => false)).toEqual({ retried: 1, parked: 0, settled: 0 });
    expect(getDeploymentWake(beforeWake.id)).toMatchObject({ status: "pending", turn_id: null });

    const reclaimed = claimDeploymentWake(beforeWake.id, "dead-after")!;
    markDeploymentWakeAdmissionIntended(beforeWake.id, reclaimed.turnId, "dead-after", "d".repeat(64));
    expect(recoverDeploymentWakeClaims(() => false)).toEqual({ retried: 0, parked: 1, settled: 0 });
    expect(getDeploymentWake(beforeWake.id)).toMatchObject({ status: "parked" });
  });

  test("lets ordinary delivery recovery finish an admitted wake response", () => {
    const source = sourceTurn({ thread: "905.000001", owner: "owner-delivery", providerSession: "provider-delivery" });
    const request = requestDeployment({
      sourceTurnId: source.turnId,
      ownerInstanceId: source.owner,
      expectedCommit: "7".repeat(40),
    });
    advanceToRelease(request.run.id);
    completeDeploymentRun({
      runId: request.run.id,
      repo: "/repo",
      deployedCommit: "8".repeat(40),
      serviceInvocationId: "invocation-delivery",
      evidence: { service: "ok" },
      isAncestor: () => true,
    });
    db.query("UPDATE turns SET status='done' WHERE id=?").run(source.turnId);
    db.query("UPDATE sessions SET status='idle' WHERE id=?").run(source.sessionId);
    const wake = listPendingDeploymentWakes()[0];
    const claim = claimDeploymentWake(wake.id, "dead-delivery")!;
    markDeploymentWakeAdmissionIntended(wake.id, claim.turnId, "dead-delivery", "e".repeat(64));
    db.query("UPDATE turns SET status='delivering' WHERE id=?").run(claim.turnId);

    expect(recoverDeploymentWakeClaims(() => false)).toEqual({ retried: 0, parked: 0, settled: 0 });
    expect(getDeploymentWake(wake.id)).toMatchObject({ status: "running" });
    db.query("UPDATE turns SET status='done' WHERE id=?").run(claim.turnId);
    expect(recoverDeploymentWakeClaims(() => false)).toEqual({ retried: 0, parked: 0, settled: 1 });
    expect(getDeploymentWake(wake.id)).toMatchObject({ status: "delivered" });
  });

  test("classifies a dead deployment runner as ambiguous and queues failure notices", () => {
    const source = sourceTurn({ thread: "910.000001", owner: "owner-runner" });
    const request = requestDeployment({
      sourceTurnId: source.turnId,
      ownerInstanceId: source.owner,
      expectedCommit: "8".repeat(40),
    });
    claimDeploymentRun({ runId: request.run.id, pid: 444, bootId: "dead-boot", startTicks: "dead-ticks" });

    expect(recoverDeadDeploymentRuns(() => false)).toBe(1);
    expect(getDeploymentRun(request.run.id)).toMatchObject({ status: "ambiguous" });
    expect(listPendingDeploymentWakes()).toHaveLength(0);
    expect(listPendingDeploymentNotices()[0]).toMatchObject({ kind: "deploy_failed" });
  });

  test("rejects skipped deployment phases", () => {
    const source = sourceTurn({ thread: "920.000001", owner: "owner-phase" });
    const request = requestDeployment({
      sourceTurnId: source.turnId,
      ownerInstanceId: source.owner,
      expectedCommit: "9".repeat(40),
    });
    claimDeploymentRun({ runId: request.run.id, pid: 555, bootId: "boot", startTicks: "ticks" });

    expect(() => recordDeploymentRunPhase(request.run.id, "restarting")).toThrow(
      "cannot transition draining -> restarting",
    );
  });

  test("worker launches prepared runs and executes each claimed wake as a turn", async () => {
    const source = sourceTurn({ thread: "930.000001", owner: "owner-worker", providerSession: "provider-worker" });
    const request = requestDeployment({
      sourceTurnId: source.turnId,
      ownerInstanceId: source.owner,
      expectedCommit: "a".repeat(40),
    });
    const launches: string[] = [];
    let result = await reconcileDeploymentWork({
      client: {},
      ownerInstanceId: "worker-runtime",
      isOwnerAlive: () => true,
      shouldStop: () => false,
      services: {
        launchRun: async (run) => { launches.push(run.id); },
        executeWake: async () => { throw new Error("no wake expected"); },
      },
    });
    expect(result.launched).toBe(1);
    expect(launches).toEqual([request.run.id]);

    advanceToRelease(request.run.id);
    completeDeploymentRun({
      runId: request.run.id,
      repo: "/repo",
      deployedCommit: "b".repeat(40),
      serviceInvocationId: "invocation-worker",
      evidence: { service: "ok" },
      isAncestor: () => true,
    });
    db.query("UPDATE turns SET status='done' WHERE id=?").run(source.turnId);
    db.query("UPDATE sessions SET status='idle' WHERE id=?").run(source.sessionId);
    let execution: { turnId: number; providerSession: string | null } | null = null;

    result = await reconcileDeploymentWork({
      client: {},
      ownerInstanceId: "worker-runtime",
      isOwnerAlive: () => true,
      shouldStop: () => false,
      services: {
        launchRun: async () => { throw new Error("no second launch expected"); },
        executeWake: async (claim) => {
          execution = {
            turnId: claim.turnId,
            providerSession: claim.session.agent_session_uuid,
          };
          db.query("UPDATE turns SET status='done', agent_text='live verified' WHERE id=?")
            .run(claim.turnId);
          db.query("UPDATE sessions SET status='idle' WHERE id=?").run(claim.session.id);
        },
      },
    });

    expect(result.wakesStarted).toBe(1);
    expect(execution).toMatchObject({ providerSession: "provider-worker" });
    expect(getDeploymentWake(listPendingDeploymentWakes()[0]?.id || "missing")).toBeNull();
    expect(db.query("SELECT status FROM deployment_wakes WHERE run_id=?").get(request.run.id))
      .toMatchObject({ status: "delivered" });
  });

  test("worker delivers failure notice without executing a verification turn", async () => {
    const source = sourceTurn({ thread: "940.000001", owner: "owner-notice" });
    const request = requestDeployment({
      sourceTurnId: source.turnId,
      ownerInstanceId: source.owner,
      expectedCommit: "c".repeat(40),
    });
    failDeploymentRun(request.run.id, "functional probe failed");
    const posts: any[] = [];

    const result = await reconcileDeploymentWork({
      client: {
        chat: {
          postMessage: async (args: any) => {
            posts.push(args);
            return { ok: true, ts: "notice-1" };
          },
        },
      },
      ownerInstanceId: "worker-runtime",
      isOwnerAlive: () => true,
      shouldStop: () => false,
      services: {
        launchRun: async () => { throw new Error("no launch expected"); },
        executeWake: async () => { throw new Error("failed deploy must not wake an agent"); },
      },
    });

    expect(result.wakesStarted).toBe(0);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ channel: source.channel, thread_ts: source.thread });
    expect(posts[0].text).toContain("No verification agent was started");
    expect(db.query("SELECT status FROM deployment_notices WHERE run_id=?").get(request.run.id))
      .toMatchObject({ status: "delivered" });
  });

  test("worker releases a synthetic session lock when execution fails before admission", async () => {
    const source = sourceTurn({ thread: "950.000001", owner: "owner-pre-admission" });
    const request = requestDeployment({
      sourceTurnId: source.turnId,
      ownerInstanceId: source.owner,
      expectedCommit: "d".repeat(40),
    });
    advanceToRelease(request.run.id);
    completeDeploymentRun({
      runId: request.run.id,
      repo: "/repo",
      deployedCommit: "e".repeat(40),
      serviceInvocationId: "invocation-pre-admission",
      evidence: { service: "ok" },
      isAncestor: () => true,
    });
    db.query("UPDATE turns SET status='done' WHERE id=?").run(source.turnId);
    db.query("UPDATE sessions SET status='idle' WHERE id=?").run(source.sessionId);

    const result = await reconcileDeploymentWork({
      client: {},
      ownerInstanceId: "worker-runtime",
      isOwnerAlive: () => true,
      shouldStop: () => false,
      services: {
        launchRun: async () => { throw new Error("no launch expected"); },
        executeWake: async () => { throw new Error("channel disappeared"); },
      },
    });

    expect(result.wakesStarted).toBe(1);
    const wake = db.query("SELECT status, turn_id FROM deployment_wakes WHERE run_id=?")
      .get(request.run.id) as any;
    expect(wake.status).toBe("parked");
    expect(db.query("SELECT status FROM turns WHERE id=?").get(wake.turn_id))
      .toMatchObject({ status: "cancelled" });
    expect(db.query("SELECT status FROM sessions WHERE id=?").get(source.sessionId))
      .toMatchObject({ status: "idle" });
  });
});
