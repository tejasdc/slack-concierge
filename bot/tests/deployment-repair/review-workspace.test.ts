import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewWorkspaceManager } from "../../../deployment-control/kernel/review-workspace";

function git(repository: string, ...args: string[]) {
  const result = Bun.spawnSync({ cmd: ["git", "-C", repository, ...args], stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function gitBytes(repository: string, ...args: string[]) {
  const result = Bun.spawnSync({ cmd: ["git", "-C", repository, ...args], stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout;
}

describe("independent deployment review workspace", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test("freezes the repaired head without sharing writable Git state", () => {
    const root = mkdtempSync(join(tmpdir(), "concierge-review-workspace-"));
    roots.push(root);
    const repair = join(root, "repair");
    git(root, "init", "--initial-branch=repair", repair);
    git(repair, "config", "user.name", "Fixture");
    git(repair, "config", "user.email", "fixture@example.invalid");
    writeFileSync(join(repair, "README.md"), "base\n");
    git(repair, "add", "README.md");
    git(repair, "commit", "-m", "base");
    const baseline = git(repair, "rev-parse", "HEAD");
    writeFileSync(join(repair, "README.md"), "fixed\n");
    git(repair, "commit", "-am", "fix");
    const head = git(repair, "rev-parse", "HEAD");
    const reviewId = "123e4567-e89b-42d3-a456-426614174010";
    const incidentId = "123e4567-e89b-42d3-a456-426614174011";
    const manager = new ReviewWorkspaceManager({
      workerRoot: join(root, "workers"),
      controlRoot: join(root, "controls"),
      runtimeRoot: "/usr/local/lib/concierge-deployment",
      providerAdapterSocket: join(root, "adapter.sock"),
      providerAdapterPort: 41951,
      reviewUser: "fixture",
      reviewGroup: "fixture",
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
      now: () => 1_800_000_000_000,
    });
    const headArchive = gitBytes(repair, "archive", "--format=tar", head);
    const exactPatch = gitBytes(repair, "diff", "--binary", `${baseline}..${head}`);
    const prepared = manager.prepare({
      reviewId,
      incidentId,
      baseCommit: "a".repeat(40),
      baselineLocalCommit: baseline,
      headCommit: head,
      treeDigest: "1".repeat(64),
      policyDigest: "2".repeat(64),
      enforcementDigest: "3".repeat(64),
      evidenceDigest: "4".repeat(64),
      repairResult: { summary: "fixed" },
      headArchive,
      exactPatch,
      charter: "Independently review the exact change.",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
    expect(readFileSync(join(prepared.repositoryPath, "README.md"), "utf8")).toBe("fixed\n");
    expect(existsSync(join(prepared.repositoryPath, ".git"))).toBeFalse();
    expect(prepared.capability).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(readFileSync(join(prepared.controlPath, "prompt.md"), "utf8")).toContain("Exact patch");
    expect(manager.prepare({
      reviewId,
      incidentId,
      baseCommit: "a".repeat(40),
      baselineLocalCommit: baseline,
      headCommit: head,
      treeDigest: "1".repeat(64),
      policyDigest: "2".repeat(64),
      enforcementDigest: "3".repeat(64),
      evidenceDigest: "4".repeat(64),
      repairResult: { summary: "fixed" },
      charter: "Independently review the exact change.",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    })).toEqual(prepared);

    const launches: string[][] = [];
    const launchManager = new ReviewWorkspaceManager(manager.environment, {
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
