#!/usr/bin/env bun

import { realpathSync } from "node:fs";
import { join } from "node:path";
import { defaultReleaseEnvironment, TrustedRootReleaseManager } from "../src/deployment-release";
import { ledgerAccess } from "../src/ledger-access-policy";
import { deploymentReactionTokensForCommitRange } from "../src/deployment-reaction-tokens";
import { notifyDeploymentWorker } from "../src/deployment-worker-wake";

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

async function ownerReleaseMutation(operation: string, input: Record<string, unknown>): Promise<any> {
  const stateDir=process.env.CONCIERGE_STATE_DIR;
  if(!stateDir)throw new Error('CONCIERGE_STATE_DIR is required for release state.');
  const response=await fetch('http://localhost/internal/deployment-release',{
    unix:join(stateDir,'request-owner.sock'),method:'POST',
    headers:{'content-type':'application/json'},body:JSON.stringify({operation,...input}),
  } as RequestInit);
  const result=await response.json();
  if(!response.ok)throw new Error(`Serving owner refused ${operation}: ${JSON.stringify(result)}`);
  return result;
}

try {
  const command = process.argv[2];
  // File-only commands and owner-served commands must not open SQLite at all. A read-only
  // short-lived connection still took WAL writer/checkpoint locks during live updates.
  const stateDir=process.env.CONCIERGE_STATE_DIR;
  const ownerServedReleaseCommand=stateDir
    ? ledgerAccess(realpathSync(stateDir),Bun.main,false).ownerServedReleaseCommand
    : false;
  const directStateRequired=!ownerServedReleaseCommand
    && ['prepare','activate','restore-lkg','promote','lkg'].includes(command??'');
  const state=directStateRequired
    ? await import('../src/deployment-state')
    : {} as typeof import('../src/deployment-state');
  const {getLastKnownGoodRelease,promoteDeploymentRelease,
    recordDeploymentTurnReactionDiscoveryFailure,recordDeploymentReleaseActivationIntent,
    recordDeploymentReleaseActivated,recordDeploymentReleasePrepared,
    registerDeploymentTurnReactionTargets}=state;
  const releaseMutation=<T>(operation:string,input:Record<string,unknown>,direct:()=>T):Promise<T> =>
    ownerServedReleaseCommand ? ownerReleaseMutation(operation,input) : Promise.resolve(direct());
  const lastKnownGoodRelease=async ():Promise<ReturnType<typeof getLastKnownGoodRelease>> => {
    if (!ownerServedReleaseCommand) return getLastKnownGoodRelease();
    if(!stateDir)throw new Error('CONCIERGE_STATE_DIR is required for release state.');
    const response=await fetch('http://localhost/internal/deployment-last-known-good',{
      unix:join(stateDir,'request-owner.sock'),method:'GET',
    } as RequestInit);
    const result=await response.json();
    if(!response.ok)throw new Error(`Serving owner refused last-known-good read: ${JSON.stringify(result)}`);
    return result;
  };
  const repositoryRoot = process.env.CONCIERGE_REPO || "/var/lib/slack-concierge-deployment/source";
  const sourceRoot = process.env.CONCIERGE_DEPLOYMENT_SOURCE_ROOT || repositoryRoot;
  const controlRoot = process.env.CONCIERGE_DEPLOYMENT_CONTROL_ROOT;
  const manager = new TrustedRootReleaseManager(defaultReleaseEnvironment(repositoryRoot));
  if (command?.startsWith("recovery-")) {
    const {handleControlRecovery}=await import('../src/deployment-control-recovery');
    finish(0, await handleControlRecovery(command, option, manager));
  }
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
    await releaseMutation('prepared',{runId,artifactPath:prepared.artifactPath,manifest:prepared.manifest},
      () => recordDeploymentReleasePrepared(runId,prepared.artifactPath,prepared.manifest));
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
    const lastKnownGood = await timedAsync("read_last_known_good", lastKnownGoodRelease);
    const intent = await timedAsync("record_intent", () => releaseMutation('activation-intent',{runId,artifactDigest:release.artifact_digest,allowSupersede:process.argv.includes("--allow-supersede")},
      () => recordDeploymentReleaseActivationIntent(runId,release.artifact_digest,process.argv.includes("--allow-supersede"))));
    if ("supersededCommit" in intent) {
      report();
      finish(0, { status: "superseded", desired_commit: intent.supersededCommit });
    }
    if (lastKnownGood) {
      try {
        const tokens = await timedAsync("scan_reaction_targets", () => deploymentReactionTokensForCommitRange(repositoryRoot, lastKnownGood.git_commit, release.git_commit));
        const targets = await timedAsync("resolve_reaction_targets", async () => ownerServedReleaseCommand
          ? await ownerReleaseMutation('resolve-reaction-tokens',{runId,tokens})
          : (await import('../src/deployment-reaction-provenance')).resolveDeploymentReactionTargets(tokens));
        await timedAsync("register_reaction_targets", () => releaseMutation('reaction-targets',{runId,targets},
          () => registerDeploymentTurnReactionTargets(runId,targets,"deploying")));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await releaseMutation('reaction-discovery-failed',{runId,message},
          () => recordDeploymentTurnReactionDiscoveryFailure(runId,message));
        console.error(JSON.stringify({ event: "deployment_turn_reaction_discovery_failed", run_id: runId, error: message }));
      }
    }
    const manifest = timed("activate_files", () => manager.activate(artifact));
    await timedAsync("record_activated", () => releaseMutation('activated',{runId,artifactDigest:manifest.artifact_digest},
      () => recordDeploymentReleaseActivated(runId,manifest.artifact_digest)));
    notifyDeploymentWorker();
    report();
    finish(0, { status: "activated", ...manifest });
  }
  if (command === "restore-lkg") {
    const release = await lastKnownGoodRelease();
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
    const promoted = await releaseMutation('promote',{runId,artifactDigest},
      () => promoteDeploymentRelease(runId,artifactDigest));
    manager.activateControl(required("--artifact"));
    finish(0, { status: "promoted", artifact_digest: promoted.artifact_digest, git_commit: promoted.git_commit });
  }
  if (command === "current") {
    const artifactPath = manager.currentArtifactPath();
    if (!artifactPath) finish(1, { status: "missing" });
    finish(0, { status: "current", artifact_path: artifactPath, ...manager.verify(artifactPath) });
  }
  if (command === "lkg") {
    const release = await lastKnownGoodRelease();
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
