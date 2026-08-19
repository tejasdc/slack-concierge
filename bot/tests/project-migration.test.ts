import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { migrateManagedProjectScaffolds } from "../src/project-migration";
import { readManagedProjects, registerAdoptedProject } from "../src/project-registry";
import { canonicalAgentsTemplate } from "../src/project-scaffold";

const scratchDirectories: string[] = [];

afterEach(() => {
  for (const directory of scratchDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("managed project scaffold migration", () => {
  test("refuses every write when the canonical inventory contains any blocker", () => {
    const root = scratchDirectory();
    const workspaceRoot = join(root, "workspace");
    const stateDbPath = join(root, "state", "state.db");
    const alpha = projectPaths(workspaceRoot, "alpha");
    const ambiguous = projectPaths(workspaceRoot, "ambiguous");
    const missing = projectPaths(workspaceRoot, "missing");
    const outside = { code: join(root, "outside", "external"), vault: join(root, "outside", "vault") };
    const overlapping = { code: join(workspaceRoot, "overlapping"), vault: join(workspaceRoot, "overlapping", "vault") };
    const physical = projectPaths(workspaceRoot, "physical/project");
    const alias = { code: join(workspaceRoot, "alias", "project"), vault: join(workspaceRoot, "vault", "projects", "alias-project") };
    const unmanaged = projectPaths(workspaceRoot, "unmanaged");

    for (const paths of [alpha, ambiguous, outside, overlapping, physical, unmanaged]) {
      mkdirSync(paths.code, { recursive: true });
    }
    mkdirSync(join(workspaceRoot, "alias"), { recursive: true });
    rmSync(join(workspaceRoot, "alias"), { recursive: true });
    symlinkSync(relative(workspaceRoot, join(workspaceRoot, "physical")), join(workspaceRoot, "alias"));
    writeFileSync(join(alpha.code, "AGENTS.md"), legacyPlaceholder("alpha", alpha.code));
    writeFileSync(join(ambiguous.code, "AGENTS.md"), "# A\n\nCustom A.\n");
    writeFileSync(join(ambiguous.code, "CLAUDE.md"), "# B\n\nCustom B.\n");
    writeFileSync(join(unmanaged.code, "AGENTS.md"), "# Unmanaged\n\nDo not touch.\n");

    register(stateDbPath, "alpha", alpha);
    register(stateDbPath, "ambiguous", ambiguous);
    register(stateDbPath, "missing", missing);
    register(stateDbPath, "outside", outside);
    register(stateDbPath, "overlapping", overlapping);
    register(stateDbPath, "physical", physical);
    register(stateDbPath, "physical_alias", alias);
    register(stateDbPath, "relative", { code: ".", vault: join(workspaceRoot, "vault", "projects", "relative") });
    const registryBefore = readManagedProjects(stateDbPath);

    const report = migrateManagedProjectScaffolds({
      stateDbPath,
      workspaceRoot,
      apply: true,
      initializeGit: false,
    });

    expect(report.applied).toBe(false);
    expect(report.partial).toBe(false);
    expect(report.counts).toEqual({ migrated: 2, unchanged: 0, skipped: 5, ambiguous: 1 });
    expect(readFileSync(join(alpha.code, "AGENTS.md"), "utf8")).toBe(legacyPlaceholder("alpha", alpha.code));
    expect(existsSync(join(alpha.code, "docs"))).toBe(false);
    expect(existsSync(join(physical.code, "AGENTS.md"))).toBe(false);
    expect(readFileSync(join(unmanaged.code, "AGENTS.md"), "utf8")).toBe("# Unmanaged\n\nDo not touch.\n");
    expect(readManagedProjects(stateDbPath)).toEqual(registryBefore);
    expect(report.projects.find((project) => project.projectName === "relative")?.warnings.join("\n")).toContain("absolute path");
    expect(report.projects.find((project) => project.projectName === "physical_alias")?.warnings.join("\n")).toContain("Canonical code path duplicates");

    const reviewedExceptionFingerprints = report.exceptionFingerprints.map((entry) => entry.fingerprint);
    writeFileSync(join(ambiguous.code, "AGENTS.md"), "# A changed\n\nCustom A changed.\n");
    const drifted = migrateManagedProjectScaffolds({
      stateDbPath,
      workspaceRoot,
      apply: true,
      initializeGit: false,
      reviewedExceptionFingerprints,
    });
    expect(drifted.exceptionsAccepted).toBe(false);
    expect(drifted.applied).toBe(false);
    expect(readFileSync(join(alpha.code, "AGENTS.md"), "utf8")).toBe(legacyPlaceholder("alpha", alpha.code));

    writeFileSync(join(ambiguous.code, "AGENTS.md"), "# A\n\nCustom A.\n");
    const excepted = migrateManagedProjectScaffolds({
      stateDbPath,
      workspaceRoot,
      apply: true,
      initializeGit: false,
      reviewedExceptionFingerprints,
    });
    expect(excepted.exceptionsAccepted).toBe(true);
    expect(excepted.applied).toBe(true);
    expect(excepted.partial).toBe(false);
    expect(readFileSync(join(alpha.code, "AGENTS.md"), "utf8")).toBe(canonicalAgentsTemplate("alpha", alpha.code));
    expect(existsSync(join(physical.code, "AGENTS.md"))).toBe(true);
    expect(readManagedProjects(stateDbPath)).toEqual(registryBefore);
  });

  test("applies a clean registry snapshot and converges on the second run", () => {
    const root = scratchDirectory();
    const workspaceRoot = join(root, "workspace");
    const stateDbPath = join(root, "state", "state.db");
    const alpha = projectPaths(workspaceRoot, "alpha");
    const custom = projectPaths(workspaceRoot, "custom");
    const customInstructions = "# Custom project\n\nRun the exact local command.\n";
    mkdirSync(alpha.code, { recursive: true });
    mkdirSync(custom.code, { recursive: true });
    writeFileSync(join(alpha.code, "AGENTS.md"), legacyPlaceholder("alpha", alpha.code));
    writeFileSync(join(custom.code, "AGENTS.md"), customInstructions);
    register(stateDbPath, "alpha", alpha);
    register(stateDbPath, "custom", custom);
    const registryBefore = readManagedProjects(stateDbPath);

    const dryRun = migrateManagedProjectScaffolds({ stateDbPath, workspaceRoot, initializeGit: false });
    expect(dryRun.applied).toBe(false);
    expect(dryRun.exceptionsAccepted).toBe(true);
    expect(dryRun.counts).toEqual({ migrated: 2, unchanged: 0, skipped: 0, ambiguous: 0 });
    expect(existsSync(join(alpha.code, "docs"))).toBe(false);

    const applied = migrateManagedProjectScaffolds({ stateDbPath, workspaceRoot, apply: true, initializeGit: false });
    expect(applied.applied).toBe(true);
    expect(applied.partial).toBe(false);
    expect(applied.counts).toEqual({ migrated: 2, unchanged: 0, skipped: 0, ambiguous: 0 });
    expect(readFileSync(join(alpha.code, "AGENTS.md"), "utf8")).toBe(canonicalAgentsTemplate("alpha", alpha.code));
    expect(readFileSync(join(custom.code, "AGENTS.md"), "utf8")).toBe(customInstructions);
    expect(readManagedProjects(stateDbPath)).toEqual(registryBefore);

    const second = migrateManagedProjectScaffolds({ stateDbPath, workspaceRoot, apply: true, initializeGit: false });
    expect(second.applied).toBe(true);
    expect(second.partial).toBe(false);
    expect(second.counts).toEqual({ migrated: 0, unchanged: 2, skipped: 0, ambiguous: 0 });
  });

  test("refuses applying-preflight drift from the prepared project inventory", () => {
    const root = scratchDirectory();
    const workspaceRoot = join(root, "workspace");
    const stateDbPath = join(root, "state", "state.db");
    const alpha = projectPaths(workspaceRoot, "alpha");
    mkdirSync(alpha.code, { recursive: true });
    writeFileSync(join(alpha.code, "AGENTS.md"), legacyPlaceholder("alpha", alpha.code));
    register(stateDbPath, "alpha", alpha);
    const prepared = migrateManagedProjectScaffolds({ stateDbPath, workspaceRoot, initializeGit: false });
    const preparedProjects = prepared.projects.map((project) => ({
      codePath: project.codePath,
      vaultPath: project.vaultPath,
      plannedActions: project.actions,
      expectedGitFingerprint: project.expectedGitFingerprint!,
    }));

    mkdirSync(join(alpha.code, "docs"));
    writeFileSync(join(alpha.code, "docs", "README.md"), "# User-created docs during preparation\n");
    const applied = migrateManagedProjectScaffolds({
      stateDbPath,
      workspaceRoot,
      apply: true,
      initializeGit: false,
      preparedProjects,
    });

    expect(applied.applied).toBe(false);
    expect(applied.projects[0].warnings.join("\n")).toContain("reviewed identity or Git state");
    expect(readFileSync(join(alpha.code, "AGENTS.md"), "utf8")).toBe(legacyPlaceholder("alpha", alpha.code));
    expect(existsSync(join(alpha.code, "CLAUDE.md"))).toBe(false);
  });

  test("guards each later project against drift at its mutation boundary", () => {
    const root = scratchDirectory();
    const workspaceRoot = join(root, "workspace");
    const stateDbPath = join(root, "state", "state.db");
    const alpha = projectPaths(workspaceRoot, "alpha");
    const omega = projectPaths(workspaceRoot, "omega");
    for (const [name, paths] of [["alpha", alpha], ["omega", omega]] as const) {
      mkdirSync(paths.code, { recursive: true });
      writeFileSync(join(paths.code, "AGENTS.md"), legacyPlaceholder(name, paths.code));
      register(stateDbPath, name, paths);
    }
    const prepared = migrateManagedProjectScaffolds({ stateDbPath, workspaceRoot, initializeGit: false });
    const preparedProjects = prepared.projects.map((project) => ({
      codePath: project.codePath,
      vaultPath: project.vaultPath,
      plannedActions: project.actions,
      expectedGitFingerprint: project.expectedGitFingerprint!,
    }));

    const firstAttempt = migrateManagedProjectScaffolds({
      stateDbPath,
      workspaceRoot,
      apply: true,
      initializeGit: false,
      preparedProjects,
      beforeApplyProject: (project) => {
        if (project.projectName === "omega") {
          writeFileSync(join(omega.code, "AGENTS.md"), "# Concurrent custom instructions\n\nDo not replace this content.\n");
        }
      },
    });

    expect(firstAttempt.applied).toBe(false);
    expect(firstAttempt.partial).toBe(true);
    expect(firstAttempt.projects.find((project) => project.projectName === "omega")?.warnings.join("\n"))
      .toContain("mutation boundary");
    expect(readFileSync(join(omega.code, "AGENTS.md"), "utf8")).toContain("Concurrent custom instructions");
    expect(existsSync(join(omega.code, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(omega.code, "docs"))).toBe(false);
    expect(existsSync(join(omega.code, "notes"))).toBe(false);

    writeFileSync(join(omega.code, "AGENTS.md"), legacyPlaceholder("omega", omega.code));
    const recovered = migrateManagedProjectScaffolds({
      stateDbPath,
      workspaceRoot,
      apply: true,
      initializeGit: false,
      preparedProjects,
      allowPreparedActionSubsets: true,
    });
    expect(recovered.applied).toBe(true);
    expect(recovered.partial).toBe(false);
    expect(existsSync(join(omega.code, "CLAUDE.md"))).toBe(true);
  });
});

function legacyPlaceholder(projectName: string, codePath: string) {
  return `# ${projectName}\n\nAgent instructions for this project.\n\nWorking directory: ${codePath}\n`;
}

function projectPaths(workspaceRoot: string, name: string) {
  return {
    code: join(workspaceRoot, name),
    vault: join(workspaceRoot, "vault", "projects", name),
  };
}

function register(stateDbPath: string, projectName: string, paths: { code: string; vault: string }) {
  registerAdoptedProject({
    stateDbPath,
    projectName,
    codePath: paths.code,
    vaultPath: paths.vault,
    group: null,
    name: projectName,
  });
}

function scratchDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "concierge-project-migration-"));
  scratchDirectories.push(directory);
  return directory;
}
