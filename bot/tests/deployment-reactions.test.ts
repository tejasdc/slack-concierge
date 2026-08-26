import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginDeploymentRepair,
  claimDeploymentRun,
  completeDeploymentRun,
  getDeploymentTurnReaction,
  parkDeploymentRepair,
  recordDeploymentRunPhase,
  registerDeploymentTurnReactionTargets,
  requestAutomaticDeployment,
} from "../src/deployment-state";
import { deploymentReactionTargetsForCommitRange } from "../src/deployment-reaction-provenance";
import { reconcileDeploymentWork } from "../src/deployment-worker";
import { slackBucket } from "../src/rate-limit";
import {
  db,
  getOrCreateTurnCommitProvenance,
  getSession,
  upsertChannel,
  upsertSession,
} from "../src/state";
import { acquireDatabaseTestLock } from "./db-lock";

let releaseDatabaseTestLock: (() => void) | null = null;
let repositoryRoot = "";
let priorConciergeRepository: string | undefined;
let channelId = "";
let deploymentTarget = "";

function clearDeploymentState() {
  db.query("DELETE FROM deployment_turn_reactions").run();
  db.query("DELETE FROM deployment_desired_state").run();
  db.query("DELETE FROM deployment_repair_agent_runs").run();
  db.query("DELETE FROM deployment_repair_incidents").run();
  db.query("DELETE FROM deployment_releases").run();
  db.query("DELETE FROM deployment_notices").run();
  db.query("DELETE FROM deployment_wakes").run();
  db.query("DELETE FROM deployment_requests").run();
  db.query("DELETE FROM deployment_run_events").run();
  db.query("DELETE FROM deployment_runs").run();
}

function clearOwnedTurns() {
  if (!channelId) return;
  db.query("DELETE FROM turn_delivery_chunks WHERE turn_id IN (SELECT id FROM turns WHERE session_id IN (SELECT id FROM sessions WHERE slack_channel_id=?))")
    .run(channelId);
  db.query("DELETE FROM turns WHERE session_id IN (SELECT id FROM sessions WHERE slack_channel_id=?)")
    .run(channelId);
  db.query("DELETE FROM sessions WHERE slack_channel_id=?").run(channelId);
  db.query("DELETE FROM channels WHERE slack_channel_id=?").run(channelId);
}

function git(...arguments_: string[]) {
  const result = Bun.spawnSync({
    cmd: ["git", ...arguments_],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Concierge Test",
      GIT_AUTHOR_EMAIL: "concierge@example.test",
      GIT_COMMITTER_NAME: "Concierge Test",
      GIT_COMMITTER_EMAIL: "concierge@example.test",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
}

function commit(filename: string, token?: string) {
  writeFileSync(join(repositoryRoot, filename), `${filename}\n`);
  git("add", filename);
  const arguments_ = ["commit", "-m", `change ${filename}`];
  if (token) arguments_.push("-m", `Concierge-Provenance: ${token}`);
  git(...arguments_);
  return git("rev-parse", "HEAD");
}

function createTurn(rootTs: string, messageTs: string, delivered = true) {
  upsertSession(channelId, rootTs, "codex", `provider-${messageTs}`, { status: "idle" });
  const session = getSession(channelId, rootTs, "codex")!;
  const turn = db.query(`INSERT INTO turns (
    session_id, slack_user_msg_ts, slack_reply_thread_ts, user_text, status, delivery_status
  ) VALUES (?, ?, ?, 'ship this', ?, ?) RETURNING id`)
    .get(session.id, messageTs, rootTs, delivered ? "done" : "delivering", delivered ? "delivered" : "pending") as { id: number };
  const agentMessageTs = `${messageTs.slice(0, -1)}9`;
  if (delivered) {
    db.query(`INSERT INTO turn_delivery_chunks (turn_id, chunk_index, slack_ts, delivered_at)
      VALUES (?, 0, ?, CURRENT_TIMESTAMP)`).run(turn.id, agentMessageTs);
  }
  return { id: turn.id, token: getOrCreateTurnCommitProvenance(turn.id), messageTs, agentMessageTs };
}

function seedLastKnownGood(commitSha: string) {
  const runId = `seed-${commitSha.slice(0, 12)}`;
  db.query(`INSERT INTO deployment_runs (
    id, target, unit_name, status, deployed_commit, service_invocation_id, completed_at
  ) VALUES (?, 'seed', ?, 'succeeded', ?, 'seed-invocation', CURRENT_TIMESTAMP)`)
    .run(runId, `seed-unit-${commitSha.slice(0, 12)}`, commitSha);
  db.query(`INSERT INTO deployment_releases (
    artifact_digest, run_id, git_commit, source_tree_digest, runtime_digest,
    compatibility_digest, artifact_path, state, activated_at, promoted_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 'lkg', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`)
    .run("1".repeat(64), runId, commitSha, "2".repeat(64), "3".repeat(64), "4".repeat(64), `/tmp/${runId}`);
}

function advanceToRelease(runId: string) {
  claimDeploymentRun({ runId, pid: 321, bootId: "boot", startTicks: "ticks" });
  recordDeploymentRunPhase(runId, "updating");
  recordDeploymentRunPhase(runId, "restarting");
  recordDeploymentRunPhase(runId, "verifying");
  recordDeploymentRunPhase(runId, "releasing");
}

function reactionClient(calls: Array<{ method: string; timestamp: string; name: string }>) {
  return {
    reactions: {
      add: async (input: { timestamp: string; name: string }) => {
        calls.push({ method: "add", timestamp: input.timestamp, name: input.name });
        return { ok: true };
      },
      remove: async (input: { timestamp: string; name: string }) => {
        calls.push({ method: "remove", timestamp: input.timestamp, name: input.name });
        return { ok: true };
      },
    },
  };
}

async function project(client: any, desiredCommit?: string) {
  if (desiredCommit) {
    db.query(`INSERT INTO deployment_desired_state (target, desired_commit, github_delivery_id)
      VALUES ('concierge', ?, 'test-delivery')
      ON CONFLICT(target) DO UPDATE SET desired_commit=excluded.desired_commit,
        github_delivery_id=excluded.github_delivery_id, updated_at=CURRENT_TIMESTAMP`)
      .run(desiredCommit);
  }
  return await reconcileDeploymentWork({
    client,
    ownerInstanceId: "reaction-worker",
    isOwnerAlive: () => true,
    shouldStop: () => false,
    services: {
      launchRun: async () => {},
      launchRepair: async () => {},
    },
  });
}

beforeEach(async () => {
  releaseDatabaseTestLock = await acquireDatabaseTestLock();
  clearDeploymentState();
  slackBucket.reset();
  repositoryRoot = mkdtempSync(join(tmpdir(), "concierge-deployment-reactions-"));
  channelId = `C-DEPLOY-${randomUUID()}`;
  deploymentTarget = `deployment-reaction-test-${randomUUID()}`;
  priorConciergeRepository = process.env.CONCIERGE_REPO;
  process.env.CONCIERGE_REPO = repositoryRoot;
  git("init", "-b", "main");
  upsertChannel({
    slack_channel_id: channelId,
    slack_channel_name: "deploy",
    group_name: null,
    name: "Deploy",
    vault_path: repositoryRoot,
    code_path: repositoryRoot,
  });
});

afterEach(() => {
  clearDeploymentState();
  clearOwnedTurns();
  slackBucket.reset();
  releaseDatabaseTestLock?.();
  releaseDatabaseTestLock = null;
  rmSync(repositoryRoot, { recursive: true, force: true });
  if (priorConciergeRepository === undefined) delete process.env.CONCIERGE_REPO;
  else process.env.CONCIERGE_REPO = priorConciergeRepository;
});

describe("deployment task reactions", () => {
  test("projects each turn independently and never regresses an earlier deployed rocket", async () => {
    const base = commit("base.txt");
    const first = createTurn("100.000001", "100.000010");
    commit("first.txt", first.token);
    const second = createTurn("200.000001", "200.000010");
    const firstCandidate = commit("second.txt", second.token);
    seedLastKnownGood(base);

    const firstTargets = deploymentReactionTargetsForCommitRange(repositoryRoot, base, firstCandidate);
    expect(firstTargets.map((target) => target.turnId)).toEqual([first.id, second.id]);

    const calls: Array<{ method: string; timestamp: string; name: string }> = [];
    const firstReconcile = await project(reactionClient(calls), firstCandidate);
    expect(firstReconcile.automaticDeploymentPrepared).toBeTrue();
    const firstRun = db.query("SELECT * FROM deployment_runs WHERE desired_commit=?").get(firstCandidate) as any;
    expect(calls).toEqual([
      { method: "add", timestamp: first.agentMessageTs, name: "package" },
      { method: "add", timestamp: second.agentMessageTs, name: "package" },
    ]);

    advanceToRelease(firstRun.id);
    completeDeploymentRun({
      runId: firstRun.id,
      repo: repositoryRoot,
      deployedCommit: firstCandidate,
      serviceInvocationId: "live-first",
      evidence: { service: "ok" },
    });
    db.query("UPDATE deployment_releases SET git_commit=? WHERE state='lkg'").run(firstCandidate);
    await project(reactionClient(calls));
    expect(calls.slice(2).map((call) => JSON.stringify(call)).sort()).toEqual([
      { method: "add", timestamp: first.agentMessageTs, name: "rocket" },
      { method: "remove", timestamp: first.agentMessageTs, name: "package" },
      { method: "add", timestamp: second.agentMessageTs, name: "rocket" },
      { method: "remove", timestamp: second.agentMessageTs, name: "package" },
    ].map((call) => JSON.stringify(call)).sort());
    expect(getDeploymentTurnReaction(first.id)).toMatchObject({
      desired_state: "deployed",
      projected_state: "deployed",
    });
    expect(getDeploymentTurnReaction(second.id)).toMatchObject({
      desired_state: "deployed",
      projected_state: "deployed",
    });

    const third = createTurn("300.000001", "300.000010");
    const secondCandidate = commit("third.txt", third.token);
    const secondTargets = deploymentReactionTargetsForCommitRange(repositoryRoot, base, secondCandidate);
    expect(secondTargets.map((target) => target.turnId)).toEqual([first.id, second.id, third.id]);
    const beforeThirdProjection = calls.length;
    const secondReconcile = await project(reactionClient(calls), secondCandidate);
    expect(secondReconcile.automaticDeploymentPrepared).toBeTrue();
    const secondRun = db.query("SELECT * FROM deployment_runs WHERE desired_commit=?").get(secondCandidate) as any;

    expect(calls.slice(beforeThirdProjection)).toEqual([
      { method: "add", timestamp: third.agentMessageTs, name: "package" },
    ]);
    expect(getDeploymentTurnReaction(first.id)).toMatchObject({ desired_state: "deployed", run_id: firstRun.id });
    expect(getDeploymentTurnReaction(second.id)).toMatchObject({ desired_state: "deployed", run_id: firstRun.id });
    expect(getDeploymentTurnReaction(third.id)).toMatchObject({ desired_state: "deploying", run_id: secondRun.id });
  });

  test("replaces in-progress state with repair and then a parked marker without waking an agent", async () => {
    const base = commit("base.txt");
    const turn = createTurn("400.000001", "400.000010");
    const candidate = commit("candidate.txt", turn.token);
    seedLastKnownGood(base);
    const run = requestAutomaticDeployment(candidate, deploymentTarget).run!;
    registerDeploymentTurnReactionTargets(
      run.id,
      deploymentReactionTargetsForCommitRange(repositoryRoot, base, candidate),
    );

    const incident = beginDeploymentRepair({
      runId: run.id,
      failedCommit: candidate,
      restoredCommit: base,
      failureFingerprint: "candidate-health",
      error: "candidate health failed",
    });
    expect(getDeploymentTurnReaction(turn.id)?.desired_state).toBe("repairing");

    const calls: Array<{ method: string; timestamp: string; name: string }> = [];
    await project(reactionClient(calls));
    expect(calls).toEqual([
      { method: "add", timestamp: turn.agentMessageTs, name: "hammer_and_wrench" },
    ]);

    parkDeploymentRepair(incident.id, "repair exhausted");
    await project(reactionClient(calls));
    expect(calls.slice(1)).toEqual([
      { method: "add", timestamp: turn.agentMessageTs, name: "octagonal_sign" },
      { method: "remove", timestamp: turn.agentMessageTs, name: "hammer_and_wrench" },
    ]);
    expect(getDeploymentTurnReaction(turn.id)).toMatchObject({
      desired_state: "parked",
      projected_state: "parked",
      projection_status: "delivered",
    });
    expect(db.query("SELECT COUNT(*) AS count FROM turns WHERE turn_kind='deployment_verification'").get())
      .toEqual({ count: 0 });
  });

  test("waits for terminal final-response delivery before creating a reaction target", () => {
    const base = commit("base.txt");
    const turn = createTurn("500.000001", "500.000010", false);
    const candidate = commit("candidate.txt", turn.token);

    db.query(`INSERT INTO turn_delivery_chunks (turn_id, chunk_index, slack_ts, delivered_at)
      VALUES (?, 0, '500.000019', CURRENT_TIMESTAMP)`).run(turn.id);
    expect(deploymentReactionTargetsForCommitRange(repositoryRoot, base, candidate)).toEqual([]);

    db.query(`UPDATE turns SET status='done', delivery_status='delivered' WHERE id=?`).run(turn.id);
    expect(deploymentReactionTargetsForCommitRange(repositoryRoot, base, candidate)).toEqual([{
      turnId: turn.id,
      slackChannelId: channelId,
      slackMessageTs: "500.000019",
    }]);
  });
});
