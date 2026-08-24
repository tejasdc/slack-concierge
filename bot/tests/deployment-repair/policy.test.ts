import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  digestProtectedKernel,
  evaluateRepairDiff,
  loadRepairPolicy,
} from "../../../deployment-control/kernel/policy";

const repositoryRoot = join(import.meta.dir, "../../..");
const policyPath = join(repositoryRoot, "config/deployment-repair-policy.toml");

describe("deployment repair policy", () => {
  test("accepts only a repair-owned source, focused test, and current-state document", () => {
    const { policy, digest } = loadRepairPolicy(policyPath);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(evaluateRepairDiff(policy, [
      "bot/src/deployment-worker.ts",
      "bot/tests/deployment-state.test.ts",
      "docs/architecture/DEPLOYMENT-REPAIR.md",
    ], 4096)).toMatchObject({ accepted: true, rejected: [] });
  });

  test("rejects policy, kernel, fallback deploy, provider, and unrelated feature changes", () => {
    const { policy } = loadRepairPolicy(policyPath);
    const evaluation = evaluateRepairDiff(policy, [
      "config/deployment-repair-policy.toml",
      "deployment-control/kernel/state.ts",
      "bot/scripts/deploy.sh",
      "bot/src/providers.ts",
      "bot/src/index.ts",
      "systemd/concierge-bot.service",
    ], 4096);
    expect(evaluation.accepted).toBeFalse();
    expect(evaluation.rejected.map((finding) => finding.path)).toEqual([
      "bot/scripts/deploy.sh",
      "bot/src/index.ts",
      "bot/src/providers.ts",
      "config/deployment-repair-policy.toml",
      "deployment-control/kernel/state.ts",
      "systemd/concierge-bot.service",
    ]);
  });

  test("source changes fail without both a focused test and current-state documentation", () => {
    const { policy } = loadRepairPolicy(policyPath);
    const evaluation = evaluateRepairDiff(policy, ["bot/src/deployment-state.ts"], 100);
    expect(evaluation.accepted).toBeFalse();
    expect(evaluation.rejected.map((finding) => finding.reason)).toContain(
      "source changes require an allowed focused test",
    );
    expect(evaluation.rejected.map((finding) => finding.reason)).toContain(
      "source changes require current-state deployment documentation",
    );
  });

  test("rejects escaping paths, oversized diffs, and enforcement trees with symlinks", () => {
    const { policy } = loadRepairPolicy(policyPath);
    expect(() => evaluateRepairDiff(policy, ["../AGENTS.md"], 1)).toThrow("escapes");
    expect(evaluateRepairDiff(policy, [], policy.limits.maximum_patch_bytes + 1).accepted).toBeFalse();
    expect(digestProtectedKernel(join(repositoryRoot, "deployment-control/kernel"))).toMatch(/^[0-9a-f]{64}$/);
  });
});
