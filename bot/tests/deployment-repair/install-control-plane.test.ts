import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const installer = join(repositoryRoot, "bot/scripts/deployment-repair/install-control-plane.ts");
const scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function sha256(contents: string | Uint8Array) {
  return createHash("sha256").update(contents).digest("hex");
}

function runInstaller(
  runtimeRoot: string,
  candidate: string,
  options: { approved?: boolean; promotionDigest?: string } = {},
) {
  return Bun.spawnSync({
    cmd: [process.execPath, "run", installer],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CONCIERGE_CONTROL_INSTALL_ALLOW_NON_ROOT: "1",
      CONCIERGE_DEPLOYMENT_RUNTIME_DIR: runtimeRoot,
      CONCIERGE_CODEX_BIN: candidate,
      CONCIERGE_APPROVE_CONTROL_PLANE_UPDATE: options.approved ? "1" : "0",
      CONCIERGE_PROMOTE_CONTROL_PLANE_CODEX_SHA256: options.promotionDigest || "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function installerOutput(result: ReturnType<typeof runInstaller>) {
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return JSON.parse(result.stdout.toString()) as Record<string, unknown>;
}

describe("protected control-plane Codex promotion", () => {
  test("ordinary deploys reuse the pinned runtime while explicit approval promotes a new candidate", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "concierge-control-codex-"));
    scratch.push(fixtureRoot);
    const runtimeRoot = join(fixtureRoot, "runtime");
    const candidate = join(fixtureRoot, "codex-candidate");
    const installedCodex = join(runtimeRoot, "codex");

    writeFileSync(candidate, "#!/bin/sh\necho codex-one\n");
    chmodSync(candidate, 0o755);
    const bootstrap = installerOutput(runInstaller(runtimeRoot, candidate));
    const bootstrapVersion = String(bootstrap.kernel_version);
    expect(bootstrap.codex_source).toBe("bootstrap_candidate");
    expect(bootstrap.codex_changed).toBe(true);
    expect(readFileSync(installedCodex, "utf8")).toContain("codex-one");

    writeFileSync(candidate, "#!/bin/sh\necho codex-two\n");
    const ordinary = installerOutput(runInstaller(runtimeRoot, candidate));
    expect(ordinary.codex_source).toBe("installed");
    expect(ordinary.codex_changed).toBe(false);
    expect(ordinary.kernel_changed).toBe(false);
    expect(ordinary.kernel_version).toBe(bootstrapVersion);
    expect(readFileSync(installedCodex, "utf8")).toContain("codex-one");

    const approvedControlChange = installerOutput(runInstaller(runtimeRoot, candidate, { approved: true }));
    expect(approvedControlChange.codex_source).toBe("installed");
    expect(approvedControlChange.kernel_version).toBe(bootstrapVersion);
    expect(readFileSync(installedCodex, "utf8")).toContain("codex-one");

    const candidateDigest = sha256(readFileSync(candidate));
    const promotion = installerOutput(runInstaller(runtimeRoot, candidate, {
      approved: true,
      promotionDigest: candidateDigest,
    }));
    const promotedVersion = String(promotion.kernel_version);
    expect(promotion.codex_source).toBe("promotion_candidate");
    expect(promotion.codex_changed).toBe(true);
    expect(promotion.kernel_changed).toBe(true);
    expect(promotedVersion).not.toBe(bootstrapVersion);
    expect(readFileSync(installedCodex, "utf8")).toContain("codex-two");
    const manifest = JSON.parse(readFileSync(join(runtimeRoot, "kernel", promotedVersion, "manifest.json"), "utf8"));
    expect(manifest.codex_sha256).toBe(sha256(readFileSync(installedCodex)));

    writeFileSync(candidate, "#!/bin/sh\necho codex-three\n");
    const afterGlobalUpdate = installerOutput(runInstaller(runtimeRoot, candidate));
    expect(afterGlobalUpdate.codex_source).toBe("installed");
    expect(afterGlobalUpdate.kernel_version).toBe(promotedVersion);
    expect(afterGlobalUpdate.kernel_changed).toBe(false);
    expect(readFileSync(installedCodex, "utf8")).toContain("codex-two");

    const unauthorizedPromotion = runInstaller(runtimeRoot, candidate, {
      promotionDigest: sha256(readFileSync(candidate)),
    });
    expect(unauthorizedPromotion.exitCode).toBe(1);
    expect(unauthorizedPromotion.stderr.toString()).toContain("Codex promotion requires");

    const mismatchedPromotion = runInstaller(runtimeRoot, candidate, {
      approved: true,
      promotionDigest: "0".repeat(64),
    });
    expect(mismatchedPromotion.exitCode).toBe(1);
    expect(mismatchedPromotion.stderr.toString()).toContain("does not match approved digest");

    writeFileSync(installedCodex, "#!/bin/sh\necho tampered\n");
    const tampered = runInstaller(runtimeRoot, candidate);
    expect(tampered.exitCode).toBe(1);
    expect(tampered.stderr.toString()).toContain("Protected control-plane source changed");
  }, 30_000);
});
