import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { runManagedProjectMigration } from "../scripts/migrate-project-scaffolds";
import { propagateProjectRepositories } from "../src/project-git";
import { beginProjectCutover, readProjectCutoverState } from "../src/project-cutover-state";
import { registerAdoptedProject } from "../src/project-registry";
import { canonicalAgentsTemplate, canonicalDocsIndexTemplate } from "../src/project-scaffold";

const scratchDirectories: string[] = [];

afterEach(() => {
  for (const directory of scratchDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("managed project migration command", () => {
  test("audits and propagates only projects whose scaffold will write", () => {
    const root = mkdtempSync(join(tmpdir(), "concierge-migration-command-"));
    scratchDirectories.push(root);
    const workspaceRoot = join(root, "workspace");
    const stateDbPath = join(root, "state", "state.db");
    const changed = gitProject(root, workspaceRoot, "changed");
    const unchangedCode = join(workspaceRoot, "unchanged");
    const unchangedVault = join(workspaceRoot, "vault", "projects", "unchanged");
    mkdirSync(join(unchangedCode, "docs"), { recursive: true });
    mkdirSync(join(unchangedVault, "notes"), { recursive: true });
    writeFileSync(join(unchangedCode, "AGENTS.md"), canonicalAgentsTemplate("unchanged", unchangedCode));
    symlinkSync("AGENTS.md", join(unchangedCode, "CLAUDE.md"));
    writeFileSync(join(unchangedCode, "docs", "README.md"), canonicalDocsIndexTemplate("unchanged"));
    writeFileSync(join(unchangedVault, "notes", "inbox.md"), "# unchanged inbox\n");
    writeFileSync(join(unchangedVault, "notes", "TODOS.md"), "# unchanged todos\n");
    symlinkSync(relative(unchangedCode, join(unchangedVault, "notes")), join(unchangedCode, "notes"));
    register(stateDbPath, "changed", changed.code, changed.vault);
    register(stateDbPath, "unchanged", unchangedCode, unchangedVault);

    const dry = runManagedProjectMigration(commandOptions(stateDbPath, workspaceRoot));
    expect(dry.migration.counts).toEqual({ migrated: 1, unchanged: 1, skipped: 0, ambiguous: 0 });
    expect(dry.git.ok).toBe(true);
    expect(dry.git.projects.map((project) => project.projectName)).toEqual(["changed"]);

    const unauthorized = runManagedProjectMigration({
      ...commandOptions(stateDbPath, workspaceRoot),
      apply: true,
      propagateGit: true,
    });
    expect(unauthorized.authorizedApply).toBe(false);
    expect(readFileSync(join(changed.code, "AGENTS.md"), "utf8")).toContain("Agent instructions for this project");

    beginCutover(root, workspaceRoot, stateDbPath);
    const applied = runManagedProjectMigration({
      ...commandOptions(stateDbPath, workspaceRoot),
      apply: true,
      propagateGit: true,
      cutoverAuthorized: true,
    });
    expect(applied.authorizedApply).toBe(true);
    expect(applied.migration.applied).toBe(true);
    expect(applied.git.ok).toBe(true);
    expect(applied.git.projects.map((project) => project.projectName)).toEqual(["changed"]);
    expect(applied.git.projects[0].commit).not.toBeNull();
    expect(readProjectCutoverState(join(root, "state"))?.projects[0].propagatedHead).toBe(applied.git.projects[0].headAfter);
    expect(readFileSync(join(changed.code, "AGENTS.md"), "utf8")).toBe(canonicalAgentsTemplate("changed", changed.code));
    expect(git(changed.code, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe("");
  });

  test("recovers a crash after filesystem apply before Git propagation", () => {
    const root = mkdtempSync(join(tmpdir(), "concierge-migration-crash-"));
    scratchDirectories.push(root);
    const workspaceRoot = join(root, "workspace");
    const stateDbPath = join(root, "state", "state.db");
    const project = gitProject(root, workspaceRoot, "crash");
    register(stateDbPath, "crash", project.code, project.vault);
    beginCutover(root, workspaceRoot, stateDbPath);

    expect(() => runManagedProjectMigration({
      ...commandOptions(stateDbPath, workspaceRoot),
      apply: true,
      propagateGit: true,
      cutoverAuthorized: true,
      propagateRepositories: () => { throw new Error("simulated crash before propagation"); },
    })).toThrow("simulated crash before propagation");
    expect(git(project.code, ["status", "--porcelain=v1", "--untracked-files=all"])).not.toBe("");
    expect(readProjectCutoverState(join(root, "state"))?.projects[0].propagatedHead).toBeNull();

    const recovered = runManagedProjectMigration({
      ...commandOptions(stateDbPath, workspaceRoot),
      apply: true,
      propagateGit: true,
      cutoverAuthorized: true,
    });
    expect(recovered.migration.counts.migrated).toBe(0);
    expect(recovered.git.ok).toBe(true);
    expect(git(project.code, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe("");
    expect(git(project.code, ["rev-list", "--count", "HEAD...origin/main"])).toBe("0");
  });

  test("resumes uncompleted repositories after a mid-fleet propagation failure", () => {
    const root = mkdtempSync(join(tmpdir(), "concierge-migration-mid-fleet-"));
    scratchDirectories.push(root);
    const workspaceRoot = join(root, "workspace");
    const stateDbPath = join(root, "state", "state.db");
    const alpha = gitProject(root, workspaceRoot, "alpha");
    const beta = gitProject(root, workspaceRoot, "beta");
    register(stateDbPath, "alpha", alpha.code, alpha.vault);
    register(stateDbPath, "beta", beta.code, beta.vault);
    beginCutover(root, workspaceRoot, stateDbPath);

    const interrupted = runManagedProjectMigration({
      ...commandOptions(stateDbPath, workspaceRoot),
      apply: true,
      propagateGit: true,
      cutoverAuthorized: true,
      propagateRepositories: (projects, onPropagated) => {
        const first = propagateProjectRepositories(projects.slice(0, 1), onPropagated);
        return {
          ok: false,
          phase: "propagate",
          projects: [
            ...first.projects,
            {
              projectName: projects[1].projectName,
              codePath: projects[1].codePath,
              ready: false,
              branch: null,
              upstream: null,
              headBefore: null,
              headAfter: null,
              commit: null,
              pushed: false,
              error: "simulated second repository failure",
            },
          ],
        };
      },
    });
    expect(interrupted.git.ok).toBe(false);
    expect(readProjectCutoverState(join(root, "state"))?.projects.map((project) => project.propagatedHead !== null))
      .toEqual([true, false]);

    const recovered = runManagedProjectMigration({
      ...commandOptions(stateDbPath, workspaceRoot),
      apply: true,
      propagateGit: true,
      cutoverAuthorized: true,
    });
    expect(recovered.git.ok).toBe(true);
    for (const project of [alpha, beta]) {
      expect(git(project.code, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe("");
      expect(git(project.code, ["rev-list", "--count", "HEAD...origin/main"])).toBe("0");
    }
  });
});

function commandOptions(stateDbPath: string, workspaceRoot: string) {
  return {
    stateDbPath,
    workspaceRoot,
    apply: false,
    pauseSync: false,
    propagateGit: false,
    cutoverAuthorized: false,
    reviewedExceptionFingerprints: [],
  };
}

function beginCutover(root: string, workspaceRoot: string, stateDbPath: string) {
  const captureStateDbPath = join(root, "capture", "state.db");
  mkdirSync(join(root, "capture"), { recursive: true });
  return beginProjectCutover({
    stateDir: join(root, "state"),
    workspaceRoot,
    stateDbPath,
    captureStateDbPath,
  });
}

function gitProject(root: string, workspaceRoot: string, name: string) {
  const remote = join(root, `${name}.git`);
  const code = join(workspaceRoot, name);
  const vault = join(workspaceRoot, "vault", "projects", name);
  execFileSync("git", ["init", "--bare", "-q", remote]);
  execFileSync("git", ["init", "-q", "-b", "main", code]);
  git(code, ["config", "user.name", "Test User"]);
  git(code, ["config", "user.email", "test@example.com"]);
  writeFileSync(join(code, "AGENTS.md"), `# ${name}\n\nAgent instructions for this project.\n\nWorking directory: ${code}\n`);
  git(code, ["add", "AGENTS.md"]);
  git(code, ["commit", "-q", "-m", "initial"]);
  git(code, ["remote", "add", "origin", remote]);
  git(code, ["push", "-q", "-u", "origin", "main"]);
  return { code, vault };
}

function register(stateDbPath: string, projectName: string, codePath: string, vaultPath: string) {
  registerAdoptedProject({
    stateDbPath,
    projectName,
    codePath,
    vaultPath,
    group: null,
    name: projectName,
  });
}

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
