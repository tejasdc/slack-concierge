import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  claimDeploymentRun,
  completeDeploymentRun,
  failDeploymentRun,
  getDeploymentRepairIncidentForRun,
  getDeploymentDesiredState,
  getDeploymentRun,
  listDeploymentRunEvents,
  listPendingDeploymentWakes,
  recordDeploymentRunPhase,
  recoverDeadDeploymentRuns,
  observeDeploymentDesiredCommit,
  requestAutomaticDeployment,
  requestOperatorDeployment,
} from "../src/deployment-state";
import { reconcileDeploymentWork } from "../src/deployment-worker";
import { db } from "../src/state";
import { acquireDatabaseTestLock } from "./db-lock";

let releaseDatabaseTestLock: (() => void) | null = null;

function clearDeploymentState() {
  db.query("DELETE FROM deployment_desired_state").run();
  db.query("DELETE FROM deployment_repair_agent_runs").run();
  db.query("DELETE FROM deployment_repair_incidents").run();
  db.query("DELETE FROM deployment_releases").run();
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
});

afterEach(() => {
  clearDeploymentState();
  releaseDatabaseTestLock?.();
  releaseDatabaseTestLock = null;
});

function seedLastKnownGood(commit: string) {
  const runId = `seed-${commit.slice(0, 12)}`;
  db.query(`INSERT INTO deployment_runs (
    id, target, unit_name, status, deployed_commit, service_invocation_id, completed_at
  ) VALUES (?, 'seed', ?, 'succeeded', ?, 'seed-invocation', CURRENT_TIMESTAMP)`)
    .run(runId, `seed-unit-${commit.slice(0, 12)}`, commit);
  db.query(`INSERT INTO deployment_releases (
    artifact_digest, run_id, git_commit, source_tree_digest, runtime_digest,
    compatibility_digest, artifact_path, state, activated_at, promoted_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 'lkg', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`)
    .run(
      "1".repeat(64),
      runId,
      commit,
      "2".repeat(64),
      "3".repeat(64),
      "4".repeat(64),
      `/tmp/release-${commit.slice(0, 12)}`,
    );
}

function seedDesired(commit: string) {
  db.query(`INSERT INTO deployment_desired_state (target, desired_commit, github_delivery_id)
    VALUES ('concierge', ?, 'test-delivery')
    ON CONFLICT(target) DO UPDATE SET desired_commit=excluded.desired_commit,
      github_delivery_id=excluded.github_delivery_id, updated_at=CURRENT_TIMESTAMP`)
    .run(commit);
}

function advanceToRelease(runId: string) {
  claimDeploymentRun({ runId, pid: 123, bootId: "boot", startTicks: "ticks" });
  recordDeploymentRunPhase(runId, "updating", { gate: "claimed" });
  recordDeploymentRunPhase(runId, "restarting", { deployed_commit: "candidate" });
  recordDeploymentRunPhase(runId, "verifying", { probe: "started" });
  recordDeploymentRunPhase(runId, "releasing", { gates: "released" });
}

describe("durable deployment coordination", () => {
  test("desired main advances monotonically across duplicate, stale, and divergent deliveries", () => {
    const commits = {
      a: "a".repeat(40),
      b: "b".repeat(40),
      c: "c".repeat(40),
      divergent: "d".repeat(40),
    };
    const ancestors = new Set([
      `${commits.a}:${commits.b}`,
      `${commits.a}:${commits.c}`,
      `${commits.b}:${commits.c}`,
    ]);
    const observe = (commit: string, delivery: string) => observeDeploymentDesiredCommit({
      desiredCommit: commit,
      githubDeliveryId: delivery,
      isAncestor: (ancestor, descendant) => ancestors.has(`${ancestor}:${descendant}`),
    });

    expect(observe(commits.b, "delivery-b").reason).toBe("recorded");
    expect(observe(commits.c, "delivery-c").reason).toBe("advanced");
    expect(observe(commits.c, "delivery-c-duplicate").reason).toBe("duplicate");
    expect(observe(commits.b, "delivery-b-late").reason).toBe("stale");
    expect(observe(commits.divergent, "delivery-d").reason).toBe("divergent");
    expect(getDeploymentDesiredState()).toMatchObject({
      desired_commit: commits.c,
      github_delivery_id: "delivery-c",
    });
  });

  test("turns origin/main movement into one automatic deployment run", () => {
    const current = "a".repeat(40);
    const desired = "b".repeat(40);

    expect(requestAutomaticDeployment(desired)).toEqual({
      run: null,
      launchRequired: false,
      reason: "uninitialized",
    });
    seedLastKnownGood(current);
    expect(requestAutomaticDeployment(current)).toEqual({
      run: null,
      launchRequired: false,
      reason: "current",
    });

    const prepared = requestAutomaticDeployment(desired);
    expect(prepared.reason).toBe("prepared");
    expect(prepared.launchRequired).toBeTrue();
    expect(prepared.run).toMatchObject({ status: "prepared", target: "concierge" });
    expect(requestAutomaticDeployment("c".repeat(40))).toMatchObject({
      run: { id: prepared.run!.id },
      launchRequired: false,
      reason: "active",
    });
    expect(JSON.parse(listDeploymentRunEvents(prepared.run!.id)[0].detail_json)).toMatchObject({
      requested_by: "github-push",
      desired_commit: desired,
      last_known_good_commit: current,
    });
  });

  test("the worker discovers and launches the desired commit without an agent request", async () => {
    seedLastKnownGood("d".repeat(40));
    seedDesired("e".repeat(40));
    const launches: string[] = [];
    const result = await reconcileDeploymentWork({
      client: {},
      ownerInstanceId: "worker-runtime",
      isOwnerAlive: () => true,
      shouldStop: () => false,
      services: {
        launchRun: async (run) => { launches.push(run.id); },
      },
    });

    expect(result.automaticDeploymentPrepared).toBeTrue();
    expect(result.launched).toBe(1);
    expect(launches).toHaveLength(1);
    expect(db.query("SELECT COUNT(*) AS count FROM deployment_requests").get()).toEqual({ count: 0 });
  });

  test("a newer desired commit survives an active run and launches after that run succeeds", async () => {
    const current = "1".repeat(40);
    const first = "2".repeat(40);
    const newer = "3".repeat(40);
    seedLastKnownGood(current);
    seedDesired(first);

    const firstRun = requestAutomaticDeployment(first).run!;
    seedDesired(newer);
    expect(requestAutomaticDeployment(newer)).toMatchObject({
      reason: "active",
      run: { id: firstRun.id },
    });
    advanceToRelease(firstRun.id);
    completeDeploymentRun({
      runId: firstRun.id,
      repo: "/tmp",
      deployedCommit: first,
      serviceInvocationId: "first-live",
      evidence: {},
      isAncestor: (_repo, ancestor, descendant) => ancestor === descendant,
    });

    const launches: string[] = [];
    await reconcileDeploymentWork({
      client: {},
      ownerInstanceId: "worker-runtime",
      isOwnerAlive: () => true,
      shouldStop: () => false,
      services: { launchRun: async (run) => { launches.push(run.desired_commit!); } },
    });
    expect(launches).toEqual([newer]);
    expect(getDeploymentDesiredState()?.desired_commit).toBe(newer);
  });

  test("a newer desired commit is considered after an older run fails", async () => {
    const current = "4".repeat(40);
    const failed = "5".repeat(40);
    const newer = "6".repeat(40);
    seedLastKnownGood(current);
    seedDesired(failed);
    const run = requestAutomaticDeployment(failed).run!;
    seedDesired(newer);
    failDeploymentRun(run.id, "candidate failed");

    const result = await reconcileDeploymentWork({
      client: {},
      ownerInstanceId: "worker-runtime",
      isOwnerAlive: () => true,
      shouldStop: () => false,
      services: { launchRun: async () => {} },
    });
    expect(result.automaticDeploymentPrepared).toBeTrue();
    expect(db.query("SELECT desired_commit FROM deployment_runs WHERE status='prepared'").get())
      .toEqual({ desired_commit: newer });
  });

  test("a detached runner launch failure enters the same autonomous repair path", async () => {
    const current = "6".repeat(40);
    const desired = "7".repeat(40);
    seedLastKnownGood(current);
    seedDesired(desired);

    const repairs: string[] = [];
    const result = await reconcileDeploymentWork({
      client: {},
      ownerInstanceId: "worker-runtime",
      isOwnerAlive: () => true,
      shouldStop: () => false,
      services: {
        launchRun: async () => { throw new Error("systemd-run unavailable"); },
        launchRepair: async (incidentId) => { repairs.push(incidentId); },
      },
    });

    const run = db.query("SELECT * FROM deployment_runs WHERE desired_commit=?").get(desired) as any;
    expect(run).toMatchObject({ status: "releasing", repair_state: "restored" });
    expect(getDeploymentRepairIncidentForRun(run.id)).toMatchObject({
      status: "restored",
      failed_commit: desired,
      restored_commit: current,
      same_failure_count: 1,
    });

    expect(result.repairsLaunched).toBe(1);
    expect(repairs).toEqual([getDeploymentRepairIncidentForRun(run.id)!.id]);
  });

  test("successful deployment records health proof and invokes no feature agent", () => {
    seedLastKnownGood("f".repeat(40));
    const prepared = requestAutomaticDeployment("0".repeat(40));
    advanceToRelease(prepared.run!.id);

    completeDeploymentRun({
      runId: prepared.run!.id,
      repo: "/repo",
      deployedCommit: "0".repeat(40),
      serviceInvocationId: "invocation-success",
      evidence: { service: "ok", runtime_sha: "0".repeat(40) },
    });

    expect(getDeploymentRun(prepared.run!.id)).toMatchObject({
      status: "succeeded",
      deployed_commit: "0".repeat(40),
      service_invocation_id: "invocation-success",
    });
    expect(listPendingDeploymentWakes()).toHaveLength(0);
    expect(db.query("SELECT COUNT(*) AS count FROM turns WHERE turn_kind='deployment_verification'").get())
      .toEqual({ count: 0 });
  });

  test("requeues a dead deployment runner without inventing another run", () => {
    seedLastKnownGood("1".repeat(40));
    const prepared = requestAutomaticDeployment("2".repeat(40));
    claimDeploymentRun({
      runId: prepared.run!.id,
      pid: 444,
      bootId: "dead-boot",
      startTicks: "dead-ticks",
    });

    expect(recoverDeadDeploymentRuns(() => false)).toBe(1);
    expect(getDeploymentRun(prepared.run!.id)).toMatchObject({
      status: "prepared",
      runner_pid: null,
      runner_boot_id: null,
      runner_start_ticks: null,
    });
    expect(requestAutomaticDeployment("2".repeat(40))).toMatchObject({
      run: { id: prepared.run!.id },
      reason: "active",
    });
  });

  test("does not redeploy a parked desired commit until origin/main advances", () => {
    seedLastKnownGood("3".repeat(40));
    const failedCommit = "4".repeat(40);
    const prepared = requestAutomaticDeployment(failedCommit);
    failDeploymentRun(prepared.run!.id, "autonomous repair parked");

    expect(requestAutomaticDeployment(failedCommit)).toMatchObject({
      run: { id: prepared.run!.id, status: "failed", desired_commit: failedCommit },
      launchRequired: false,
      reason: "blocked",
    });
    expect(requestAutomaticDeployment("5".repeat(40))).toMatchObject({
      run: { status: "prepared", desired_commit: "5".repeat(40) },
      launchRequired: true,
      reason: "prepared",
    });
  });

  test("rejects skipped deployment phases", () => {
    const run = requestOperatorDeployment().run;
    claimDeploymentRun({ runId: run.id, pid: 555, bootId: "boot", startTicks: "ticks" });
    expect(() => recordDeploymentRunPhase(run.id, "restarting")).toThrow(
      "cannot transition draining -> restarting",
    );
  });
});
