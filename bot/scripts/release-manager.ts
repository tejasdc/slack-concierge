#!/usr/bin/env bun

import { join } from "node:path";
import { defaultReleaseEnvironment, TrustedRootReleaseManager } from "../src/deployment-release";
import {
  getLastKnownGoodRelease,
  promoteDeploymentRelease,
  recordDeploymentReleaseActivationIntent,
  recordDeploymentReleaseActivated,
  recordDeploymentReleasePrepared,
} from "../src/deployment-state";

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || null : null;
}

function required(name: string) {
  const value = option(name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function finish(code: number, payload: Record<string, unknown>): never {
  console.log(JSON.stringify(payload));
  process.exit(code);
}

try {
  const repositoryRoot = process.env.CONCIERGE_REPO || "/root/workspace/slack-concierge";
  const sourceRoot = process.env.CONCIERGE_DEPLOYMENT_SOURCE_ROOT || repositoryRoot;
  const controlRoot = process.env.CONCIERGE_DEPLOYMENT_CONTROL_ROOT;
  const manager = new TrustedRootReleaseManager(defaultReleaseEnvironment(repositoryRoot));
  const command = process.argv[2];
  if (command === "install-runtime") {
    manager.installRuntime(
      controlRoot ? join(controlRoot, "deployment-launcher.sh") : join(sourceRoot, "bot/scripts/deployment-launcher.sh"),
      controlRoot ? join(controlRoot, "deployment-control-launcher.sh") : join(sourceRoot, "bot/scripts/deployment-control-launcher.sh"),
    );
    finish(0, { status: "installed", install_root: manager.environment.installRoot });
  }
  if (command === "prepare") {
    const runId = required("--run-id");
    const prepared = await manager.prepare(runId, required("--commit").toLowerCase());
    recordDeploymentReleasePrepared(runId, prepared.artifactPath, prepared.manifest);
    finish(0, { status: "prepared", artifact_path: prepared.artifactPath, ...prepared.manifest });
  }
  if (command === "activate") {
    const runId = required("--run-id");
    const artifact = required("--artifact");
    const release = manager.verify(artifact);
    recordDeploymentReleaseActivationIntent(runId, release.artifact_digest);
    const manifest = manager.activate(artifact);
    recordDeploymentReleaseActivated(runId, manifest.artifact_digest);
    finish(0, { status: "activated", ...manifest });
  }
  if (command === "restore-lkg") {
    const release = getLastKnownGoodRelease();
    if (!release) throw new Error("No last-known-good release has been recorded.");
    const manifest = manager.activate(release.artifact_path);
    finish(0, { status: "restored", artifact_path: release.artifact_path, ...manifest });
  }
  if (command === "promote") {
    const runId = required("--run-id");
    const artifactDigest = required("--artifact-digest");
    const release = manager.verify(required("--artifact"));
    if (release.artifact_digest !== artifactDigest) throw new Error("Promoted artifact path and digest disagree.");
    manager.activateControl(required("--artifact"));
    const promoted = promoteDeploymentRelease(runId, artifactDigest);
    finish(0, { status: "promoted", artifact_digest: promoted.artifact_digest, git_commit: promoted.git_commit });
  }
  if (command === "current") {
    const artifactPath = manager.currentArtifactPath();
    if (!artifactPath) finish(1, { status: "missing" });
    finish(0, { status: "current", artifact_path: artifactPath, ...manager.verify(artifactPath) });
  }
  if (command === "lkg") {
    const release = getLastKnownGoodRelease();
    if (!release) finish(1, { status: "missing" });
    const manifest = manager.verify(release.artifact_path);
    finish(0, { status: "lkg", artifact_path: release.artifact_path, ...manifest });
  }
  if (command === "set-control") {
    const manifest = manager.activateControl(required("--artifact"));
    finish(0, { status: "control-activated", ...manifest });
  }
  throw new Error("usage: release-manager.ts <install-runtime|prepare|activate|restore-lkg|promote|set-control|current|lkg>");
} catch (error) {
  finish(1, { status: "error", error: error instanceof Error ? error.message : String(error) });
}
