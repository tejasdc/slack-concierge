#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";
import { deploymentLedgerMode } from "../src/deployment-launch-authority";
import { observeInterruptedDeploymentRecovery, repairLedgerCommand, repairLedgerOwnerCommand } from "../src/deployment-repair-client";
import { notifyDeploymentWorker } from "../src/deployment-worker-wake";

const repositoryRoot = process.env.CONCIERGE_REPO || "/var/lib/slack-concierge-deployment/source";
type RecoverySnapshot = Awaited<ReturnType<typeof observeInterruptedDeploymentRecovery>>;
type RecoveryDependencies = {
  mode?: typeof deploymentLedgerMode;
  observe?: () => Promise<RecoverySnapshot>;
  legacyObserve?: () => Promise<RecoverySnapshot>;
  restore?: (artifactPath: string) => Promise<{ git_commit: string }>;
  begin?: (input: Record<string, unknown>, commandId: string) => Promise<any>;
  notify?: typeof notifyDeploymentWorker;
  output?: (line: string) => void;
};

/** Keep the served path constructor-free while preserving boot-time offline recovery. */
export async function recoverInterruptedDeployments(dependencies: RecoveryDependencies = {}): Promise<void> {
  const mode = await (dependencies.mode ?? deploymentLedgerMode)();
  // The selected serving owner supplies one consistent run/LKG snapshot and accepts the
  // idempotent failure event. This branch does not import the canonical database module.
  const recovery = mode === "owner"
    ? await (dependencies.observe ?? observeInterruptedDeploymentRecovery)()
    : await (dependencies.legacyObserve ?? (async () => {
        const state = await import("../src/deployment-state");
        const { isProcessIdentityAlive } = await import("../src/runtime-identity");
        return {
          runs: state.listDeadCandidateDeploymentRuns(isProcessIdentityAlive),
          lastKnownGood: state.getLastKnownGoodRelease(),
        };
      }))();
  for (const run of recovery.runs) {
    const lkg = recovery.lastKnownGood;
    if (!lkg) throw new Error(`Cannot recover deployment ${run.id}: no immutable last-known-good release exists.`);
    const restored = await (dependencies.restore ?? (async artifactPath => {
      const { defaultReleaseEnvironment, TrustedRootReleaseManager } = await import("../src/deployment-release");
      return new TrustedRootReleaseManager(defaultReleaseEnvironment(repositoryRoot)).restore(artifactPath);
    }))(lkg.artifact_path);
    const classification = ["deployment-runner-interrupted", run.status, run.activation_state].join(":");
    const fingerprint = createHash("sha256").update(classification).digest("hex");
    // One ID belongs to this accepted attempt. Transport retries reuse it; a later attempt
    // receives a new ID. Restore already completed, so a lost reply retries only this command.
    const commandId=randomUUID();
    const input={
      runId: run.id,
      failedCommit: run.candidate_commit!,
      restoredCommit: restored.git_commit,
      failureFingerprint: fingerprint,
      error: `Deployment runner disappeared in ${run.status} after candidate activation ${run.activation_state}; immutable LKG ${restored.git_commit} was restored before Concierge startup.`,
    };
    const ownerCommand = mode === "owner" ? repairLedgerOwnerCommand : repairLedgerCommand;
    const incident = await (dependencies.begin
      ? dependencies.begin(input,commandId)
      : ownerCommand("beginDeploymentRepair",[input],{commandId}));
    await (dependencies.notify ?? notifyDeploymentWorker)();
    (dependencies.output ?? console.log)(JSON.stringify({
      status: incident.status,
      run_id: run.id,
      incident_id: incident.id,
      restored_commit: restored.git_commit,
    }));
  }
  if (recovery.runs.length === 0) (dependencies.output ?? console.log)(JSON.stringify({ status: "clean" }));
}

if (import.meta.main) await recoverInterruptedDeployments();
