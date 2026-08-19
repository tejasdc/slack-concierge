import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditProjectRepositories, propagateProjectRepositories } from "../src/project-git";

const scratchDirectories: string[] = [];

afterEach(() => {
  for (const directory of scratchDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("managed project Git propagation", () => {
  test("requires a clean synchronized branch and records an exact scaffold commit and push", () => {
    const fixture = gitFixture();
    const vaultPath = join(fixture.root, "vault");
    const project = [{ projectName: "alpha", codePath: fixture.project, vaultPath }];

    const audit = auditProjectRepositories(project, false);
    expect(audit.ok).toBe(true);
    expect(audit.projects[0].branch).toBe("main");
    expect(audit.projects[0].upstream).toBe("origin/main");

    writeFileSync(join(fixture.project, "AGENTS.md"), "# alpha\n");
    symlinkSync("AGENTS.md", join(fixture.project, "CLAUDE.md"));
    mkdirSync(join(fixture.project, "docs"));
    writeFileSync(join(fixture.project, "docs", "README.md"), "# docs\n");
    mkdirSync(join(vaultPath, "notes"), { recursive: true });
    symlinkSync(join(vaultPath, "notes"), join(fixture.project, "notes"));

    expect(auditProjectRepositories(project, true).ok).toBe(true);

    const propagated = propagateProjectRepositories(project);
    expect(propagated.ok).toBe(true);
    expect(propagated.projects[0].commit).not.toBeNull();
    expect(propagated.projects[0].pushed).toBe(true);
    expect(git(fixture.project, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe("");
    expect(git(fixture.project, ["rev-list", "--count", "HEAD...origin/main"])).toBe("0");
    expect(git(fixture.project, ["show", "--pretty=", "--name-only", "HEAD"]).split("\n").filter(Boolean).sort())
      .toEqual(["AGENTS.md", "CLAUDE.md", "docs/README.md", "notes"]);
  });

  test("refuses dirty audit state and unexpected post-migration paths", () => {
    const fixture = gitFixture();
    const project = [{ projectName: "alpha", codePath: fixture.project, vaultPath: join(fixture.root, "vault") }];
    writeFileSync(join(fixture.project, "unrelated.txt"), "user work\n");

    const audit = auditProjectRepositories(project, true);
    expect(audit.ok).toBe(false);
    expect(audit.projects[0].error).toContain("working tree contains unreviewed changes");

    const propagated = propagateProjectRepositories(project);
    expect(propagated.ok).toBe(false);
    expect(propagated.projects[0].error).toContain("unexpected post-migration paths");
    expect(git(fixture.project, ["rev-parse", "HEAD"])).toBe(fixture.initialHead);
  });

  test("rejects a same-named noncanonical notes symlink", () => {
    const fixture = gitFixture();
    const outsideNotes = join(fixture.root, "outside-notes");
    mkdirSync(outsideNotes);
    symlinkSync(outsideNotes, join(fixture.project, "notes"));
    const audit = auditProjectRepositories([{
      projectName: "alpha",
      codePath: fixture.project,
      vaultPath: join(fixture.root, "vault"),
    }], false);
    expect(audit.ok).toBe(false);
    expect(audit.projects[0].error).toContain("?? notes");
  });
});

function gitFixture() {
  const root = mkdtempSync(join(tmpdir(), "concierge-project-git-"));
  scratchDirectories.push(root);
  const remote = join(root, "origin.git");
  const project = join(root, "project");
  execFileSync("git", ["init", "--bare", "-q", remote]);
  execFileSync("git", ["init", "-q", "-b", "main", project]);
  git(project, ["config", "user.name", "Test User"]);
  git(project, ["config", "user.email", "test@example.com"]);
  writeFileSync(join(project, "README.md"), "# project\n");
  git(project, ["add", "README.md"]);
  git(project, ["commit", "-q", "-m", "initial"]);
  git(project, ["remote", "add", "origin", remote]);
  git(project, ["push", "-q", "-u", "origin", "main"]);
  return { root, remote, project, initialHead: git(project, ["rev-parse", "HEAD"]) };
}

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
