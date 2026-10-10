#!/usr/bin/env bun

import { join } from "node:path";
import { defaultReleaseEnvironment, TrustedRootReleaseManager } from "../src/deployment-release";
import {
  getLastKnownGoodRelease,
  promoteDeploymentRelease,
  recordDeploymentTurnReactionDiscoveryFailure,
  recordDeploymentReleaseActivationIntent,
  recordDeploymentReleaseActivated,
  recordDeploymentReleasePrepared,
  registerDeploymentTurnReactionTargets,
} from "../src/deployment-state";
import { deploymentReactionTargetsForCommitRange } from "../src/deployment-reaction-provenance";
import { notifyDeploymentWorker } from "../src/deployment-worker-wake";
import { handleControlRecovery } from "../src/deployment-control-recovery";

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
  const repositoryRoot = process.env.CONCIERGE_REPO || "/var/lib/slack-concierge-deployment/source";
  const sourceRoot = process.env.CONCIERGE_DEPLOYMENT_SOURCE_ROOT || repositoryRoot;
  const controlRoot = process.env.CONCIERGE_DEPLOYMENT_CONTROL_ROOT;
  const manager = new TrustedRootReleaseManager(defaultReleaseEnvironment(repositoryRoot));
  const command = process.argv[2];
  if (command?.startsWith("recovery-")) finish(0, await handleControlRecovery(command, option, manager));
  if (command === "install-runtime") {
    manager.installRuntime(
      controlRoot ? join(controlRoot, "deployment-launcher.sh") : join(sourceRoot, "bot/scripts/deployment-launcher.sh"),
      controlRoot ? join(controlRoot, "deployment-control-launcher.sh") : join(sourceRoot, "bot/scripts/deployment-control-launcher.sh"),
    );
    finish(0, { status: "installed", install_root: manager.environment.installRoot });
  }
  if (command === "prepare") {
    const runId = required("--run-id");
    const applicationCommit = required("--commit").toLowerCase();
    const prepared = await manager.prepare(
      runId,
      applicationCommit,
      (option("--control-commit") || applicationCommit).toLowerCase(),
    );
    recordDeploymentReleasePrepared(runId, prepared.artifactPath, prepared.manifest);
    finish(0, { status: "prepared", artifact_path: prepared.artifactPath, ...prepared.manifest });
  }
  if (command === "activate") {
    const runId = required("--run-id");
    const artifact = required("--artifact");
    // Each step is timed: on 2026-10-08 at 19:17 something in this command held the ledger's writer
    // lock for at least 10 s while the old owner was serving, and the owner's writes and heartbeat
    // failed. The step that holds it is named in the log the next time it happens.
    const steps: Record<string, number> = {};
    const timed = <T>(name: string, work: () => T): T => { const start = performance.now(); try { return work(); } finally { steps[name] = Math.round(performance.now() - start); } };
    const timedAsync = async <T>(name: string, work: () => Promise<T>): Promise<T> => { const start = performance.now(); try { return await work(); } finally { steps[name] = Math.round(performance.now() - start); } };
    const report = () => console.error(JSON.stringify({ event: "deployment_activate_steps", run_id: runId, steps_ms: steps }));
    const release = timed("verify", () => manager.verify(artifact));
    const lastKnownGood = timed("read_last_known_good", () => getLastKnownGoodRelease());
    const intent = timed("record_intent", () => recordDeploymentReleaseActivationIntent(runId, release.artifact_digest, process.argv.includes("--allow-supersede")));
    if ("supersededCommit" in intent) {
      report();
      finish(0, { status: "superseded", desired_commit: intent.supersededCommit });
    }
    if (lastKnownGood) {
      try {
        const targets = await timedAsync("scan_reaction_targets", () => deploymentReactionTargetsForCommitRange(repositoryRoot, lastKnownGood.git_commit, release.git_commit));
        timed("register_reaction_targets", () => registerDeploymentTurnReactionTargets(runId, targets, "deploying"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        recordDeploymentTurnReactionDiscoveryFailure(runId, message);
        console.error(JSON.stringify({ event: "deployment_turn_reaction_discovery_failed", run_id: runId, error: message }));
      }
    }
    const manifest = timed("activate_files", () => manager.activate(artifact));
    timed("record_activated", () => recordDeploymentReleaseActivated(runId, manifest.artifact_digest));
    notifyDeploymentWorker();
    report();
    finish(0, { status: "activated", ...manifest });
  }
  if (command === "restore-lkg") {
    const release = getLastKnownGoodRelease();
    if (!release) throw new Error("No last-known-good release has been recorded.");
    if (process.argv.includes('--keep-control') && !manager.controlArtifactPath())
      throw new Error('Cannot retain a missing deployment controller.');
    const manifest = process.argv.includes('--keep-control')
      ? manager.activate(release.artifact_path) : manager.restore(release.artifact_path);
    finish(0, { status: "restored", artifact_path: release.artifact_path, ...manifest });
  }
  if (command === "promote") {
    const runId = required("--run-id");
    const artifactDigest = required("--artifact-digest");
    const release = manager.verify(required("--artifact"));
    if (release.artifact_digest !== artifactDigest) throw new Error("Promoted artifact path and digest disagree.");
    const promoted = promoteDeploymentRelease(runId, artifactDigest);
    manager.activateControl(required("--artifact"));
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
