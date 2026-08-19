import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginProjectCutover,
  completeProjectCutover,
  markProjectPropagated,
  persistPropagationIntent,
  readProjectCutoverState,
  requireCanvasRefresh,
  startupCutoverDecision,
  type ProjectPropagationIntent,
} from "../src/project-cutover-state";

const scratchDirectories: string[] = [];

afterEach(() => {
  for (const directory of scratchDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("durable project scaffold cutover state", () => {
  test("blocks startup throughout early and propagating failures, then preserves the drain for strict Canvas startup", () => {
    const fixture = stateFixture();
    beginProjectCutover(fixture);
    expect(startupCutoverDecision(fixture.stateDir)).toEqual({
      allowStartup: false,
      preserveDrain: true,
      requireCanvasRefresh: false,
    });

    persistPropagationIntent(fixture.stateDir, [intent(fixture)]);
    expect(startupCutoverDecision(fixture.stateDir).allowStartup).toBe(false);

    markProjectPropagated(fixture.stateDir, fixture.codePath, "propagated-head");
    requireCanvasRefresh(fixture.stateDir);
    expect(startupCutoverDecision(fixture.stateDir)).toEqual({
      allowStartup: true,
      preserveDrain: true,
      requireCanvasRefresh: true,
    });
  });

  test("cannot remove cutover state until both admission gates are released", () => {
    const fixture = stateFixture();
    beginProjectCutover(fixture);
    persistPropagationIntent(fixture.stateDir, [{ ...intent(fixture), propagatedHead: "propagated-head" }]);
    requireCanvasRefresh(fixture.stateDir);
    const database = new Database(fixture.stateDbPath);
    database.query(`INSERT INTO deployment_drain
      (singleton, token, owner_pid, owner_boot_id, owner_start_ticks)
      VALUES (1, 'gate', 123, 'boot', 'ticks')`).run();
    database.close();

    expect(() => completeProjectCutover(fixture.stateDir)).toThrow("deployment gate exists");
    expect(readProjectCutoverState(fixture.stateDir)?.phase).toBe("canvas_required");

    const reopened = new Database(fixture.stateDbPath);
    reopened.query("DELETE FROM deployment_drain").run();
    reopened.close();
    const captureDatabase = new Database(fixture.captureStateDbPath);
    captureDatabase.query(`INSERT INTO capture_delivery_gate (singleton, token) VALUES (1, 'capture-gate')`).run();
    captureDatabase.close();
    expect(() => completeProjectCutover(fixture.stateDir)).toThrow("capture delivery gate exists");
    const reopenedCapture = new Database(fixture.captureStateDbPath);
    reopenedCapture.query("DELETE FROM capture_delivery_gate").run();
    reopenedCapture.close();
    completeProjectCutover(fixture.stateDir);
    expect(readProjectCutoverState(fixture.stateDir)).toBeNull();
    expect(startupCutoverDecision(fixture.stateDir).allowStartup).toBe(true);
  });
});

function stateFixture() {
  const stateDir = mkdtempSync(join(tmpdir(), "concierge-cutover-state-"));
  scratchDirectories.push(stateDir);
  const stateDbPath = join(stateDir, "state.db");
  const captureStateDbPath = join(stateDir, "capture.db");
  const database = new Database(stateDbPath, { create: true });
  database.exec(`CREATE TABLE deployment_drain (
    singleton INTEGER PRIMARY KEY,
    token TEXT NOT NULL,
    owner_pid INTEGER NOT NULL,
    owner_boot_id TEXT NOT NULL,
    owner_start_ticks TEXT NOT NULL
  )`);
  database.close();
  const captureDatabase = new Database(captureStateDbPath, { create: true });
  captureDatabase.exec("CREATE TABLE capture_delivery_gate (singleton INTEGER PRIMARY KEY, token TEXT NOT NULL)");
  captureDatabase.close();
  return {
    stateDir,
    stateDbPath,
    captureStateDbPath,
    workspaceRoot: join(stateDir, "workspace"),
    codePath: join(stateDir, "workspace", "alpha"),
    vaultPath: join(stateDir, "workspace", "vault", "projects", "alpha"),
  };
}

function intent(fixture: ReturnType<typeof stateFixture>): ProjectPropagationIntent {
  return {
    projectName: "alpha",
    codePath: fixture.codePath,
    vaultPath: fixture.vaultPath,
    canonicalCodePath: fixture.codePath,
    canonicalVaultPath: fixture.vaultPath,
    branch: "main",
    upstream: "origin/main",
    preparedHead: "prepared-head",
    plannedActions: ["write scaffold"],
    expectedGitFingerprint: "fingerprint",
    propagatedHead: null,
  };
}
