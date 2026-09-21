import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync, renameSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { TrustedRootReleaseManager } from "./deployment-release";
import { claimControlRecovery, controlRecoveryEvent, failControlRecovery, getControlRecoveryIntent,
  getActiveDeploymentRun, getDeploymentDesiredState, getDeploymentRepairIncident, getDeploymentRun, getLastKnownGoodRelease,
  getLatestDeploymentRun, LKG_UNAVAILABLE_ERROR, listDeploymentRunEvents, prepareControlRecovery,
  prepareSelfVerificationControlRecovery,
  prepareLostRegistryControlRecovery, recordControlRecoveryEvent, recordDeploymentReleasePrepared,
  type DeploymentReleaseRow, type DeploymentRunRow } from "./deployment-state";
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

function regularEvidence(path: string, label: string) {
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink()) throw new Error(`${label} must be a regular file.`);
  return readFileSync(path);
}

function backedUpLkg(path: string, expectedDigest: string, manager: TrustedRootReleaseManager) {
  const bytes = regularEvidence(path, "Registry backup");
  if (hash(bytes) !== expectedDigest) throw new Error("Registry backup digest changed.");
  const backup = new Database(path, { readonly: true });
  try {
    if ((backup.query("PRAGMA integrity_check").get() as { integrity_check: string } | null)?.integrity_check !== "ok"
      || backup.query("PRAGMA foreign_key_check").all().length) throw new Error("Registry backup is inconsistent.");
    const releases = backup.query("SELECT * FROM deployment_releases WHERE state='lkg'").all() as DeploymentReleaseRow[];
    if (releases.length !== 1) throw new Error("Registry backup must contain exactly one proven LKG.");
    const release = releases[0]!;
    const run = backup.query("SELECT * FROM deployment_runs WHERE id=?")
      .get(release.run_id) as (DeploymentRunRow & { target: string; unit_name: string }) | null;
    if (!run || run.status !== "succeeded" || run.deployed_commit !== release.git_commit
      || !run.evidence_json || JSON.parse(run.evidence_json).release_digest !== release.artifact_digest) {
      throw new Error("The backed-up LKG run lacks matching functional health proof.");
    }
    const manifest = manager.verify(release.artifact_path);
    if (manifest.artifact_digest !== release.artifact_digest || manifest.git_commit !== release.git_commit
      || manifest.source_tree_digest !== release.source_tree_digest || manifest.runtime_digest !== release.runtime_digest
      || manifest.compatibility_digest !== release.compatibility_digest) {
      throw new Error("Immutable LKG manifest differs from backup provenance.");
    }
    return { release, run };
  } finally {
    backup.close();
  }
}

function verifyCurrentRollback(artifactPath: string, invocationId: string,
  manager: TrustedRootReleaseManager, command: RecoveryCommand) {
  manager.verify(artifactPath);
  for (const pointer of ["current", "control"]) {
    const path = join(manager.environment.releaseRoot, pointer);
    if (resolve(manager.environment.releaseRoot, readlinkSync(path)) !== resolve(artifactPath)) {
      throw new Error(`${pointer} no longer points to the proven healthy release.`);
    }
  }
  const service = properties(command(["systemctl", "show", "concierge-bot.service",
    "--property=MainPID", "--property=ActiveState", "--property=InvocationID"]));
  if (service.ActiveState !== "active" || service.MainPID === "0" || service.InvocationID !== invocationId) {
    throw new Error("The observed healthy rollback invocation is no longer running.");
  }
  command([manager.environment.bunExecutable, join(artifactPath, "control/healthcheck.js")]);
  const captureHealth = JSON.parse(command([manager.environment.bunExecutable,
    join(artifactPath, "control/capture-healthcheck.js")]));
  if (captureHealth.ok !== true) throw new Error("Current capture ingress is unhealthy.");
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
        throw new Error("Controller recovery requires a clean source checkout at the exact integrated revision.");
      }
      const incidentId = required("--incident-id");
      assertRepairUnitStopped(incidentId, command);
      const exceptionPath = option("--operator-exception");
      if (exceptionPath) {
        const exceptionBytes = regularEvidence(exceptionPath, "Operator exception");
        const exception = JSON.parse(exceptionBytes.toString()) as Record<string, any>;
        if (exception.kind === "human_authorized_deployment_control_lock_recovery") {
          const incident = getDeploymentRepairIncident(incidentId);
          const run = incident && getDeploymentRun(incident.run_id);
          const lkg = getLastKnownGoodRelease();
          const desired = getDeploymentDesiredState();
          const history = run ? listDeploymentRunEvents(run.id) : [];
          const releases = history.filter(event => event.event === "releasing");
          const releasing = releases.at(-1);
          if (!incident || !run || !lkg || !desired || !releasing
            || getActiveDeploymentRun(run.target)
            || incident.status !== "parked" || incident.review_verdict !== "NO_SHIP"
            || incident.failed_commit !== run.candidate_commit || incident.restored_commit !== lkg.git_commit
            || incident.repair_commit !== "d3cea39c68e4185b1328219dedff5f68ea4812f8"
            || incident.same_failure_count !== 2 || incident.error !== "Error: Repair agent did not change the rejected revision."
            || run.status !== "failed" || run.repair_state !== "parked"
            || run.error !== `Autonomous deployment repair parked: ${incident.error}`
            || exception.control_commit !== controlCommit || exception.prior_incident_id !== incidentId
            || exception.human_scope !== "fix_the_pipeline_and_native_inbox"
            || exception.no_tests_input !== "1789490492.818709"
            || exception.review_policy_superseded_input !== "1789490293.092859"
            || exception.previous_review_verdict !== incident.review_verdict
            || exception.previous_review_commit !== incident.repair_commit
            || exception.previous_review_digest !== hash(incident.review_json || "")
            || exception.same_failure_count !== incident.same_failure_count
            || exception.lkg_artifact_digest !== lkg.artifact_digest
            || exception.failure?.run_id !== run.id
            || exception.failure?.failed_commit !== incident.failed_commit
            || exception.failure?.candidate_artifact_digest !== run.candidate_artifact_digest
            || exception.failure?.candidate_service_invocation_id !== JSON.parse(releasing.detail_json).service_invocation_id
            || exception.failure?.original_candidate_service_invocation_id !== JSON.parse(releases[0]!.detail_json).service_invocation_id
            || exception.failure?.failed_control_stage !== "promote_candidate_release: database is locked"
            || exception.rollback?.runtime_sha !== lkg.git_commit
            || exception.rollback?.service_invocation_id !== "3d065d1a575a4e1f8e163649186a95b8"
            || exception.current_lkg?.runtime_sha !== lkg.git_commit
            || !/^[0-9a-f]{32}$/.test(exception.current_lkg?.service_invocation_id || "")
            || exception.desired_commit !== desired.desired_commit) {
            throw new Error("Operator control-lock exception does not match the intact incident, health history or human policy.");
          }
          verifyCurrentRollback(lkg.artifact_path, exception.current_lkg.service_invocation_id, manager, command);
          runId = randomUUID();
          const artifact = await manager.prepare(runId, lkg.git_commit, controlCommit);
          prepareControlRecovery({ runId, incidentId, controlCommit, healthyCommit: lkg.git_commit,
            artifactPath: artifact.artifactPath, artifactDigest: artifact.manifest.artifact_digest,
            sourceTreeDigest: command(["git", "rev-parse", "HEAD^{tree}"], sourceRoot),
            operatorAuthorityDigest: hash(exceptionBytes) });
          recordControlRecoveryEvent(runId, "operator_failure_observed", {
            failed_run_id: run.id, failure: exception.failure, rollback: exception.rollback,
            previous_review_verdict: incident.review_verdict,
            previous_review_commit: incident.repair_commit,
            previous_review_digest: exception.previous_review_digest,
            operator_authority_digest: hash(exceptionBytes),
          });
        } else if (exception.kind === "human_authorized_lkg_self_verification_recovery") {
          // For a control that rejects its own last-known-good release, so every deploy stops
          // before activation (see DEPLOYMENT-REPAIR.md, "Artifact contents"). Proves that exact
          // fault before building anything: the LKG's own control rejects it and the corrected
          // verifier in this source accepts it.
          const lkg = getLastKnownGoodRelease();
          const failed = getLatestDeploymentRun();
          if (!lkg || !failed) throw new Error("Self-verification recovery needs a recorded LKG and a failed run.");
          const own = Bun.spawnSync({
            cmd: [manager.environment.bunExecutable, join(lkg.artifact_path, "control/release-manager.js"), "lkg"],
            env: { ...process.env, HOME: "/root" }, stdout: "pipe", stderr: "pipe",
          });
          const ownOutput = `${own.stdout.toString()}${own.stderr.toString()}`;
          if (own.exitCode === 0 || !ownOutput.includes("Release artifact file set is invalid")) {
            throw new Error("The last-known-good release's own control accepts it; this is not the self-verification failure.");
          }
          manager.verify(lkg.artifact_path);
          if (exception.control_commit !== controlCommit || exception.prior_incident_id !== incidentId
            || exception.lkg_artifact_digest !== lkg.artifact_digest
            || failed.status !== "failed" || failed.error !== LKG_UNAVAILABLE_ERROR
            || exception.failure?.run_id !== failed.id || exception.failure?.error !== LKG_UNAVAILABLE_ERROR
            || typeof exception.human_authorization?.input_id !== "string" || !exception.human_authorization.input_id
            || typeof exception.human_authorization?.words !== "string" || !exception.human_authorization.words.trim()
            || exception.rollback?.runtime_sha !== lkg.git_commit
            || !/^[0-9a-f]{32}$/.test(exception.rollback?.service_invocation_id || "")) {
            throw new Error("Operator exception does not match the self-verification failure, the LKG or the human authority.");
          }
          verifyCurrentRollback(lkg.artifact_path, exception.rollback.service_invocation_id, manager, command);
          runId = randomUUID();
          const artifact = await manager.prepare(runId, lkg.git_commit, controlCommit);
          prepareSelfVerificationControlRecovery({ runId, incidentId, controlCommit, healthyCommit: lkg.git_commit,
            artifactPath: artifact.artifactPath, artifactDigest: artifact.manifest.artifact_digest,
            sourceTreeDigest: command(["git", "rev-parse", "HEAD^{tree}"], sourceRoot),
            operatorAuthorityDigest: hash(exceptionBytes), sourceRunId: failed.id });
          recordControlRecoveryEvent(runId, "operator_failure_observed", {
            failed_run_id: failed.id, failure: exception.failure, rollback: exception.rollback,
            human_authorization_input: exception.human_authorization.input_id,
            operator_authority_digest: hash(exceptionBytes),
          });
        } else {
          if (getDeploymentRepairIncident(incidentId)) throw new Error("An existing incident must use its exact controller recovery path.");
          const backupPath = required("--registry-backup");
          if (exception.kind !== "human_authorized_registry_loss_control_recovery"
            || exception.control_commit !== controlCommit || exception.prior_incident_id !== incidentId
            || incidentId !== "84934ba3-a60c-4b08-93d6-7ea4e71eaebe"
            || !/^[0-9a-f]{64}$/.test(exception.registry_backup_digest || "")
            || exception.human_scope !== "fix_the_pipeline_and_native_inbox"
            || exception.no_tests_input !== "1789490492.818709"
            || exception.review_policy_superseded_input !== "1789490293.092859"
            || exception.previous_review_verdict !== "NO_SHIP"
            || !exception.failure || !exception.rollback) {
            throw new Error("Operator exception must record the exact human scope, superseded gates and failure history.");
          }
          const { release, run } = backedUpLkg(backupPath, exception.registry_backup_digest, manager);
          if (exception.lkg_artifact_digest !== release.artifact_digest
            || exception.failure.run_id !== "e030ac1e-c4ff-44f3-89cd-39111ffbecda"
            || exception.failure.failed_commit !== "b49c8e16d3902aaeccc9b378860070daa98370fd"
            || exception.failure.candidate_runtime_sha !== exception.failure.failed_commit
            || exception.failure.candidate_service_invocation_id !== "d39ae89711b34fe7af1040c1fb71f66c"
            || exception.failure.failed_control_stage !== "deploy-state.js initializeRouterSearchIndex: view router_search_sources already exists"
            || exception.rollback.runtime_sha !== release.git_commit
            || exception.rollback.service_invocation_id !== "83b075f900ce450998b3aae1a7c5f4c7") {
            throw new Error("The operator exception does not match this observed failure and rollback.");
          }
          verifyCurrentRollback(release.artifact_path, exception.rollback.service_invocation_id, manager, command);
          runId = randomUUID();
          const artifact = await manager.prepare(runId, release.git_commit, controlCommit);
          prepareLostRegistryControlRecovery({
            intent: { runId, sourceRunId: runId, incidentId, controlCommit, healthyCommit: release.git_commit,
              artifactPath: artifact.artifactPath, artifactDigest: artifact.manifest.artifact_digest,
              sourceTreeDigest: command(["git", "rev-parse", "HEAD^{tree}"], sourceRoot),
              operatorAuthorityDigest: hash(exceptionBytes) },
            lkgRun: run, lkgRelease: release, snapshotDigest: exception.registry_backup_digest,
            failureEvidence: { ...exception.failure, operator_authority_digest: hash(exceptionBytes) },
            rollbackEvidence: exception.rollback,
          });
        }
      } else {
        const reviewBytes = regularEvidence(required("--review-evidence"), "Review evidence");
        const review = JSON.parse(reviewBytes.toString());
        if (review.verdict !== "SHIP" || review.reviewed_commit !== controlCommit) {
          throw new Error("Controller recovery requires SHIP evidence for its exact revision.");
        }
        if (!getDeploymentRepairIncident(incidentId)) throw new Error("Unknown repair incident.");
        const lkg = getLastKnownGoodRelease();
        if (!lkg) throw new Error("No healthy application release is recorded.");
        manager.verify(lkg.artifact_path);
        runId = randomUUID();
        const artifact = await manager.prepare(runId, lkg.git_commit, controlCommit);
        prepareControlRecovery({ runId, incidentId, controlCommit, healthyCommit: lkg.git_commit,
          artifactPath: artifact.artifactPath, artifactDigest: artifact.manifest.artifact_digest,
          sourceTreeDigest: command(["git", "rev-parse", "HEAD^{tree}"], sourceRoot), reviewDigest: hash(reviewBytes) });
      }
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
