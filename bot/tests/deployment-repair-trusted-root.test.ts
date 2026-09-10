import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { containControlRecovery, handleControlRecovery } from "../src/deployment-control-recovery";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  beginDeploymentRepair,
  bindDeploymentRepairSession,
  claimDeploymentRun,
  claimDeploymentRepair,
  claimControlRecovery,
  prepareControlRecovery,
  failControlRecovery,
  listPreparedDeploymentRuns,
  listDeadCandidateDeploymentRuns,
  completeDeploymentRun,
  getDeploymentRepairIncident,
  getDeploymentRun,
  latestDeploymentRepairAgentRun,
  listDeploymentRunEvents,
  listPendingDeploymentNotices,
  listRunnableDeploymentRepairs,
  recoverDeadDeploymentRuns,
  parkDeploymentRepair,
  prepareDeploymentRetry,
  prepareDeploymentRepairAgentLaunch,
  recordDeploymentRunPhase,
  recordDeploymentReleaseActivationIntent,
  recordDeploymentReleasePrepared,
  recordDeploymentRepairChild,
  recordDeploymentRepairCommit,
  recordDeploymentRepairReview,
  requestDeployment,
  requestOperatorDeployment,
} from "../src/deployment-state";
import { TrustedRootReleaseManager, releaseFileSetDigest } from "../src/deployment-release";
import { DeploymentRepairSupervisor, type DeploymentRepairServices } from "../src/deployment-repair-supervisor";
import { db } from "../src/state";
import { currentProcessIdentity } from "../src/runtime-identity";
import { acquireDatabaseTestLock } from "./db-lock";

const repositoryRoot = resolve(import.meta.dir, "../..");
const scratch: string[] = [];
let releaseDatabaseTestLock: (() => void) | null = null;

function temporary(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(directory);
  return directory;
}

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function activeRun() {
  const run = requestOperatorDeployment().run;
  claimDeploymentRun({ runId: run.id, pid: 91001, bootId: "boot", startTicks: "ticks" });
  recordDeploymentRunPhase(run.id, "updating");
  recordDeploymentRunPhase(run.id, "restarting");
  recordDeploymentRunPhase(run.id, "verifying");
  recordDeploymentRunPhase(run.id, "releasing");
  return getDeploymentRun(run.id)!;
}

function clearDeploymentRepairState() {
  db.exec(`
    DELETE FROM deployment_desired_state;
    DELETE FROM deployment_repair_agent_runs;
    DELETE FROM deployment_repair_incidents;
    DELETE FROM deployment_releases;
    DELETE FROM deployment_notices;
    DELETE FROM deployment_wakes;
    DELETE FROM deployment_requests;
    DELETE FROM deployment_run_events;
    DELETE FROM deployment_runs;
    DELETE FROM turns;
    DELETE FROM sessions;
    DELETE FROM channels;
  `);
}

beforeEach(async () => {
  releaseDatabaseTestLock = await acquireDatabaseTestLock();
  clearDeploymentRepairState();
});

afterEach(() => {
  clearDeploymentRepairState();
  releaseDatabaseTestLock?.();
  releaseDatabaseTestLock = null;
});

afterAll(() => {
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
});

describe("trusted-root deployment repair", () => {
  const incidentForTest = () => beginDeploymentRepair({ runId: activeRun().id, failedCommit: "c".repeat(40),
    restoredCommit: "d".repeat(40), failureFingerprint: "drain-lock", error: "database is locked" });

  test("NO_SHIP correction resumes with independent requested UUID and child identity", async () => {
    const incident = incidentForTest();
    const identity = currentProcessIdentity();
    claimDeploymentRepair({ incidentId: incident.id, ...identity }, () => false);
    recordDeploymentRepairCommit(incident.id, "e".repeat(40));
    recordDeploymentRepairReview(incident.id, "NO_SHIP", { blockers: ["built control still broken"] });
    const uuid = "01a039f1-9e1b-71d1-8f89-a6431c3d53b0";
    const directory = temporary("repair-resume-regression-");
    const supervisor = new DeploymentRepairSupervisor(incident.id, repositoryRoot, {
      command: () => ({ exitCode: 0, stdout: "", stderr: "" }), isAlive: () => false,
      async runAgent(input) {
        expect(input.sessionUuid).toBe(uuid);
        const intended = latestDeploymentRepairAgentRun(incident.id, "repair")!;
        expect(intended).toMatchObject({ launch_state: "launch_intended", session_uuid: null, requested_session_uuid: uuid });
        input.onSpawn(process.pid);
        input.onSpawn(process.pid);
        input.onSession(uuid);
        input.onSession(uuid);
        writeFileSync(input.finalMessagePath, "Corrected and committed.");
        return 0;
      },
    });
    (supervisor as any).incidentRoot = directory;
    await (supervisor as any).runPersistedAgent("repair", { ...getDeploymentRepairIncident(incident.id), worktree_path: directory }, "Fix", uuid);
    expect(latestDeploymentRepairAgentRun(incident.id, "repair")).toMatchObject({
      launch_state: "completed", requested_session_uuid: uuid, session_uuid: uuid, child_pid: process.pid,
    });
  });

  test("three distinct supervisor claims exhaust recovery; same-owner claims and unchanged commits cannot reset it", () => {
    const incident = incidentForTest();
    const claim = (pid: number, alive = false) => claimDeploymentRepair({ incidentId: incident.id, pid, bootId: "boot", startTicks: String(pid) }, () => alive);
    expect(claim(100).recovery_attempts).toBe(1);
    expect(claim(100).recovery_attempts).toBe(1);
    expect(() => claim(101, true)).toThrow("live supervisor");
    expect(claim(101).recovery_attempts).toBe(2);
    recordDeploymentRepairCommit(incident.id, "e".repeat(40));
    expect(claim(102).recovery_attempts).toBe(2);
    recordDeploymentRepairCommit(incident.id, "e".repeat(40));
    expect(claim(103).recovery_attempts).toBe(3);
    expect(claim(104).status).toBe("parked");
    expect(getDeploymentRun(incident.run_id)?.status).toBe("failed");
  });

  test("completed review is reused only for its exact revision and durable final path", async () => {
    const incident = incidentForTest();
    claimDeploymentRepair({ incidentId: incident.id, ...currentProcessIdentity() }, () => false);
    recordDeploymentRepairCommit(incident.id, "e".repeat(40));
    const directory = temporary("repair-review-result-");
    let starts = 0;
    const verdict = { verdict: "SHIP", summary: "verified", blockers: [], tests: ["regression"] };
    const supervisor = new DeploymentRepairSupervisor(incident.id, repositoryRoot, {
      command: () => ({ exitCode: 0, stdout: "", stderr: "" }), isAlive: () => false,
      async runAgent(input) {
        starts++;
        input.onSpawn(process.pid);
        input.onSession("01a039f1-9e1b-71d1-8f89-a6431c3d53b0");
        writeFileSync(input.finalMessagePath, JSON.stringify(verdict));
        return 0;
      },
    });
    (supervisor as any).incidentRoot = directory;
    const current = () => ({ ...getDeploymentRepairIncident(incident.id), worktree_path: directory });
    expect(await (supervisor as any).runReview(current())).toMatchObject({ verdict: "SHIP" });
    const path = latestDeploymentRepairAgentRun(incident.id, "review")!.final_message_path;
    expect(await (supervisor as any).runReview(current())).toMatchObject({ verdict: "SHIP" });
    expect(starts).toBe(1);
    recordDeploymentRepairCommit(incident.id, "f".repeat(40));
    await (supervisor as any).runReview(current());
    expect(starts).toBe(2);
    expect(latestDeploymentRepairAgentRun(incident.id, "review")!.final_message_path).not.toBe(path);
  });

  test("controller handoff stays reserved after death or failure and has no feature attribution", () => {
    const incident = incidentForTest();
    const runId = "controller-recovery-test";
    prepareControlRecovery({ runId, incidentId: incident.id, healthyCommit: "d".repeat(40), controlCommit: "e".repeat(40),
      artifactPath: "/tmp/fixture-release", artifactDigest: "digest", sourceTreeDigest: "tree", reviewDigest: "review" });
    const first = { pid: 100, bootId: "boot", startTicks: "100" };
    expect(() => claimControlRecovery(runId, first, () => true)).toThrow("previous repair owner");
    expect(getDeploymentRepairIncident(incident.id)?.status).not.toBe("parked");
    expect(getDeploymentRun(runId)).toBeNull();
    expect(claimControlRecovery(runId, first, () => false)).toMatchObject({ status: "draining", repair_state: "repairing" });
    expect(getDeploymentRepairIncident(incident.id)?.status).toBe("parked");
    expect(() => claimControlRecovery(runId, { ...first, pid: 101 }, () => true)).toThrow("live owner");
    db.query("UPDATE deployment_runs SET activation_state='active' WHERE id=?").run(runId);
    recoverDeadDeploymentRuns(() => false);
    expect(listPreparedDeploymentRuns()).toEqual([]);
    expect(listRunnableDeploymentRepairs(() => false)).toEqual([]);
    expect(listDeadCandidateDeploymentRuns(() => false)).toEqual([]);
    failControlRecovery(runId, "controlled failure");
    expect(getDeploymentRun(runId)).toMatchObject({ status: "releasing", repair_state: "repairing", runner_pid: null });
    expect(claimControlRecovery(runId, { ...first, pid: 102 }, () => false)).toMatchObject({ status: "draining", activation_state: "active" });
    expect(db.query("SELECT COUNT(*) AS count FROM deployment_requests WHERE run_id=?").get(runId)).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM deployment_turn_reactions WHERE run_id=?").get(runId)).toEqual({ count: 0 });
  });

  test("migration is idempotent, preserves production-shaped rows, and rolls back without replacing a live database", () => {
    const stateDirectory = temporary("deployment-migration-");
    const environment = {
      ...process.env,
      CONCIERGE_STATE_DIR: stateDirectory,
      CONCIERGE_TEST_MODE: "1",
    };
    const initialized = Bun.spawnSync({
      cmd: [process.execPath, "--eval", 'await import("./src/deployment-state.ts")'],
      cwd: resolve(repositoryRoot, "bot"),
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(initialized.exitCode, initialized.stderr.toString()).toBe(0);
    const fixture = new Database(join(stateDirectory, "state.db"));
    fixture.exec("PRAGMA foreign_keys=ON");
    for (let index = 1; index <= 16; index += 1) {
      fixture.query(`INSERT INTO sessions (
        id, slack_channel_id, slack_thread_ts, provider_id, agent_session_uuid, status
      ) VALUES (?, ?, ?, 'codex', ?, 'idle')`).run(index, `C${index}`, `${index}.1`, `session-${index}`);
      fixture.query(`INSERT INTO turns (
        id, session_id, slack_user_msg_ts, user_text, status
      ) VALUES (?, ?, ?, 'deploy', 'delivered')`).run(index, index, `${index}.2`);
    }
    for (let index = 1; index <= 12; index += 1) {
      fixture.query(`INSERT INTO deployment_runs (
        id, target, unit_name, status, deployed_commit, service_invocation_id, completed_at
      ) VALUES (?, ?, ?, 'succeeded', ?, ?, CURRENT_TIMESTAMP)`)
        .run(`run-${index}`, `target-${index}`, `unit-${index}`, index.toString(16).padStart(40, "0"), `invocation-${index}`);
    }
    for (let index = 1; index <= 70; index += 1) {
      fixture.query(`INSERT INTO deployment_run_events (run_id, event, detail_json)
        VALUES (?, 'fixture', ?)`).run(`run-${(index % 12) + 1}`, JSON.stringify({ index }));
    }
    for (let index = 1; index <= 16; index += 1) {
      fixture.query(`INSERT INTO deployment_requests (
        id, run_id, source_turn_id, source_session_id, expected_commit,
        slack_channel_id, slack_thread_ts, provider_id, provider_session_uuid, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'codex', ?, 'included')`).run(
        `request-${index}`,
        `run-${(index % 12) + 1}`,
        index,
        index,
        index.toString(16).padStart(40, "0"),
        `C${index}`,
        `${index}.1`,
        `session-${index}`,
      );
    }
    for (let index = 1; index <= 3; index += 1) {
      fixture.query(`INSERT INTO deployment_wakes (
        id, run_id, session_id, slack_channel_id, slack_thread_ts,
        provider_id, provider_session_uuid, prompt, status
      ) VALUES (?, ?, ?, ?, ?, 'codex', ?, 'verify', 'delivered')`)
        .run(`wake-${index}`, `run-${index}`, index, `C${index}`, `${index}.1`, `session-${index}`);
    }
    for (let index = 1; index <= 12; index += 1) {
      fixture.query(`INSERT INTO deployment_notices (
        id, run_id, session_id, slack_channel_id, slack_thread_ts,
        kind, text, client_msg_id, status
      ) VALUES (?, ?, ?, ?, ?, 'deploy_failed', 'fixture', ?, 'delivered')`)
        .run(`notice-${index}`, `run-${index}`, index, `C${index}`, `${index}.1`, `client-${index}`);
    }
    fixture.close();

    const snapshot = () => {
      const database = new Database(join(stateDirectory, "state.db"), { readonly: true });
      const result = Object.fromEntries([
        "deployment_runs",
        "deployment_run_events",
        "deployment_requests",
        "deployment_wakes",
        "deployment_notices",
      ].map((table) => [table, database.query(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
      const integrity = database.query("PRAGMA integrity_check").all();
      const foreignKeys = database.query("PRAGMA foreign_key_check").all();
      database.close();
      return { result, integrity, foreignKeys };
    };
    const before = snapshot();
    expect(Object.fromEntries(Object.entries(before.result).map(([table, rows]) => [table, rows.length])))
      .toEqual({
        deployment_runs: 12,
        deployment_run_events: 70,
        deployment_requests: 16,
        deployment_wakes: 3,
        deployment_notices: 12,
      });

    const migrate = (backup: string, forceFailure = false) => Bun.spawnSync({
      cmd: [process.execPath, "run", resolve(repositoryRoot, "bot/scripts/migrate-deployment-repair.ts"),
        ...(forceFailure ? ["--force-failure"] : [])],
      cwd: repositoryRoot,
      env: { ...environment, CONCIERGE_DEPLOYMENT_MIGRATION_BACKUP: backup },
      stdout: "pipe",
      stderr: "pipe",
    });
    const first = migrate(join(stateDirectory, "backup-first.db"));
    expect(first.exitCode, first.stderr.toString()).toBe(0);
    const second = migrate(join(stateDirectory, "backup-second.db"));
    expect(second.exitCode, second.stderr.toString()).toBe(0);
    expect(snapshot()).toEqual(before);

    const observer = new Database(join(stateDirectory, "state.db"), { readonly: true });
    const inodeBeforeFailure = statSync(join(stateDirectory, "state.db")).ino;
    const failed = migrate(join(stateDirectory, "backup-failed.db"), true);
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr.toString()).toContain('"status":"rolled_back"');
    expect(statSync(join(stateDirectory, "state.db")).ino).toBe(inodeBeforeFailure);
    expect((observer.query("SELECT COUNT(*) AS count FROM deployment_runs").get() as any).count).toBe(12);
    observer.close();
    expect(snapshot()).toEqual(before);
  });

  test("keeps one active run through restoration and parks the third unchanged failure", () => {
    const run = activeRun();
    const restored = "b".repeat(40);

    let incident = beginDeploymentRepair({
      runId: run.id,
      failedCommit: "a".repeat(40),
      restoredCommit: restored,
      failureFingerprint: "same-failure",
      error: "candidate health failed",
    });
    expect(incident.same_failure_count).toBe(1);
    expect(getDeploymentRun(run.id)).toMatchObject({ status: "releasing", repair_state: "restored" });

    incident = beginDeploymentRepair({
      runId: run.id,
      failedCommit: "c".repeat(40),
      restoredCommit: restored,
      failureFingerprint: "same-failure",
      error: "candidate health failed",
    });
    expect(incident.same_failure_count).toBe(2);
    incident = beginDeploymentRepair({
      runId: run.id,
      failedCommit: "d".repeat(40),
      restoredCommit: restored,
      failureFingerprint: "same-failure",
      error: "candidate health failed",
    });

    expect(incident.status).toBe("parked");
    expect(getDeploymentRun(run.id)).toMatchObject({ status: "failed", repair_state: "parked" });
    expect(listDeploymentRunEvents(run.id).map((event) => event.event)).toContain("failed");
  });

  test("a different failure fingerprint at the same deployment stage resets recurrence", () => {
    const run = activeRun();
    const input = {
      runId: run.id,
      failedCommit: "1".repeat(40),
      restoredCommit: "2".repeat(40),
      error: "candidate health failed",
    };
    expect(beginDeploymentRepair({ ...input, failureFingerprint: "restart-exit" }).same_failure_count).toBe(1);
    expect(beginDeploymentRepair({ ...input, failureFingerprint: "restart-exit" }).same_failure_count).toBe(2);
    const changed = beginDeploymentRepair({
      ...input,
      failureFingerprint: "runtime-proof-mismatch",
      error: "runtime SHA differed",
    });
    expect(changed.same_failure_count).toBe(1);
    expect(changed.status).toBe("restored");
  });

  test("queues an interrupted activated run for the same-run recovery handoff", () => {
    const run = requestOperatorDeployment().run;
    claimDeploymentRun({ runId: run.id, pid: 999999, bootId: "dead-boot", startTicks: "dead-ticks" });
    recordDeploymentRunPhase(run.id, "updating");
    const artifactDigest = "3".repeat(64);
    const candidateCommit = "4".repeat(40);
    recordDeploymentReleasePrepared(run.id, "/tmp/fixture-release", {
      artifact_digest: artifactDigest,
      git_commit: candidateCommit,
      source_tree_digest: "5".repeat(64),
      runtime_digest: "6".repeat(64),
      compatibility_digest: "7".repeat(64),
    });
    recordDeploymentReleaseActivationIntent(run.id, artifactDigest);

    expect(recoverDeadDeploymentRuns(() => false)).toBe(1);
    expect(getDeploymentRun(run.id)).toMatchObject({
      status: "prepared",
      candidate_commit: candidateCommit,
      candidate_artifact_digest: artifactDigest,
      activation_state: "intended",
    });
    expect(listDeploymentRunEvents(run.id).map((event) => event.event)).toContain("runner_recovery_queued");
  });

  test("requeues a dead pre-activation repair retry on the same run", () => {
    const run = activeRun();
    const incident = beginDeploymentRepair({
      runId: run.id,
      failedCommit: "1".repeat(40),
      restoredCommit: "2".repeat(40),
      failureFingerprint: "retry-owner-died",
      error: "fixture failure",
    });
    recordDeploymentRepairCommit(incident.id, "3".repeat(40));
    recordDeploymentRepairReview(incident.id, "SHIP", { verdict: "SHIP", blockers: [] });
    prepareDeploymentRetry(incident.id);
    claimDeploymentRun({ runId: run.id, pid: 999999, bootId: "dead-boot", startTicks: "dead-ticks" });
    recordDeploymentRunPhase(run.id, "updating");

    expect(recoverDeadDeploymentRuns(() => false)).toBe(1);
    expect(getDeploymentRun(run.id)).toMatchObject({
      status: "prepared",
      repair_state: "retrying",
      runner_pid: null,
      activation_state: null,
    });
    expect(listRunnableDeploymentRepairs().map((repair) => repair.id)).toContain(incident.id);
    expect(listDeploymentRunEvents(run.id).map((event) => event.event)).toContain("repair_retry_requeued");
  });

  test("parks an unsafe retry state without exposing exit output in Slack", () => {
    db.query(`INSERT INTO channels (
      slack_channel_id, slack_channel_name, name, vault_path, code_path
    ) VALUES ('C_RETRY', 'retry', 'Retry', '/tmp', '/tmp')`).run();
    const session = db.query(`INSERT INTO sessions (
      slack_channel_id, slack_thread_ts, provider_id, agent_session_uuid, status
    ) VALUES ('C_RETRY', '305.000001', 'codex', 'provider-retry', 'running') RETURNING id`).get() as { id: number };
    const source = db.query(`INSERT INTO turns (
      session_id, slack_user_msg_ts, slack_reply_thread_ts, user_text, status,
      owner_instance_id, requested_by_user_id
    ) VALUES (?, '305.000002', '305.000001', 'deploy', 'running', 'owner-retry', 'U_RETRY')
      RETURNING id`).get(session.id) as { id: number };
    const requested = requestDeployment({
      sourceTurnId: source.id,
      ownerInstanceId: "owner-retry",
      expectedCommit: "8".repeat(40),
    });
    claimDeploymentRun({ runId: requested.run.id, pid: 93001, bootId: "initial", startTicks: "ticks" });
    recordDeploymentRunPhase(requested.run.id, "updating");
    recordDeploymentRunPhase(requested.run.id, "restarting");
    recordDeploymentRunPhase(requested.run.id, "verifying");
    recordDeploymentRunPhase(requested.run.id, "releasing");
    const incident = beginDeploymentRepair({
      runId: requested.run.id,
      failedCommit: "8".repeat(40),
      restoredCommit: "9".repeat(40),
      failureFingerprint: "unsafe-retry-state",
      error: "fixture health failed",
    });
    recordDeploymentRepairCommit(incident.id, "a".repeat(40));
    recordDeploymentRepairReview(incident.id, "SHIP", { verdict: "SHIP", blockers: [] });
    const retry = prepareDeploymentRetry(incident.id);
    const services: DeploymentRepairServices = {
      command() {
        claimDeploymentRun({ runId: requested.run.id, pid: 93002, bootId: "retry", startTicks: "ticks" });
        recordDeploymentRunPhase(requested.run.id, "updating");
        return { exitCode: 3, stdout: "", stderr: "systemd-run exited 3: unit failed" };
      },
      async runAgent() { throw new Error("no agent expected"); },
      isAlive: () => true,
    };
    const supervisor = new DeploymentRepairSupervisor(incident.id, repositoryRoot, services);

    const parked = (supervisor as any).retryDeployment(incident, retry);

    expect(parked).toMatchObject({ status: "parked" });
    const notice = listPendingDeploymentNotices()[0];
    expect(notice.text).toBe(
      `Deployment failed. The deployment retry ended before it reached a safe terminal state. No verification turn was started. Reference: \`${requested.run.id.slice(0, 12)}\`.`,
    );
    expect(notice.text).not.toContain("systemd-run exited 3");
    expect(JSON.parse(listDeploymentRunEvents(requested.run.id).at(-1)!.detail_json)).toEqual({
      error: "Autonomous deployment repair parked: Deployment retry exited 3 in updating/retrying: systemd-run exited 3: unit failed",
      prior_status: "updating",
      diagnostics: {
        stage: "repair-retry",
        exit_status: 3,
        command_output: "systemd-run exited 3: unit failed",
        run_status: "updating",
        repair_state: "retrying",
      },
    });
  });

  test("resumes a bound dead child but parks an unbound launch without starting another session", async () => {
    const run = activeRun();
    const incident = beginDeploymentRepair({
      runId: run.id,
      failedCommit: "c".repeat(40),
      restoredCommit: "d".repeat(40),
      failureFingerprint: "failure",
      error: "broken",
    });
    const identity = currentProcessIdentity();
    const outputPath = join(temporary("repair-agent-state-"), "agent.jsonl");
    const unbound = prepareDeploymentRepairAgentLaunch({
      incidentId: incident.id,
      kind: "repair",
      supervisorPid: identity.pid,
      supervisorBootId: identity.bootId,
      supervisorStartTicks: identity.startTicks,
      outputPath,
    });
    recordDeploymentRepairChild(unbound.id, { pid: 999999, bootId: identity.bootId, startTicks: "dead" });

    const supervisor = new DeploymentRepairSupervisor(incident.id, repositoryRoot, {
      command: () => ({ exitCode: 0, stdout: "", stderr: "" }),
      runAgent: async () => { throw new Error("a second session must not start"); },
      isAlive: () => false,
    });
    expect(() => (supervisor as any).resumableSession(latestDeploymentRepairAgentRun(incident.id, "repair")))
      .toThrow("Ambiguous unbound repair launch");
    expect(getDeploymentRepairIncident(incident.id)?.status).toBe("parked");

    const secondRun = activeRun();
    const secondIncident = beginDeploymentRepair({
      runId: secondRun.id,
      failedCommit: "e".repeat(40),
      restoredCommit: "f".repeat(40),
      failureFingerprint: "other",
      error: "broken again",
    });
    const bound = prepareDeploymentRepairAgentLaunch({
      incidentId: secondIncident.id,
      kind: "repair",
      supervisorPid: identity.pid,
      supervisorBootId: identity.bootId,
      supervisorStartTicks: identity.startTicks,
      outputPath,
    });
    recordDeploymentRepairChild(bound.id, { pid: 999998, bootId: identity.bootId, startTicks: "dead" });
    const sessionUuid = "01a039f1-9e1b-71d1-8f89-a6431c3d53b0";
    bindDeploymentRepairSession(bound.id, sessionUuid);
    const boundSupervisor = new DeploymentRepairSupervisor(secondIncident.id, repositoryRoot, {
      command: () => ({ exitCode: 0, stdout: "", stderr: "" }),
      runAgent: async () => 0,
      isAlive: () => false,
    });
    expect((boundSupervisor as any).resumableSession(latestDeploymentRepairAgentRun(secondIncident.id, "repair")))
      .toBe(sessionUuid);
  });

  test("builds, verifies, and atomically switches a root-owned immutable release", async () => {
    const source = temporary("release-source-");
    const releaseRoot = temporary("release-root-");
    const installRoot = temporary("release-install-");
    const applicationPaths = [
      "bot/src/index.ts",
      "bot/src/state.ts",
      "bot/src/capture-state.ts",
      "bot/src/deployment-state.ts",
      "bot/src/codex-app-server-bridge.mjs",
      "bot/scripts/rename-exchange.py",
    ];
    const controlPaths = [
      "bot/scripts/deploy-state.ts",
      "bot/scripts/release-manager.ts",
      "bot/scripts/migrate-deployment-repair.ts",
      "bot/scripts/deployment-repair.ts",
      "bot/scripts/recover-deployment.ts",
      "bot/scripts/drain-status.ts",
      "bot/scripts/capture-drain-status.ts",
      "bot/scripts/healthcheck.ts",
      "bot/scripts/capture-healthcheck.ts",
      "bot/scripts/install-capture-ingress.ts",
      "bot/scripts/deploy.sh",
      "bot/scripts/deployment-launcher.sh",
      "bot/scripts/deployment-control-launcher.sh",
      "bot/scripts/install-transcriber.sh",
      "bot/scripts/deployment-repair-review.schema.json",
      "systemd/concierge-bot.service",
      "systemd/agent-inbox.service",
      "systemd/concierge-deployment-repair@.service",
      "systemd/concierge-capture.conf",
      "systemd/router-actions.sh",
      "config/capture-routes.toml",
    ];
    for (const path of applicationPaths) {
      mkdirSync(join(source, path, ".."), { recursive: true });
      writeFileSync(join(source, path), `application ${path}\n`);
    }
    mkdirSync(join(source, "bot/node_modules"), { recursive: true });
    git(source, "init", "-q");
    git(source, "config", "user.email", "concierge@example.invalid");
    git(source, "config", "user.name", "Concierge");
    git(source, "add", ".");
    git(source, "commit", "-qm", "healthy application");
    const applicationCommit = git(source, "rev-parse", "HEAD");
    for (const path of controlPaths) {
      mkdirSync(join(source, path, ".."), { recursive: true });
      writeFileSync(join(source, path), `control ${path}\n`);
    }
    writeFileSync(join(source, "bot/src/index.ts"), "unproven candidate application\n");
    git(source, "add", ".");
    git(source, "commit", "-qm", "reviewed control");
    const controlCommit = git(source, "rev-parse", "HEAD");
    const manager = new TrustedRootReleaseManager({
      repositoryRoot: source,
      releaseRoot,
      installRoot,
      bunExecutable: process.execPath,
    }, {
      spawn(command, options = {}) {
        return Bun.spawnSync({ cmd: command, cwd: options.cwd, stdin: options.stdin, stdout: "pipe", stderr: "pipe" });
      },
      async build(entrypoint, outputFile) {
        mkdirSync(dirname(outputFile), { recursive: true });
        writeFileSync(outputFile, `built ${readFileSync(entrypoint, "utf8")}`);
      },
    });

    const prepared = await manager.prepare("fixture-run", applicationCommit, controlCommit);
    const manifest = manager.verify(prepared.artifactPath);
    expect(manifest.git_commit).toBe(applicationCommit);
    expect(manifest.control_git_commit).toBe(controlCommit);
    expect(manifest.source_tree_digest).not.toBe(manifest.control_source_tree_digest);
    expect(readFileSync(join(prepared.artifactPath, "bot/src/index.js"), "utf8"))
      .toContain("application bot/src/index.ts");
    expect(readFileSync(join(prepared.artifactPath, "control/deployment-repair.js"), "utf8"))
      .toContain("control bot/scripts/deployment-repair.ts");
    expect(readFileSync(join(prepared.artifactPath, "control/codex-app-server-bridge.mjs"), "utf8"))
      .toContain("application bot/src/codex-app-server-bridge.mjs");
    manager.activate(prepared.artifactPath);
    expect(manager.currentArtifactPath()).toBe(prepared.artifactPath);
    manager.activateControl(prepared.artifactPath);
    expect(manager.controlArtifactPath()).toBe(prepared.artifactPath);
    expect(readFileSync(join(prepared.artifactPath, "control/deployment-repair.js"), "utf8"))
      .toContain("built");
    expect(releaseFileSetDigest(prepared.artifactPath, ["bot/src/index.js"]))
      .toMatch(/^[0-9a-f]{64}$/);

    const candidate = await manager.prepare("candidate-run", controlCommit);
    manager.activate(candidate.artifactPath);
    manager.activateControl(candidate.artifactPath);
    expect(manager.controlArtifactPath()).toBe(candidate.artifactPath);
    manager.restore(prepared.artifactPath);
    expect(manager.currentArtifactPath()).toBe(prepared.artifactPath);
    expect(manager.controlArtifactPath()).toBe(prepared.artifactPath);

    const incident = incidentForTest();
    recordDeploymentReleasePrepared(incident.run_id, prepared.artifactPath, manifest);
    db.query("UPDATE deployment_releases SET state='lkg' WHERE artifact_digest=?").run(manifest.artifact_digest);
    const runId = "mask-recovery";
    prepareControlRecovery({ runId, incidentId: incident.id, controlCommit, healthyCommit: applicationCommit,
      artifactPath: prepared.artifactPath, artifactDigest: manifest.artifact_digest, sourceTreeDigest: "tree", reviewDigest: "review" });
    const installed = temporary("repair-unit-install-");
    const unitPath = join(installed, "concierge-deployment-repair@.service");
    const sourceUnit = join(prepared.artifactPath, "control/systemd/concierge-deployment-repair@.service");
    copyFileSync(sourceUnit, unitPath);
    const commands: string[][] = [];
    const stopped = (command: string[]) => {
      commands.push(command);
      return command[1] === "show" ? "MainPID=0\nActiveState=inactive\nControlGroup=" : "";
    };
    containControlRecovery(runId, manager, installed, stopped);
    expect(readlinkSync(unitPath)).toBe("/dev/null");
    containControlRecovery(runId, manager, installed, stopped);
    const options = (name: string) => name === "--run-id" ? runId : null;
    await expect(handleControlRecovery("recovery-unmask", options, manager, stopped)).rejects.toThrow("promoted repair unit");
    expect(Bun.spawnSync(["install", "-m", "0644", sourceUnit, unitPath]).exitCode).toBe(0);
    expect(lstatSync(unitPath).isFile()).toBe(true);
    expect(await handleControlRecovery("recovery-unmask", options, manager, stopped)).toMatchObject({ status: "ready", owned_mask: true });
    const external = temporary("repair-external-mask-");
    symlinkSync("/dev/null", join(external, "concierge-deployment-repair@.service"));
    prepareControlRecovery({ runId: "external-mask", incidentId: incident.id, controlCommit, healthyCommit: applicationCommit,
      artifactPath: prepared.artifactPath, artifactDigest: manifest.artifact_digest, sourceTreeDigest: "tree", reviewDigest: "review" });
    containControlRecovery("external-mask", manager, external, stopped);
    expect(await handleControlRecovery("recovery-unmask", name => name === "--run-id" ? "external-mask" : null, manager, stopped))
      .toMatchObject({ owned_mask: false });
    expect(readlinkSync(join(external, "concierge-deployment-repair@.service"))).toBe("/dev/null");

    const origin = temporary("control-recovery-origin-");
    git(origin, "init", "--bare", "-q");
    git(source, "branch", "-M", "main");
    git(source, "remote", "add", "origin", origin);
    git(source, "push", "-u", "origin", "main");
    const reviewPath = join(temporary("control-review-"), "review.json");
    const launchCommands: string[][] = [];
    const command = (args: string[], cwd?: string) => {
      if (args[0] === "git") return git(cwd!, ...args.slice(1));
      if (args[0] === "systemd-run") { launchCommands.push(args); return "accepted"; }
      return stopped(args);
    };
    const inputs: Record<string, string> = { "--source-root": source, "--control-commit": controlCommit,
      "--incident-id": incident.id, "--review-evidence": reviewPath };
    const option = (name: string) => inputs[name] || null;
    writeFileSync(reviewPath, JSON.stringify({ verdict: "NO_SHIP", reviewed_commit: controlCommit }));
    await expect(handleControlRecovery("recovery-start", option, manager, command)).rejects.toThrow("SHIP evidence");
    writeFileSync(reviewPath, JSON.stringify({ verdict: "SHIP", reviewed_commit: controlCommit }));
    writeFileSync(join(source, "unreviewed.txt"), "dirty");
    await expect(handleControlRecovery("recovery-start", option, manager, command)).rejects.toThrow("clean source checkout");
    rmSync(join(source, "unreviewed.txt"));
    inputs["--control-commit"] = applicationCommit;
    await expect(handleControlRecovery("recovery-start", option, manager, command)).rejects.toThrow("exact integrated reviewed revision");
    inputs["--control-commit"] = controlCommit;
    expect(launchCommands).toEqual([]);
    const accepted = await handleControlRecovery("recovery-start", option, manager, command);
    expect(accepted.status).toBe("handoff_accepted");
    expect(launchCommands).toHaveLength(1);
    expect(launchCommands[0].at(-1)).toBe(join(prepared.artifactPath, "control/deploy.sh"));
    inputs["--run-id"] = String(accepted.run_id);
    inputs["--owner-pid"] = String(process.pid);
    const oldSystemd = process.env.CONCIERGE_SYSTEMD_DIR;
    try {
      process.env.CONCIERGE_SYSTEMD_DIR = installed;
      const claimed = await handleControlRecovery("recovery-claim", option, manager, command);
      expect(claimed.run).toMatchObject({ id: accepted.run_id, status: "draining", repair_state: "repairing" });
      inputs["--error"] = "controlled failure before activation";
      expect(await handleControlRecovery("recovery-failed", option, manager, command)).toMatchObject({ status: "reserved" });
      expect(getDeploymentRun(String(accepted.run_id))).toMatchObject({ status: "releasing", repair_state: "repairing" });
    } finally {
      if (oldSystemd === undefined) delete process.env.CONCIERGE_SYSTEMD_DIR;
      else process.env.CONCIERGE_SYSTEMD_DIR = oldSystemd;
    }
  });

  test("repairs, freshly reviews, non-force integrates, retries, and completes the same run", async () => {
    const remote = temporary("repair-origin-");
    git(remote, "init", "--bare", "-q");
    const canonical = temporary("repair-canonical-");
    git(canonical, "init", "-q");
    git(canonical, "config", "user.email", "concierge@example.invalid");
    git(canonical, "config", "user.name", "Concierge");
    writeFileSync(join(canonical, "broken.txt"), "broken\n");
    git(canonical, "add", ".");
    git(canonical, "commit", "-qm", "broken candidate");
    git(canonical, "branch", "-M", "main");
    git(canonical, "remote", "add", "origin", remote);
    git(canonical, "push", "-u", "origin", "main");
    const failedCommit = git(canonical, "rev-parse", "HEAD");
    const run = activeRun();
    const incident = beginDeploymentRepair({
      runId: run.id,
      failedCommit,
      restoredCommit: "9".repeat(40),
      failureFingerprint: "health-failure",
      error: "fixture health failed",
    });
    const releaseRoot = temporary("repair-runtime-");
    const priorReleaseRoot = process.env.CONCIERGE_DEPLOYMENT_RELEASE_ROOT;
    const priorDeployCommand = process.env.CONCIERGE_DEPLOY_COMMAND;
    process.env.CONCIERGE_DEPLOYMENT_RELEASE_ROOT = releaseRoot;
    process.env.CONCIERGE_DEPLOY_COMMAND = join(releaseRoot, "missing-control");
    const sessionUuid = "01a039f1-9e1b-71d1-8f89-a6431c3d53b0";
    let retryInvocations = 0;
    let agentInvocations = 0;
    const services: DeploymentRepairServices = {
      command(command, options = {}) {
        if (command[0].endsWith("bot/scripts/deploy.sh")) {
          retryInvocations += 1;
          if (retryInvocations === 1) throw new Error("fixture supervisor crash after reviewed push");
          const retryRun = getDeploymentRun(run.id)!;
          claimDeploymentRun({ runId: retryRun.id, pid: 92001, bootId: "retry", startTicks: "ticks" });
          recordDeploymentRunPhase(retryRun.id, "updating");
          recordDeploymentRunPhase(retryRun.id, "restarting");
          recordDeploymentRunPhase(retryRun.id, "verifying");
          recordDeploymentRunPhase(retryRun.id, "releasing");
          const deployedCommit = git(canonical, "rev-parse", "origin/main");
          completeDeploymentRun({
            runId: retryRun.id,
            repo: canonical,
            deployedCommit,
            serviceInvocationId: "fixture-invocation",
            evidence: { health: "ok" },
          });
          return { exitCode: 0, stdout: "deployed", stderr: "" };
        }
        const result = Bun.spawnSync({
          cmd: command,
          cwd: options.cwd,
          env: { ...process.env, ...options.env },
          stdout: "pipe",
          stderr: "pipe",
        });
        return {
          exitCode: result.exitCode,
          stdout: result.stdout.toString(),
          stderr: result.stderr.toString(),
        };
      },
      async runAgent(input) {
        agentInvocations += 1;
        input.onSpawn(process.pid);
        input.onSession(sessionUuid);
        if (input.kind === "repair") {
          writeFileSync(join(input.cwd, "broken.txt"), "fixed\n");
          git(input.cwd, "add", "broken.txt");
          git(input.cwd, "commit", "-qm", "fix deployment");
          writeFileSync(input.finalMessagePath, "repair committed\n");
        } else {
          writeFileSync(input.finalMessagePath, JSON.stringify({
            verdict: "SHIP",
            summary: "fixture repair is sufficient",
            blockers: [],
          }));
        }
        return 0;
      },
      isAlive: () => false,
    };

    try {
      await expect(new DeploymentRepairSupervisor(incident.id, canonical, services).run())
        .rejects.toThrow("fixture supervisor crash after reviewed push");
      expect(getDeploymentRun(run.id)).toMatchObject({ status: "prepared", repair_state: "retrying" });
      const completed = await new DeploymentRepairSupervisor(incident.id, canonical, services).run();
      expect(completed.status).toBe("completed");
      expect(getDeploymentRun(run.id)?.status).toBe("succeeded");
      expect(agentInvocations).toBe(2);
      expect(retryInvocations).toBe(2);
      expect(readFileSync(join(canonical, "broken.txt"), "utf8")).toBe("broken\n");
      expect(git(canonical, "rev-parse", "origin/main")).not.toBe(failedCommit);
    } finally {
      if (priorReleaseRoot == null) delete process.env.CONCIERGE_DEPLOYMENT_RELEASE_ROOT;
      else process.env.CONCIERGE_DEPLOYMENT_RELEASE_ROOT = priorReleaseRoot;
      if (priorDeployCommand == null) delete process.env.CONCIERGE_DEPLOY_COMMAND;
      else process.env.CONCIERGE_DEPLOY_COMMAND = priorDeployCommand;
    }
  });
});
