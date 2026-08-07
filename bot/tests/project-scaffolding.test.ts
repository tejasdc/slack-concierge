import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";

const workspaceRoot = `/tmp/concierge-project-scaffolding-test-${process.pid}-${Date.now()}`;
process.env.CONCIERGE_STATE_DIR = "/tmp/concierge-state-project-scaffolding-test";
process.env.CONCIERGE_WORKSPACE_ROOT = workspaceRoot;

const { db } = require("../src/state");
const { newProject } = require("../src/channel");

beforeEach(() => {
  db.query("DELETE FROM turns").run();
  db.query("DELETE FROM sessions").run();
  db.query("DELETE FROM channels").run();
});

describe("newProject instruction-file scaffolding", () => {
  test("creates a real vault AGENTS.md and canonical code-side symlinks", () => {
    const paths = newProject("CNEW", "example-project", workspaceRoot);
    const vaultAgents = join(paths.vault, "AGENTS.md");
    const codeAgents = join(paths.code, "AGENTS.md");
    const codeClaude = join(paths.code, "CLAUDE.md");

    expect(lstatSync(vaultAgents).isFile()).toBe(true);
    expect(lstatSync(vaultAgents).isSymbolicLink()).toBe(false);
    expect(lstatSync(codeAgents).isSymbolicLink()).toBe(true);
    expect(readlinkSync(codeAgents)).toBe(vaultAgents);
    expect(lstatSync(codeClaude).isSymbolicLink()).toBe(true);
    expect(readlinkSync(codeClaude)).toBe("AGENTS.md");
  });

  test("replaces a vault AGENTS.md symlink with a real file without losing its content", () => {
    const vault = join(workspaceRoot, "vault", "projects", "linked-project");
    const original = join(workspaceRoot, "original-agents.md");
    mkdirSync(vault, { recursive: true });
    writeFileSync(original, "# Preserved instructions\n");
    symlinkSync(original, join(vault, "AGENTS.md"));

    const paths = newProject("CLINK", "linked-project", workspaceRoot);
    const vaultAgents = join(paths.vault, "AGENTS.md");

    expect(lstatSync(vaultAgents).isFile()).toBe(true);
    expect(lstatSync(vaultAgents).isSymbolicLink()).toBe(false);
    expect(readFileSync(vaultAgents, "utf8")).toBe("# Preserved instructions\n");
    expect(existsSync(join(paths.code, "CLAUDE.md"))).toBe(true);
  });
});
