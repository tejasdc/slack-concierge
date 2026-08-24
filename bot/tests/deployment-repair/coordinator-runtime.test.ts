import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordinatorRuntimeManager } from "../../../deployment-control/kernel/coordinator-runtime";

describe("installed coordinator runtime catalog", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test("derives the exact inactive candidate from root-owned catalog state", () => {
    const root = mkdtempSync(join(tmpdir(), "concierge-coordinator-runtime-"));
    roots.push(root);
    const bundle = Buffer.from("candidate bundle\n");
    const version = createHash("sha256").update(bundle).digest("hex");
    const coordinatorRoot = join(root, "coordinator");
    const versionRoot = join(coordinatorRoot, version);
    mkdirSync(join(coordinatorRoot, "slots"), { recursive: true });
    mkdirSync(versionRoot);
    writeFileSync(join(versionRoot, "coordinator.js"), bundle);
    writeFileSync(join(versionRoot, "manifest.json"), JSON.stringify({
      version,
      coordinator_bundle_sha256: version,
    }));
    symlinkSync(`../${version}`, join(coordinatorRoot, "slots/b"));
    writeFileSync(join(coordinatorRoot, "catalog.json"), JSON.stringify({
      schema_version: 1,
      candidate_slot: "b",
      candidate_version: version,
      legacy_version: version,
      slots: { b: version },
    }), { mode: 0o644 });
    const manager = new CoordinatorRuntimeManager({
      runtimeRoot: root,
      activeRecordPath: join(root, "active.json"),
      systemctlBin: "/unused/systemctl",
      run: () => ({
        exitCode: 0,
        stdout: "InvocationID=\nMainPID=0\nActiveState=inactive\n",
        stderr: "",
      }),
    });

    expect(manager.stagedCandidate()).toEqual({
      slot: "b",
      version,
      unit: "concierge-deployment-coordinator@b.service",
      invocationId: "",
      mainPid: 0,
      active: false,
    });
  });
});
