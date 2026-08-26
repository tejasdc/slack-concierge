import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { adoptManagedProject, parseArguments } from "../scripts/adopt-project";
import { readManagedProjects, replaceManagedProjectMapping } from "../src/project-registry";

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

describe("managed project mapping replacement", () => {
  const expected = {
    slack_channel_name: "D123DM", group_name: null, name: "d123dm",
    code_path: "/workspace/d123dm", vault_path: "/workspace/vault/projects/d123dm",
  };
  const replacement = {
    slack_channel_name: "Concierge DM", group_name: null, name: "concierge-dm",
    code_path: "/workspace/concierge-dm", vault_path: "/workspace/vault/projects/concierge-dm",
  };

  function fixture() {
    const stateDbPath = join(scratchDirectory(), "state.db");
    const database = new Database(stateDbPath);
    database.exec(`
      CREATE TABLE channels (
        slack_channel_id TEXT PRIMARY KEY, slack_channel_name TEXT, group_name TEXT, name TEXT,
        code_path TEXT, vault_path TEXT, provider_default TEXT, mode TEXT, additional_paths TEXT,
        bot_user_id TEXT, session_mode TEXT, default_session_uuid TEXT, canvas_id TEXT,
        list_id TEXT, list_title_column_id TEXT, list_completed_column_id TEXT,
        list_access_level TEXT, list_creation_intent_id TEXT
      );
      CREATE TABLE sessions (id INTEGER PRIMARY KEY, slack_channel_id TEXT, agent_session_uuid TEXT);
      INSERT INTO sessions VALUES (7, 'D123DM', 'existing-session');
    `);
    database.query(`INSERT INTO channels VALUES (
      ?, ?, ?, ?, ?, ?, 'claude-code', 'agent-tag', '["/extra"]', 'B123',
      'single-persistent', 'default-session', 'F_CANVAS', 'F_LIST', 'ColTitle', 'ColDone', 'read', 'intent'
    )`).run("D123DM", expected.slack_channel_name, expected.group_name, expected.name, expected.code_path, expected.vault_path);
    return { database, input: { stateDbPath, channelId: "D123DM", expected, replacement } };
  }

  test("changes only the mapping and preserves all provider, List, and session state", () => {
    const { database, input } = fixture();
    try {
      const before = database.query("SELECT * FROM channels").get();
      const sessions = database.query("SELECT * FROM sessions").all();
      replaceManagedProjectMapping(input);
      expect(database.query("SELECT * FROM channels").get()).toEqual({ ...before, ...replacement });
      expect(database.query("SELECT * FROM sessions").all()).toEqual(sessions);
      expect(() => replaceManagedProjectMapping(input)).toThrow("Project mapping changed");
      replaceManagedProjectMapping({ ...input, expected: replacement, replacement: expected });
      expect(database.query("SELECT * FROM channels").get()).toEqual(before);
    } finally {
      database.close();
    }
  });

  test.each(["slack_channel_name", "group_name", "name", "code_path", "vault_path"] as const)(
    "refuses stale %s without writes", (field) => {
      const { database, input } = fixture();
      try {
        const before = database.query("SELECT * FROM channels").all();
        expect(() => replaceManagedProjectMapping({
          ...input, expected: { ...expected, [field]: "stale" },
        })).toThrow("Project mapping changed");
        expect(database.query("SELECT * FROM channels").all()).toEqual(before);
      } finally {
        database.close();
      }
    },
  );

  test.each(["code_path", "vault_path"] as const)("refuses an already claimed %s without writes", (field) => {
    const { database, input } = fixture();
    try {
      database.query(`INSERT INTO channels (${field}) VALUES (?)`).run(replacement[field]);
      const before = database.query("SELECT * FROM channels").all();
      expect(() => replaceManagedProjectMapping(input)).toThrow("destination is already registered");
      expect(database.query("SELECT * FROM channels").all()).toEqual(before);
    } finally {
      database.close();
    }
  });
});
