import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

// The deployment migrator runs with Concierge stopped. Index text that differs only in spacing is
// no schema change (it made every update copy and re-check the whole ledger, 2026-11-04), and a
// real change still migrates and is checked.
test("spacing-only index text is no change; a real change migrates", () => {
  const script = resolve(import.meta.dir, "../scripts/migrate-deployment-repair.ts");
  const state = mkdtempSync("/tmp/concierge-schema-plan-check-");
  const run = (...args: string[]) => {
    const child = Bun.spawnSync({ cmd: [process.execPath, "run", script, ...args], cwd: resolve(import.meta.dir, ".."),
      env: { ...process.env, CONCIERGE_STATE_DIR: state, CONCIERGE_STATE_DB: join(state, "state.db"),
        CONCIERGE_SERVICE: "remote-box-concierge-ledger-trim.service" }, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    return JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!);
  };
  try {
    new Database(join(state, "state.db")).close();
    expect(run("--schema-only").status).toBe("migrated");
    const db = new Database(join(state, "state.db"));
    db.exec("DROP INDEX executions_open");
    db.exec("CREATE INDEX executions_open ON executions(turn_id) WHERE state IN ('intended', 'live', 'exited')");
    db.exec("DROP INDEX executions_survival");
    db.exec("CREATE INDEX executions_survival ON executions(provider, supervisor) WHERE adopted_live=1 AND state='released'");
    db.exec("DROP INDEX executions_turn");
    db.close();
    expect(run("--plan").changes).toEqual(["index:executions_turn"]);
    expect(run("--schema-only").status).toBe("migrated");
    expect(run("--plan").changes).toEqual([]);
    expect(run("--schema-only").status).toBe("unchanged");
  } finally { rmSync(state, { recursive: true, force: true }); }
}, 120_000);
