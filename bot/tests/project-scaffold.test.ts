import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  canonicalAgentsTemplate,
  canonicalDocsIndexTemplate,
  inspectProjectRoots,
  reconcileProjectScaffold,
} from "../src/project-scaffold";

const scratchDirectories: string[] = [];

afterEach(() => {
  for (const directory of scratchDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("canonical project scaffold", () => {
  test("creates one minimal useful structure and converges on the second run", () => {
    const root = scratchDirectory();
    const codePath = join(root, "workspace", "alpha");
    const vaultPath = join(root, "workspace", "vault", "projects", "alpha");

    const first = reconcileProjectScaffold({
      projectName: "alpha",
      workspaceRoot: join(root, "workspace"),
      codePath,
      vaultPath,
      initializeGit: false,
    });

    expect(first.outcome).toBe("migrated");
    expect(first.classification).toBe("missing");
    expect(lstatSync(join(codePath, "AGENTS.md")).isFile()).toBe(true);
    expect(lstatSync(join(codePath, "AGENTS.md")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(codePath, "AGENTS.md"), "utf8")).toBe(canonicalAgentsTemplate("alpha", codePath));
    expect(readlinkSync(join(codePath, "CLAUDE.md"))).toBe("AGENTS.md");
    expect(readFileSync(join(codePath, "docs", "README.md"), "utf8")).toBe(canonicalDocsIndexTemplate("alpha"));
    expect(realpathSync(join(codePath, "notes"))).toBe(realpathSync(join(vaultPath, "notes")));
    expect(readFileSync(join(vaultPath, "notes", "inbox.md"), "utf8")).toBe("# alpha inbox\n");
    expect(existsSync(join(codePath, "docs", "architecture"))).toBe(false);
    expect(existsSync(join(codePath, "docs", "runbooks"))).toBe(false);
    expect(existsSync(join(codePath, ".codex"))).toBe(false);
    expect(existsSync(join(codePath, ".claude"))).toBe(false);

    const second = reconcileProjectScaffold({
      projectName: "alpha",
      workspaceRoot: join(root, "workspace"),
      codePath,
      vaultPath,
      initializeGit: false,
    });
    expect(second.outcome).toBe("unchanged");
    expect(second.actions).toEqual([]);
  });

  test("preserves customized instructions, documentation, and colliding notes byte-for-byte", () => {
    const root = scratchDirectory();
    const codePath = join(root, "workspace", "custom");
    const vaultPath = join(root, "workspace", "vault", "projects", "custom");
    const customInstructions = "# Custom\n\nRun `./verify-custom`.\n";
    const customDocs = "# Custom docs\n\nRead `ARCH.md` first.\n";
    mkdirSync(join(codePath, "notes"), { recursive: true });
    mkdirSync(join(codePath, "docs"), { recursive: true });
    mkdirSync(join(vaultPath, "notes"), { recursive: true });
    writeFileSync(join(vaultPath, "AGENTS.md"), customInstructions);
    symlinkSync(relative(codePath, join(vaultPath, "AGENTS.md")), join(codePath, "AGENTS.md"));
    symlinkSync("AGENTS.md", join(codePath, "CLAUDE.md"));
    writeFileSync(join(codePath, "docs", "README.md"), customDocs);
    writeFileSync(join(codePath, "notes", "collision.md"), "code copy\n");
    writeFileSync(join(codePath, "notes", "only-code.md"), "preserve me\n");
    writeFileSync(join(vaultPath, "notes", "collision.md"), "vault copy\n");

    const first = reconcileProjectScaffold({
      projectName: "custom",
      workspaceRoot: join(root, "workspace"),
      codePath,
      vaultPath,
      initializeGit: false,
    });

    expect(first.outcome).toBe("migrated");
    expect(first.classification).toBe("customized");
    expect(readFileSync(join(codePath, "AGENTS.md"), "utf8")).toBe(customInstructions);
    expect(lstatSync(join(codePath, "AGENTS.md")).isSymbolicLink()).toBe(false);
    expect(readlinkSync(join(codePath, "CLAUDE.md"))).toBe("AGENTS.md");
    expect(readFileSync(join(vaultPath, "AGENTS.md.migrated-to-code-root"), "utf8")).toBe(customInstructions);
    expect(readFileSync(join(codePath, "docs", "README.md"), "utf8")).toBe(customDocs);
    expect(readFileSync(join(vaultPath, "notes", "collision.md"), "utf8")).toBe("vault copy\n");
    expect(readFileSync(join(vaultPath, "notes", "only-code.md"), "utf8")).toBe("preserve me\n");
    expect(readFileSync(join(vaultPath, "notes.pre-concierge-scaffold", "collision.md"), "utf8")).toBe("code copy\n");
    expect(first.warnings).toContain(`Preserved both note copies after collision at ${join(vaultPath, "notes", "collision.md")}`);

    const second = reconcileProjectScaffold({
      projectName: "custom",
      workspaceRoot: join(root, "workspace"),
      codePath,
      vaultPath,
      initializeGit: false,
    });
    expect(second.outcome).toBe("unchanged");
    expect(readFileSync(join(codePath, "AGENTS.md"), "utf8")).toBe(customInstructions);
  });

  test("leaves divergent customized instruction files untouched and reports ambiguity", () => {
    const root = scratchDirectory();
    const codePath = join(root, "workspace", "ambiguous");
    const vaultPath = join(root, "workspace", "vault", "projects", "ambiguous");
    mkdirSync(codePath, { recursive: true });
    writeFileSync(join(codePath, "AGENTS.md"), "# Agent rules\n\nKeep A.\n");
    writeFileSync(join(codePath, "CLAUDE.md"), "# Claude rules\n\nKeep B.\n");

    const report = reconcileProjectScaffold({
      projectName: "ambiguous",
      workspaceRoot: join(root, "workspace"),
      codePath,
      vaultPath,
      initializeGit: false,
    });

    expect(report.outcome).toBe("ambiguous");
    expect(report.classification).toBe("structurally_invalid");
    expect(readFileSync(join(codePath, "AGENTS.md"), "utf8")).toBe("# Agent rules\n\nKeep A.\n");
    expect(readFileSync(join(codePath, "CLAUDE.md"), "utf8")).toBe("# Claude rules\n\nKeep B.\n");
    expect(existsSync(join(codePath, "docs"))).toBe(false);
    expect(existsSync(vaultPath)).toBe(false);
  });

  test("treats occupied broken-symlink backup paths as structural conflicts", () => {
    const root = scratchDirectory();
    const codePath = join(root, "workspace", "broken-backup");
    const vaultPath = join(root, "workspace", "vault", "projects", "broken-backup");
    mkdirSync(codePath, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    writeFileSync(join(vaultPath, "AGENTS.md"), "# Custom\n\nKeep this body.\n");
    symlinkSync("missing-archive-target", join(vaultPath, "AGENTS.md.migrated-to-code-root"));

    const report = reconcileProjectScaffold({
      projectName: "broken-backup",
      workspaceRoot: join(root, "workspace"),
      codePath,
      vaultPath,
      initializeGit: false,
    });

    expect(report.outcome).toBe("ambiguous");
    expect(report.warnings.join("\n")).toContain("destination already exists");
    expect(readFileSync(join(vaultPath, "AGENTS.md"), "utf8")).toBe("# Custom\n\nKeep this body.\n");
    expect(existsSync(join(codePath, "AGENTS.md"))).toBe(false);
  });

  test("refuses external and dangling instruction symlinks without reading them into the project", () => {
    const root = scratchDirectory();
    const workspaceRoot = join(root, "workspace");
    const codePath = join(workspaceRoot, "unsafe-instructions");
    const vaultPath = join(workspaceRoot, "vault", "projects", "unsafe-instructions");
    const outsideSecret = join(root, "outside-secret.md");
    mkdirSync(codePath, { recursive: true });
    writeFileSync(outsideSecret, "SECRET SENTINEL\n");
    symlinkSync(outsideSecret, join(codePath, "AGENTS.md"));

    const external = reconcileProjectScaffold({
      projectName: "unsafe-instructions",
      workspaceRoot,
      codePath,
      vaultPath,
      initializeGit: false,
    });
    expect(external.outcome).toBe("ambiguous");
    expect(readlinkSync(join(codePath, "AGENTS.md"))).toBe(outsideSecret);
    expect(existsSync(join(codePath, "docs"))).toBe(false);

    rmSync(join(codePath, "AGENTS.md"));
    symlinkSync(relative(codePath, join(vaultPath, "AGENTS.md")), join(codePath, "AGENTS.md"));
    const dangling = reconcileProjectScaffold({
      projectName: "unsafe-instructions",
      workspaceRoot,
      codePath,
      vaultPath,
      initializeGit: false,
    });
    expect(dangling.outcome).toBe("ambiguous");
    expect(dangling.warnings.join("\n")).toContain("missing, cyclic, or not a regular file");
    expect(lstatSync(join(codePath, "AGENTS.md")).isSymbolicLink()).toBe(true);
  });

  test("refuses a noncanonical notes symlink without copying external content", () => {
    const root = scratchDirectory();
    const workspaceRoot = join(root, "workspace");
    const codePath = join(workspaceRoot, "unsafe-notes");
    const vaultPath = join(workspaceRoot, "vault", "projects", "unsafe-notes");
    const outsideNotes = join(root, "outside-notes");
    mkdirSync(codePath, { recursive: true });
    mkdirSync(outsideNotes, { recursive: true });
    writeFileSync(join(outsideNotes, "sentinel.md"), "private note\n");
    symlinkSync(outsideNotes, join(codePath, "notes"));

    const report = reconcileProjectScaffold({
      projectName: "unsafe-notes",
      workspaceRoot,
      codePath,
      vaultPath,
      initializeGit: false,
    });

    expect(report.outcome).toBe("ambiguous");
    expect(report.warnings.join("\n")).toContain("Notes symlink has a noncanonical target");
    expect(readlinkSync(join(codePath, "notes"))).toBe(outsideNotes);
    expect(existsSync(join(vaultPath, "notes", "sentinel.md"))).toBe(false);
    expect(existsSync(join(codePath, "AGENTS.md"))).toBe(false);
  });

  test("refuses a symlinked vault root before creating code-side files", () => {
    const root = scratchDirectory();
    const workspaceRoot = join(root, "workspace");
    const codePath = join(workspaceRoot, "unsafe-vault");
    const vaultPath = join(workspaceRoot, "vault", "projects", "unsafe-vault");
    const outsideVault = join(root, "outside-vault");
    mkdirSync(join(workspaceRoot, "vault", "projects"), { recursive: true });
    mkdirSync(outsideVault, { recursive: true });
    symlinkSync(outsideVault, vaultPath);

    const report = reconcileProjectScaffold({
      projectName: "unsafe-vault",
      workspaceRoot,
      codePath,
      vaultPath,
      initializeGit: false,
    });

    expect(report.outcome).toBe("ambiguous");
    expect(report.warnings.join("\n")).toContain("Vault root is not a real directory");
    expect(existsSync(codePath)).toBe(false);
    expect(existsSync(join(outsideVault, "notes"))).toBe(false);
  });

  test("revalidates canonical roots immediately before the first mutation", () => {
    const root = scratchDirectory();
    const workspaceRoot = join(root, "workspace");
    const firstPhysicalRoot = join(workspaceRoot, "physical-a");
    const secondPhysicalRoot = join(workspaceRoot, "physical-b");
    const aliasRoot = join(workspaceRoot, "current");
    const codePath = join(aliasRoot, "project");
    const vaultPath = join(workspaceRoot, "vault", "projects", "root-swap");
    for (const physicalRoot of [firstPhysicalRoot, secondPhysicalRoot]) {
      mkdirSync(join(physicalRoot, "project"), { recursive: true });
      writeFileSync(
        join(physicalRoot, "project", "AGENTS.md"),
        `# root-swap\n\nAgent instructions for this project.\n\nWorking directory: ${codePath}\n`,
      );
    }
    symlinkSync(relative(workspaceRoot, firstPhysicalRoot), aliasRoot);
    const dry = reconcileProjectScaffold({
      projectName: "root-swap",
      workspaceRoot,
      codePath,
      vaultPath,
      apply: false,
      initializeGit: false,
    });
    const safety = inspectProjectRoots(workspaceRoot, codePath, vaultPath);
    if (!safety.safe || !dry.expectedGitFingerprint) throw new Error("fixture did not produce a safe prepared plan");

    const applied = reconcileProjectScaffold({
      projectName: "root-swap",
      workspaceRoot,
      codePath,
      vaultPath,
      apply: true,
      initializeGit: false,
      expectedPlan: {
        canonicalCodePath: safety.canonicalCodePath,
        canonicalVaultPath: safety.canonicalVaultPath,
        actions: dry.actions,
        expectedGitFingerprint: dry.expectedGitFingerprint,
      },
      beforeMutationValidation: () => {
        rmSync(aliasRoot);
        symlinkSync(relative(workspaceRoot, secondPhysicalRoot), aliasRoot);
      },
    });

    expect(applied.outcome).toBe("ambiguous");
    expect(applied.applied).toBe(false);
    expect(applied.warnings.join("\n")).toContain("mutation boundary");
    expect(existsSync(join(secondPhysicalRoot, "project", "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(secondPhysicalRoot, "project", "docs"))).toBe(false);
    expect(existsSync(vaultPath)).toBe(false);
  });
});

function scratchDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "concierge-project-scaffold-"));
  scratchDirectories.push(directory);
  return directory;
}
