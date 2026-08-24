import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepairIntegrationManager } from "../../../deployment-control/kernel/integration";
import { repairTreeDigest } from "../../../deployment-control/kernel/repair-workspace";

function git(repository: string, ...args: string[]) {
  const result = Bun.spawnSync({ cmd: ["git", "-C", repository, ...args], stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

describe("reviewed repair integration", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test("creates and pushes only a fast-forward commit whose tree equals the reviewed tree", () => {
    const root = mkdtempSync(join(tmpdir(), "concierge-repair-integration-"));
    roots.push(root);
    const origin = join(root, "origin.git");
    const canonical = join(root, "canonical");
    const repair = join(root, "repair");
    git(root, "init", "--bare", "--initial-branch=main", origin);
    git(root, "init", "--initial-branch=main", canonical);
    git(canonical, "config", "user.name", "Fixture");
    git(canonical, "config", "user.email", "fixture@example.invalid");
    writeFileSync(join(canonical, "README.md"), "base\n");
    git(canonical, "add", "README.md");
    git(canonical, "commit", "-m", "base");
    const base = git(canonical, "rev-parse", "HEAD");
    git(canonical, "remote", "add", "origin", origin);
    git(canonical, "push", "-u", "origin", "main");

    git(root, "init", "--initial-branch=repair", repair);
    git(repair, "config", "user.name", "Repair");
    git(repair, "config", "user.email", "repair@example.invalid");
    git(repair, "config", "core.hooksPath", "/dev/null");
    writeFileSync(join(repair, "README.md"), "base\n");
    git(repair, "add", "README.md");
    git(repair, "commit", "-m", "local baseline");
    const localBaseline = git(repair, "rev-parse", "HEAD");
    writeFileSync(join(repair, "README.md"), "fixed\n");
    git(repair, "commit", "-am", "repair");
    const repairHead = git(repair, "rev-parse", "HEAD");
    const treeDigest = repairTreeDigest(repair);
    const manager = new RepairIntegrationManager({
      repositoryRoot: canonical,
      integrationRoot: join(root, "integration"),
      originRemote: "origin",
      originBranch: "main",
      home: root,
    });
    const result = manager.integrate({
      incidentId: "123e4567-e89b-42d3-a456-426614174012",
      originBaseCommit: base,
      reviewedTreeDigest: treeDigest,
      reviewedPatch: Bun.spawnSync({
        cmd: ["git", "-C", repair, "diff", "--binary", `${localBaseline}..${repairHead}`],
        stdout: "pipe",
        stderr: "pipe",
      }).stdout,
      summary: "Repair the fixture deployment.",
    });
    expect(git(canonical, "fetch", "origin", "main")).toBe("");
    expect(git(canonical, "rev-parse", "origin/main")).toBe(result.integrated_commit);
    expect(git(canonical, "merge-base", "--is-ancestor", base, result.integrated_commit)).toBe("");
    expect(result.integrated_commit).not.toBe(repairHead);
  });
});
