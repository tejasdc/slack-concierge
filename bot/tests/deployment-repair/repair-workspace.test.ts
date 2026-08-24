import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  RepairWorkspaceManager,
  repairTreeDigest,
} from "../../../deployment-control/kernel/repair-workspace";

function run(command: string[], cwd?: string) {
  const result = Bun.spawnSync({ cmd: command, cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

describe("credential-free repair workspace", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test("materializes an exact standalone repository with immutable incident controls", () => {
    const root = mkdtempSync(join(tmpdir(), "concierge-repair-workspace-"));
    roots.push(root);
    const source = join(root, "source");
    run(["git", "init", "--initial-branch=main", source]);
    run(["git", "config", "user.name", "Fixture"], source);
    run(["git", "config", "user.email", "fixture@example.invalid"], source);
    writeFileSync(join(source, "README.md"), "base\n");
    run(["git", "add", "README.md"], source);
    run(["git", "commit", "-m", "base"], source);
    const baseCommit = run(["git", "rev-parse", "HEAD"], source);
    const incidentId = "123e4567-e89b-42d3-a456-426614174000";
    let now = 1_800_000_000_000;
    const manager = new RepairWorkspaceManager({
      repositoryRoot: source,
      workerRoot: join(root, "workers"),
      controlRoot: join(root, "control"),
      runtimeRoot: "/usr/local/lib/concierge-deployment",
      providerAdapterSocket: join(root, "provider.sock"),
      providerAdapterPort: 41951,
      repairUser: "fixture",
      repairGroup: "fixture",
      systemctlBin: "/usr/bin/systemctl",
    }, {
      spawn(command, options = {}) {
        return Bun.spawnSync({
          cmd: command,
          cwd: options.cwd,
          stdin: options.stdin,
          stdout: "pipe",
          stderr: "pipe",
          env: options.env || process.env,
        });
      },
      resolveIdentity: () => ({ uid: process.getuid!(), gid: process.getgid!() }),
      now: () => now,
    });

    const prepared = manager.prepare({
      incidentId,
      baseCommit,
      evidence: { failure: "probe failed", secret: "redacted" },
      charter: "Repair the deployment system and return structured evidence.",
      model: "gpt-5.6-terra",
      reasoningEffort: "high",
    });

    expect(prepared.baseCommit).toBe(baseCommit);
    expect(prepared.capability).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(prepared.capabilityExpiresAtMs).toBe(1_800_086_400_000);
    expect(run(["git", "remote"], prepared.repositoryPath)).toBe("");
    expect(run(["git", "config", "--get", "core.hooksPath"], prepared.repositoryPath)).toBe("/dev/null");
    expect(run(["git", "status", "--porcelain"], prepared.repositoryPath)).toBe("");
    expect(repairTreeDigest(prepared.repositoryPath)).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(prepared.controlPath, "prompt.md"), "utf8")).toContain("probe failed");
    expect(statSync(join(root, "control", incidentId)).mode & 0o777).toBe(0o700);
    expect(statSync(join(prepared.controlPath, "provider.cap")).mode & 0o777).toBe(0o440);

    const fsMonitor = join(prepared.repositoryPath, "fsmonitor.sh");
    writeFileSync(fsMonitor, `#!/bin/sh\ntouch ${join(root, "escaped-from-git-config")}\n`);
    chmodSync(fsMonitor, 0o700);
    run(["git", "config", "core.fsmonitor", fsMonitor], prepared.repositoryPath);
    const isolatedStatus = manager.runIsolatedGit(incidentId, ["status", "--porcelain", "--untracked-files=no"]);
    expect(isolatedStatus.exitCode).toBe(0);
    expect(existsSync(join(root, "escaped-from-git-config"))).toBeFalse();
    run(["git", "config", "--unset", "core.fsmonitor"], prepared.repositoryPath);
    rmSync(fsMonitor);

    const replay = manager.prepare({
      incidentId,
      baseCommit,
      evidence: { ignored: "replay uses frozen packet" },
      charter: "ignored after persistence",
      model: "gpt-5.6-terra",
      reasoningEffort: "high",
    });
    expect(replay).toEqual(prepared);

    writeFileSync(join(source, "README.md"), "new origin base\n");
    run(["git", "commit", "-am", "advance origin"], source);
    const refreshedBase = run(["git", "rev-parse", "HEAD"], source);
    const refreshed = manager.prepare({
      incidentId,
      baseCommit: refreshedBase,
      evidence: { failure: "nested deploy failed", previous_patch: "bounded patch" },
      charter: "Resume the exact incident against the refreshed origin base.",
      model: "gpt-5.6-terra",
      reasoningEffort: "high",
      refresh: true,
    });
    expect(refreshed.baseCommit).toBe(refreshedBase);
    expect(refreshed.baselineLocalCommit).not.toBe(prepared.baselineLocalCommit);
    expect(refreshed.capability).not.toBe(prepared.capability);
    expect(readFileSync(join(refreshed.repositoryPath, "README.md"), "utf8")).toBe("new origin base\n");
    expect(readFileSync(join(refreshed.controlPath, "prompt.md"), "utf8")).toContain("nested deploy failed");
    expect(run(["git", "status", "--porcelain"], refreshed.repositoryPath)).toBe("");

    now += 25 * 60 * 60 * 1000;
    const staged = manager.prepareCapabilityRotation(incidentId);
    expect(manager.prepareCapabilityRotation(incidentId)).toEqual(staged);
    const previousPath = join(dirname(refreshed.controlPath), `.repair-capability-previous-${incidentId}`);
    renameSync(refreshed.controlPath, previousPath);
    const rotated = manager.activateCapabilityRotation(incidentId, staged.capabilityDigest);
    expect(rotated.capability).not.toBe(refreshed.capability);
    expect(rotated.capabilityExpiresAtMs).toBe(now + 24 * 60 * 60 * 1000);
    expect(rotated.repositoryPath).toBe(refreshed.repositoryPath);
    expect(readFileSync(join(rotated.repositoryPath, "README.md"), "utf8")).toBe("new origin base\n");
    manager.finishCapabilityRotation(incidentId, rotated.capabilityDigest);
    expect(existsSync(previousPath)).toBeFalse();

    now += 25 * 60 * 60 * 1000;
    const secondStaged = manager.prepareCapabilityRotation(incidentId);
    const pendingPath = join(dirname(rotated.controlPath), `.repair-capability-pending-${incidentId}`);
    renameSync(rotated.controlPath, previousPath);
    renameSync(pendingPath, rotated.controlPath);
    const resumedAfterActivation = manager.activateCapabilityRotation(incidentId, secondStaged.capabilityDigest);
    expect(resumedAfterActivation.capabilityDigest).toBe(secondStaged.capabilityDigest);
    manager.finishCapabilityRotation(incidentId, secondStaged.capabilityDigest);
    expect(existsSync(previousPath)).toBeFalse();

    const launches: string[][] = [];
    const launchManager = new RepairWorkspaceManager(manager.environment, {
      ...manager.services,
      spawn(command) {
        launches.push(command);
        return { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() };
      },
    });
    launchManager.launch(prepared.workerUnit);
    expect(launches).toEqual([["/usr/bin/systemctl", "start", "--no-block", prepared.workerUnit]]);
  });
});
