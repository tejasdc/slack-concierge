import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  beginDeploymentRepair,
  bindDeploymentRepairSession,
  claimDeploymentRun,
  completeDeploymentRun,
  getDeploymentRepairIncident,
  getDeploymentRun,
  latestDeploymentRepairAgentRun,
  listDeploymentRunEvents,
  parkDeploymentRepair,
  prepareDeploymentRepairAgentLaunch,
  recordDeploymentRunPhase,
  recordDeploymentRepairChild,
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
    DELETE FROM deployment_repair_agent_runs;
    DELETE FROM deployment_repair_incidents;
    DELETE FROM deployment_releases;
    DELETE FROM deployment_notices;
    DELETE FROM deployment_wakes;
    DELETE FROM deployment_requests;
    DELETE FROM deployment_run_events;
    DELETE FROM deployment_runs;
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
  test("migration is idempotent, preserves production-shaped rows, and restores its backup on failure", () => {
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

    const failed = migrate(join(stateDirectory, "backup-failed.db"), true);
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr.toString()).toContain('"status":"restored"');
    expect(snapshot()).toEqual(before);
  });

  test("keeps one active run through restoration and parks the third unchanged failure", () => {
    const run = activeRun();
    const failed = "a".repeat(40);
    const restored = "b".repeat(40);

    let incident = beginDeploymentRepair({
      runId: run.id,
      failedCommit: failed,
      restoredCommit: restored,
      failureFingerprint: "same-failure",
      error: "candidate health failed",
    });
    expect(incident.same_failure_count).toBe(1);
    expect(getDeploymentRun(run.id)).toMatchObject({ status: "releasing", repair_state: "restored" });

    incident = beginDeploymentRepair({
      runId: run.id,
      failedCommit: failed,
      restoredCommit: restored,
      failureFingerprint: "same-failure",
      error: "candidate health failed",
    });
    expect(incident.same_failure_count).toBe(2);
    incident = beginDeploymentRepair({
      runId: run.id,
      failedCommit: failed,
      restoredCommit: restored,
      failureFingerprint: "same-failure",
      error: "candidate health failed",
    });

    expect(incident.status).toBe("parked");
    expect(getDeploymentRun(run.id)).toMatchObject({ status: "failed", repair_state: "parked" });
    expect(listDeploymentRunEvents(run.id).map((event) => event.event)).toContain("failed");
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
    expect(() => (supervisor as any).resumableSession(unbound)).toThrow("Ambiguous unbound repair launch");
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
    for (const path of [
      "bot/src/index.ts",
      "bot/src/state.ts",
      "bot/src/capture-state.ts",
      "bot/src/deployment-state.ts",
      "bot/src/codex-app-server-bridge.mjs",
      "bot/scripts/rename-exchange.py",
    ]) {
      mkdirSync(join(source, path, ".."), { recursive: true });
      writeFileSync(join(source, path), `${path}\n`);
    }
    git(source, "init", "-q");
    git(source, "config", "user.email", "concierge@example.invalid");
    git(source, "config", "user.name", "Concierge");
    git(source, "add", ".");
    git(source, "commit", "-qm", "fixture");
    const commit = git(source, "rev-parse", "HEAD");
    const manager = new TrustedRootReleaseManager({
      repositoryRoot: source,
      releaseRoot,
      installRoot,
      bunExecutable: process.execPath,
    }, {
      spawn(command, options = {}) {
        return Bun.spawnSync({ cmd: command, cwd: options.cwd, stdin: options.stdin, stdout: "pipe", stderr: "pipe" });
      },
      async build(_entrypoint, outputDirectory) {
        writeFileSync(join(outputDirectory, "index.js"), "built application\n");
      },
    });

    const prepared = await manager.prepare("fixture-run", commit);
    expect(manager.verify(prepared.artifactPath).git_commit).toBe(commit);
    manager.activate(prepared.artifactPath);
    expect(manager.currentArtifactPath()).toBe(prepared.artifactPath);
    expect(releaseFileSetDigest(prepared.artifactPath, ["bot/src/index.js"]))
      .toMatch(/^[0-9a-f]{64}$/);
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
    process.env.CONCIERGE_DEPLOYMENT_RELEASE_ROOT = releaseRoot;
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
    }
  });
});
