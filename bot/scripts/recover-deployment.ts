#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { defaultReleaseEnvironment, TrustedRootReleaseManager } from "../src/deployment-release";
import {
  beginDeploymentRepair,
  getLastKnownGoodRelease,
  listDeadCandidateDeploymentRuns,
} from "../src/deployment-state";
import { isProcessIdentityAlive } from "../src/runtime-identity";

const repositoryRoot = process.env.CONCIERGE_REPO || "/root/workspace/slack-concierge";
const manager = new TrustedRootReleaseManager(defaultReleaseEnvironment(repositoryRoot));
const interrupted = listDeadCandidateDeploymentRuns(isProcessIdentityAlive);

for (const run of interrupted) {
  const lkg = getLastKnownGoodRelease();
  if (!lkg) throw new Error(`Cannot recover deployment ${run.id}: no immutable last-known-good release exists.`);
  const restored = manager.restore(lkg.artifact_path);
  const classification = [
    "deployment-runner-interrupted",
    run.status,
    run.activation_state,
  ].join(":");
  const fingerprint = createHash("sha256").update(classification).digest("hex");
  const incident = beginDeploymentRepair({
    runId: run.id,
    failedCommit: run.candidate_commit!,
    restoredCommit: restored.git_commit,
    failureFingerprint: fingerprint,
    error: `Deployment runner disappeared in ${run.status} after candidate activation ${run.activation_state}; immutable LKG ${restored.git_commit} was restored before Concierge startup.`,
  });
  console.log(JSON.stringify({
    status: incident.status,
    run_id: run.id,
    incident_id: incident.id,
    restored_commit: restored.git_commit,
  }));
}

if (interrupted.length === 0) console.log(JSON.stringify({ status: "clean" }));
