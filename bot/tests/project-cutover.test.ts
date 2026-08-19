import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const repo = join(import.meta.dir, "../..");

describe("canonical scaffold cutover ordering", () => {
  test("holds the existing deployment gate through stop, migration, idempotency, strict Canvas refresh, and deploy", () => {
    const scriptPath = join(repo, "bot/scripts/project-scaffold-cutover.sh");
    const script = readFileSync(scriptPath, "utf8");
    expect(statSync(scriptPath).mode & 0o111).not.toBe(0);
    expect(script).toContain('source "$SCRIPT_DIR/deploy.sh"');
    expect(script).toContain("CONCIERGE_PRESERVE_GATES_ON_FAILURE=1");
    expect(script.indexOf("claim_deployment_gate")).toBeLessThan(script.indexOf('systemctl stop "$SERVICE"'));
    expect(script.indexOf('project-scaffold-cutover-state.ts" begin')).toBeLessThan(script.indexOf('systemctl stop "$SERVICE"'));
    expect(script.indexOf('systemctl stop "$SERVICE"')).toBeLessThan(script.indexOf('"${migration_command[@]}" | tee "$first_report"'));
    expect(script.indexOf('"${migration_command[@]}" | tee "$first_report"')).toBeLessThan(script.indexOf('"${migration_command[@]}" | tee "$second_report"'));
    expect(script.indexOf('project-scaffold-cutover-state.ts" canvas-required')).toBeLessThan(script.indexOf("  deploy"));
    expect(script.indexOf("  deploy")).toBeLessThan(script.indexOf('project-scaffold-cutover-state.ts" complete'));
    expect(script).toContain(".migration.counts.migrated == 0");
    expect(script).toContain(".migration.exceptionsAccepted");
    expect(script).toContain(".registryUnchanged");
    expect(script).toContain(".git.ok");
  });

  test("publishes online only after a required startup Canvas refresh succeeds", () => {
    const source = readFileSync(join(repo, "bot/src/index.ts"), "utf8");
    const refresh = source.indexOf('await rerenderAllCanvases("startup", requireCanvasRefresh)');
    const start = source.indexOf("await app.start()", refresh);
    const online = source.indexOf('log("info", "concierge_bot_online"', start);
    expect(refresh).toBeGreaterThan(0);
    expect(refresh).toBeLessThan(start);
    expect(start).toBeLessThan(online);
  });

  test("checks durable cutover state before abandoned drain recovery", () => {
    const source = readFileSync(join(repo, "bot/src/index.ts"), "utf8");
    const decision = source.indexOf("const projectCutoverStartup = startupCutoverDecision");
    const refusal = source.indexOf("if (!projectCutoverStartup.allowStartup)", decision);
    const clear = source.indexOf("clearAbandonedDrain(isProcessIdentityAlive)", refusal);
    expect(decision).toBeGreaterThan(0);
    expect(decision).toBeLessThan(refusal);
    expect(refusal).toBeLessThan(clear);
    expect(source).toContain("if (!projectCutoverStartup.preserveDrain) clearAbandonedDrain");
  });

  test("preserves existing admission gates on cutover failure", () => {
    const deploy = readFileSync(join(repo, "bot/scripts/deploy.sh"), "utf8");
    const cleanup = deploy.slice(
      deploy.indexOf("cleanup_failed_deployment()"),
      deploy.indexOf("block_new_capture_connections()"),
    );
    expect(cleanup).toContain('PRESERVE_GATES_ON_FAILURE" = "1"');
    expect(cleanup.indexOf('PRESERVE_GATES_ON_FAILURE" = "1"')).toBeLessThan(cleanup.indexOf("release_turn_gate"));
    expect(cleanup).toContain("Admission gates remain held");
  });
});
