import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync, renameSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { TrustedRootReleaseManager } from "./deployment-release";
import { claimControlRecovery, controlRecoveryEvent, failControlRecovery, getControlRecoveryIntent,
  getDeploymentRepairIncident, getDeploymentRun, getLastKnownGoodRelease, prepareControlRecovery,
  recordControlRecoveryEvent, recordDeploymentReleasePrepared } from "./deployment-state";
import { isAncestorProcess, processIdentity } from "./runtime-identity";
import { notifyDeploymentWorker } from "./deployment-worker-wake";

export type RecoveryCommand = (command: string[], cwd?: string) => string;
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

export function recoveryCommand(command: string[], cwd?: string) {
  const result = Bun.spawnSync({ cmd: command, cwd, env: { ...process.env, HOME: "/root", GIT_TERMINAL_PROMPT: "0" },
    stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${command[0]} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString().trim();
}

function properties(text: string) {
  return Object.fromEntries(text.split("\n").map(line => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1)];
  }));
}

export function assertRepairUnitStopped(incidentId: string, command: RecoveryCommand = recoveryCommand) {
  const unit = `concierge-deployment-repair@${incidentId}.service`;
  const state = properties(command(["systemctl", "show", unit,
    "--property=MainPID", "--property=ActiveState", "--property=ControlGroup"]));
  if (state.MainPID !== "0" || !["inactive", "failed"].includes(state.ActiveState)) {
    throw new Error(`Stop ${unit} before controller recovery; the prior unit is still active.`);
  }
  const visit = (directory: string): void => {
    if (readFileSync(join(directory, "cgroup.procs"), "utf8").trim()) throw new Error("Prior repair cgroup still has processes.");
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(join(directory, entry.name));
    }
  };
  if (state.ControlGroup) {
    const directory = resolve("/sys/fs/cgroup", `.${state.ControlGroup}`);
    if (!directory.startsWith("/sys/fs/cgroup/")) throw new Error("Invalid repair cgroup identity.");
    if (existsSync(directory)) visit(directory);
  }
  return { unit, main_pid: 0, cgroup: state.ControlGroup || null, quiescent: true };
}

export function containControlRecovery(runId: string, manager: TrustedRootReleaseManager,
  systemdDirectory = "/etc/systemd/system", command: RecoveryCommand = recoveryCommand) {
  const intent = getControlRecoveryIntent(runId);
  if (!intent) throw new Error("Unknown controller recovery.");
  manager.verify(intent.artifactPath);
  const proof = assertRepairUnitStopped(intent.incidentId, command);
  const path = join(systemdDirectory, "concierge-deployment-repair@.service");
  const prior = controlRecoveryEvent(runId, "control_recovery_mask_intended");
  const file = lstatSync(path);
  if (file.isSymbolicLink()) {
    if (readlinkSync(path) !== "/dev/null") throw new Error("Unexpected repair-unit symlink.");
    if (!prior) recordControlRecoveryEvent(runId, "control_recovery_mask_intended", { ...proof, owned: false, path });
  } else {
    if (!file.isFile()) throw new Error("Repair unit is not a regular file.");
    const lkg = getLastKnownGoodRelease();
    if (!lkg) throw new Error("No healthy release exists.");
    const manifest = manager.verify(lkg.artifact_path);
    const digest = hash(readFileSync(path));
    const reviewed = manager.verify(intent.artifactPath);
    const priorArtifact = digest === manifest.files["control/systemd/concierge-deployment-repair@.service"]
      ? lkg.artifact_path : digest === reviewed.files["control/systemd/concierge-deployment-repair@.service"]
        ? intent.artifactPath : null;
    if (!priorArtifact) {
      throw new Error("Installed repair unit differs from the proven release; refusing to replace it.");
    }
    recordControlRecoveryEvent(runId, "control_recovery_mask_intended", {
      ...proof, owned: true, path, prior_artifact: priorArtifact, prior_digest: digest,
    });
    const temporary = `${path}.${randomUUID()}.mask`;
    symlinkSync("/dev/null", temporary);
    renameSync(temporary, path);
  }
  command(["systemctl", "daemon-reload"]);
  recordControlRecoveryEvent(runId, "control_recovery_contained", proof);
  return proof;
}

export async function handleControlRecovery(commandName: string, option: (name: string) => string | null,
  manager: TrustedRootReleaseManager, command: RecoveryCommand = recoveryCommand): Promise<Record<string, unknown>> {
  const required = (name: string) => { const value = option(name); if (!value) throw new Error(`${name} is required.`); return value; };
  if (commandName === "recovery-start") {
    let runId = option("--run-id");
    if (!runId) {
      const sourceRoot = resolve(required("--source-root"));
      const controlCommit = required("--control-commit");
      command(["git", "fetch", "origin", "main"], sourceRoot);
      if (command(["git", "status", "--porcelain", "--untracked-files=normal"], sourceRoot)
        || command(["git", "rev-parse", "HEAD"], sourceRoot) !== controlCommit
        || command(["git", "rev-parse", "origin/main"], sourceRoot) !== controlCommit) {
        throw new Error("Controller recovery requires a clean source checkout at the exact integrated reviewed revision.");
      }
      const reviewPath = required("--review-evidence");
      if (!lstatSync(reviewPath).isFile() || lstatSync(reviewPath).isSymbolicLink()) throw new Error("Review evidence must be a regular file.");
      const reviewBytes = readFileSync(reviewPath);
      const review = JSON.parse(reviewBytes.toString());
      if (review.verdict !== "SHIP" || review.reviewed_commit !== controlCommit) {
        throw new Error("Controller recovery requires SHIP evidence for its exact revision.");
      }
      const incidentId = required("--incident-id");
      if (!getDeploymentRepairIncident(incidentId)) throw new Error("Unknown repair incident.");
      assertRepairUnitStopped(incidentId, command);
      const lkg = getLastKnownGoodRelease();
      if (!lkg) throw new Error("No healthy application release is recorded.");
      manager.verify(lkg.artifact_path);
      runId = randomUUID();
      const artifact = await manager.prepare(runId, lkg.git_commit, controlCommit);
      prepareControlRecovery({ runId, incidentId, controlCommit, healthyCommit: lkg.git_commit,
        artifactPath: artifact.artifactPath, artifactDigest: artifact.manifest.artifact_digest,
        sourceTreeDigest: command(["git", "rev-parse", "HEAD^{tree}"], sourceRoot), reviewDigest: hash(reviewBytes) });
    }
    const intent = getControlRecoveryIntent(runId);
    if (!intent) throw new Error("Unknown controller recovery.");
    const manifest = manager.verify(intent.artifactPath);
    if (manifest.artifact_digest !== intent.artifactDigest || manifest.control_git_commit !== intent.controlCommit
      || manifest.git_commit !== intent.healthyCommit) throw new Error("Recovery artifact does not match durable intent.");
    if (getDeploymentRun(runId)?.status === "succeeded") return { status: "succeeded", run_id: runId };
    const unit = `concierge-control-recovery-${runId.slice(0, 12)}`;
    recordControlRecoveryEvent(runId, "control_recovery_launch_intended", { unit, artifact_digest: intent.artifactDigest });
    command(["systemd-run", "--unit", unit, "--collect", "--no-block", "--property=Type=exec",
      "--property=Restart=no", "--property=KillMode=control-group",
      "--setenv=HOME=/root", `--setenv=CONCIERGE_REPO=${manager.environment.repositoryRoot}`,
      `--setenv=CONCIERGE_STATE_DIR=${process.env.CONCIERGE_STATE_DIR || "/root/.local/state/concierge"}`,
      `--setenv=CONCIERGE_DEPLOYMENT_RELEASE_ROOT=${manager.environment.releaseRoot}`,
      `--setenv=CONCIERGE_DEPLOYMENT_RUNTIME_DIR=${manager.environment.installRoot}`,
      `--setenv=CONCIERGE_BUN_BIN=${manager.environment.bunExecutable}`,
      `--setenv=CONCIERGE_DEPLOYMENT_CONTROL_ROOT=${join(intent.artifactPath, "control")}`,
      `--setenv=CONCIERGE_CONTROL_RECOVERY_RUN_ID=${runId}`,
      "/usr/bin/bash", join(intent.artifactPath, "control/deploy.sh")]);
    return { status: "handoff_accepted", run_id: runId, unit, artifact_digest: intent.artifactDigest };
  }
  const runId = required("--run-id");
  const intent = getControlRecoveryIntent(runId);
  if (!intent) throw new Error("Unknown controller recovery.");
  if (commandName === "recovery-state") return { ...intent, run: getDeploymentRun(runId) };
  if (commandName === "recovery-claim") {
    if (getDeploymentRun(runId)?.status === "succeeded") return { status: "succeeded", run_id: runId };
    const pid = Number(required("--owner-pid"));
    if (!Number.isSafeInteger(pid) || !isAncestorProcess(pid)) throw new Error("Recovery owner must be a live ancestor.");
    assertRepairUnitStopped(intent.incidentId, command);
    const run = claimControlRecovery(runId, processIdentity(pid));
    if (run.status === "succeeded") return { status: "succeeded", run_id: runId };
    containControlRecovery(runId, manager, process.env.CONCIERGE_SYSTEMD_DIR || "/etc/systemd/system", command);
    const manifest = manager.verify(intent.artifactPath);
    recordDeploymentReleasePrepared(runId, intent.artifactPath, manifest);
    notifyDeploymentWorker();
    return { ...intent, run, mask_owned: Boolean(controlRecoveryEvent(runId, "control_recovery_mask_intended")?.owned) };
  }
  if (commandName === "recovery-failed") {
    const run = failControlRecovery(runId, required("--error"));
    notifyDeploymentWorker();
    return { status: "reserved", run };
  }
  if (commandName === "recovery-unmask") {
    const lkg = getLastKnownGoodRelease();
    if (!lkg || manager.verify(lkg.artifact_path).control_git_commit !== intent.controlCommit) {
      throw new Error("Corrected control has not been proven and promoted.");
    }
    const mask = controlRecoveryEvent(runId, "control_recovery_mask_intended");
    if (mask?.owned) {
      const file = lstatSync(mask.path);
      const manifest = manager.verify(lkg.artifact_path);
      if (!file.isFile() || file.isSymbolicLink()
        || hash(readFileSync(mask.path)) !== manifest.files["control/systemd/concierge-deployment-repair@.service"]) {
        throw new Error("The promoted repair unit must be installed before clearing containment.");
      }
      command(["systemctl", "daemon-reload"]);
      recordControlRecoveryEvent(runId, "control_recovery_unmasked", { control_commit: intent.controlCommit });
    }
    return { status: "ready", owned_mask: Boolean(mask?.owned) };
  }
  throw new Error(`Unknown controller recovery command ${commandName}.`);
}
