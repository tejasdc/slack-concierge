import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

test("router todo capture writes the canonical file idempotently with paragraph structure", () => {
  const root = mkdtempSync(join(tmpdir(), "concierge-router-todo-"));
  const vaultPath = join(root, "vault");
  const statePath = join(root, "state.db");
  const configPath = join(root, "slack.toml");
  mkdirSync(vaultPath, { recursive: true });
  writeFileSync(configPath, 'signing_secret = "test-secret"\n');
  const db = new Database(statePath);
  db.run("CREATE TABLE channels (slack_channel_id TEXT, slack_channel_name TEXT, vault_path TEXT)");
  db.query("INSERT INTO channels VALUES (?, ?, ?)").run("C_TARGET", "target", vaultPath);
  db.close();

  const args = [
    join(import.meta.dir, "../scripts/router-todo.ts"),
    "target",
    "CSOURCE",
    "123.456789",
    "--",
    "First paragraph.\n\nSecond paragraph.",
  ];
  const env = {
    ...process.env,
    CONCIERGE_STATE_DB: statePath,
    CONCIERGE_SLACK_CONFIG: configPath,
  };
  try {
    expect(spawnSync(process.execPath, args, { env }).status).toBe(0);
    expect(spawnSync(process.execPath, args, { env }).status).toBe(0);

    const content = readFileSync(join(vaultPath, "notes", "TODOS.md"), "utf8");
    expect(content.match(/^- \[ \]/gm)).toHaveLength(1);
    expect(content).toContain("- [ ] First paragraph.");
    expect(content).toMatch(/\n    %% concierge-todo-metadata-v1 concierge-capture-v1:[0-9a-f]{64} concierge-slack-origin-v1:CSOURCE:123\.456789 %%/);
    expect(content).toContain("\n\n    Second paragraph.");
    expect(content).toMatch(/concierge-capture-v1:[0-9a-f]{64}/);
    expect(content).not.toContain("<!--");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent router retries append one canonical todo", async () => {
  const root = mkdtempSync(join(tmpdir(), "concierge-router-todo-race-"));
  const vaultPath = join(root, "vault");
  const statePath = join(root, "state.db");
  const configPath = join(root, "slack.toml");
  mkdirSync(vaultPath, { recursive: true });
  writeFileSync(configPath, 'signing_secret = "test-secret"\n');
  const db = new Database(statePath);
  db.run("CREATE TABLE channels (slack_channel_id TEXT, slack_channel_name TEXT, vault_path TEXT)");
  db.query("INSERT INTO channels VALUES (?, ?, ?)").run("C_TARGET", "target", vaultPath);
  db.close();

  const args = [
    join(import.meta.dir, "../scripts/router-todo.ts"),
    "target",
    "CSOURCE",
    "123.456789",
    "--",
    "Concurrent capture.",
  ];
  const env = {
    ...process.env,
    CONCIERGE_STATE_DB: statePath,
    CONCIERGE_SLACK_CONFIG: configPath,
  };
  try {
    const statuses = await Promise.all(Array.from({ length: 24 }, () => new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, args, { env, stdio: "ignore" });
      child.on("exit", resolve);
    })));
    expect(statuses).toEqual(Array.from({ length: 24 }, () => 0));

    const content = readFileSync(join(vaultPath, "notes", "TODOS.md"), "utf8");
    expect(content.match(/Concurrent capture\./g)).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("router helper has no direct Slack List write path", () => {
  const helper = readFileSync(join(import.meta.dir, "../../systemd/router-actions.sh"), "utf8");
  expect(helper).toContain("todo-add)");
  expect(helper).toContain("list-add is retired");
  expect(helper).not.toContain("slackLists.items.create");
});
