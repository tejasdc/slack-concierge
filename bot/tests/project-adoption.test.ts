import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptManagedProject, parseArguments } from "../scripts/adopt-project";
import { readManagedProjects } from "../src/project-registry";

const scratchDirectories: string[] = [];

afterEach(() => {
  for (const directory of scratchDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("managed project adoption", () => {
  test("uses the canonical scaffold and upserts one idempotent registry row", () => {
    const root = scratchDirectory();
    const workspaceRoot = join(root, "workspace");
    const stateDbPath = join(root, "state", "state.db");
    const codePath = join(workspaceRoot, "group", "custom");
    const customInstructions = "# Adopted custom\n\nPreserve this command: `./local-check`.\n";
    mkdirSync(codePath, { recursive: true });
    writeFileSync(join(codePath, "AGENTS.md"), customInstructions);

    const first = adoptManagedProject({
      projectName: "group_custom",
      workspaceRoot,
      stateDbPath,
      initializeGit: false,
    });
    expect(first.report.outcome).toBe("migrated");
    expect(first.registryUpdated).toBe(true);
    expect(readFileSync(join(codePath, "AGENTS.md"), "utf8")).toBe(customInstructions);
    expect(readManagedProjects(stateDbPath)).toHaveLength(1);

    const second = adoptManagedProject({
      projectName: "group_custom",
      workspaceRoot,
      stateDbPath,
      initializeGit: false,
    });
    expect(second.report.outcome).toBe("unchanged");
    expect(readManagedProjects(stateDbPath)).toHaveLength(1);
  });

  test("honors an explicit migration code path from the CLI contract", () => {
    const root = scratchDirectory();
    const workspaceRoot = join(root, "workspace");
    const stateDbPath = join(root, "state", "state.db");
    const codePath = join(workspaceRoot, "skills", "tool-skill");
    mkdirSync(codePath, { recursive: true });

    const options = parseArguments([
      "tool-skill",
      "--workspace-root", workspaceRoot,
      "--state-db", stateDbPath,
      "--code-path", codePath,
      "--no-git",
    ]);
    const result = adoptManagedProject(options);

    expect(result.paths.code).toBe(codePath);
    expect(result.report.outcome).toBe("migrated");
    expect(readManagedProjects(stateDbPath)[0]?.code_path).toBe(codePath);
    expect(existsSync(join(workspaceRoot, "tool-skill"))).toBe(false);
  });
});

function scratchDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "concierge-project-adoption-"));
  scratchDirectories.push(directory);
  return directory;
}
