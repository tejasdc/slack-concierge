#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const installRoot = process.env.CONCIERGE_DEPLOYMENT_RUNTIME_DIR || "/usr/local/lib/concierge-deployment";
const approved = process.env.CONCIERGE_APPROVE_CONTROL_PLANE_UPDATE === "1";

function sha256(...values: Array<string | Uint8Array>) {
  const hash = createHash("sha256");
  for (const value of values) hash.update(value);
  return hash.digest("hex");
}

function currentVersion(parent: string) {
  const current = join(parent, "current");
  if (!existsSync(current)) return null;
  if (!lstatSync(current).isSymbolicLink()) throw new Error(`${current} must be a root-owned release symlink.`);
  return basename(readlinkSync(current));
}

function activate(parent: string, version: string) {
  const current = join(parent, "current");
  const temporary = join(parent, `.current-${process.pid}`);
  symlinkSync(version, temporary);
  renameSync(temporary, current);
}

function activateNamed(parent: string, name: string, version: string) {
  const destination = join(parent, name);
  const temporary = join(parent, `.${name}-${process.pid}`);
  symlinkSync(version, temporary);
  renameSync(temporary, destination);
}

interface CoordinatorCatalog {
  schema_version: 1;
  candidate_slot: "a" | "b";
  candidate_version: string;
  legacy_version: string | null;
  slots: Partial<Record<"a" | "b", string>>;
}

function readCoordinatorCatalog(parent: string): CoordinatorCatalog | null {
  const path = join(parent, "catalog.json");
  if (!existsSync(path)) return null;
  const catalog = JSON.parse(readFileSync(path, "utf8"));
  if (catalog?.schema_version !== 1 || !["a", "b"].includes(catalog.candidate_slot)
    || !/^[0-9a-f]{64}$/.test(catalog.candidate_version)) {
    throw new Error("Installed coordinator A/B catalog is invalid.");
  }
  for (const [slot, version] of Object.entries(catalog.slots || {})) {
    if (!new Set(["a", "b"]).has(slot) || typeof version !== "string" || !/^[0-9a-f]{64}$/.test(version)) {
      throw new Error("Installed coordinator A/B catalog contains an invalid slot.");
    }
  }
  return catalog as CoordinatorCatalog;
}

function activeCoordinatorSlot() {
  const activeRecordPath = process.env.CONCIERGE_COORDINATOR_ACTIVE_RECORD
    || "/var/lib/concierge-deployment/coordinator-active.json";
  if (!existsSync(activeRecordPath)) return "legacy" as const;
  const active = JSON.parse(readFileSync(activeRecordPath, "utf8"));
  if (active?.schema_version !== 1 || !new Set(["legacy", "a", "b"]).has(active.slot)) {
    throw new Error("Installed coordinator active record is invalid.");
  }
  return active.slot as "legacy" | "a" | "b";
}

function writeCoordinatorCatalog(parent: string, catalog: CoordinatorCatalog) {
  const path = join(parent, "catalog.json");
  const temporary = join(parent, `.catalog-${process.pid}`);
  writeFileSync(temporary, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o444 });
  renameSync(temporary, path);
}

function build(entrypoint: string, outfile: string) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "build", entrypoint, "--target=bun", "--outfile", outfile],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function makeTreeReadOnly(path: string) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) {
      makeTreeReadOnly(join(path, entry));
    }
    chmodSync(path, 0o555);
    return;
  }
  chmodSync(path, stat.mode & 0o111 ? 0o555 : 0o444);
}

async function main() {
  if (process.geteuid?.() !== 0 && process.env.CONCIERGE_CONTROL_INSTALL_ALLOW_NON_ROOT !== "1") {
    throw new Error("Control-plane installation requires root.");
  }
  mkdirSync(installRoot, { recursive: true, mode: 0o755 });
  chmodSync(installRoot, 0o755);
  const staging = join(installRoot, `.staging-${process.pid}`);
  mkdirSync(staging, { recursive: false, mode: 0o700 });
  process.on("exit", () => rmSync(staging, { recursive: true, force: true }));
  const kernelBundle = join(staging, "kernel.js");
  const coordinatorBundle = join(staging, "coordinator.js");
  const rolloutBundle = join(staging, "rollout.js");
  const builderBundle = join(staging, "build-release.js");
  const providerAdapterBundle = join(staging, "provider-adapter.js");
  const repairAgentBundle = join(staging, "repair-agent.js");
  const reviewAgentBundle = join(staging, "review-agent.js");
  const rolloutReviewAgentBundle = join(staging, "rollout-review-agent.js");
  const providerBrokerBundle = join(staging, "provider-broker.js");
  const providerWorkerBundle = join(staging, "provider-worker.js");
  const providerContinuityBundle = join(staging, "provider-continuity.js");
  const applicationLauncherSource = join(repositoryRoot, "deployment-control/kernel/run-application.sh");
  const repairCharterSource = join(repositoryRoot, "deployment-control/repair/CHARTER.md");
  const repairResultSchemaSource = join(repositoryRoot, "deployment-control/repair/result.schema.json");
  const reviewCharterSource = join(repositoryRoot, "deployment-control/review/CHARTER.md");
  const reviewResultSchemaSource = join(repositoryRoot, "deployment-control/review/result.schema.json");
  const rolloutReviewCharterSource = join(repositoryRoot, "deployment-control/review/ROLLOUT-CHARTER.md");
  const codexSource = realpathSync(
    process.env.CONCIERGE_CODEX_BIN || "/root/.codex/packages/standalone/current/bin/codex",
  );
  const claudeSource = realpathSync(process.env.CONCIERGE_CLAUDE_BIN || "/usr/bin/claude");
  build(join(repositoryRoot, "deployment-control/kernel/server.ts"), kernelBundle);
  build(join(repositoryRoot, "deployment-control/coordinator/index.ts"), coordinatorBundle);
  build(join(repositoryRoot, "deployment-control/rollout/index.ts"), rolloutBundle);
  build(join(repositoryRoot, "deployment-control/kernel/build-release.ts"), builderBundle);
  build(join(repositoryRoot, "deployment-control/kernel/provider-adapter.ts"), providerAdapterBundle);
  build(join(repositoryRoot, "deployment-control/kernel/repair-agent.ts"), repairAgentBundle);
  build(join(repositoryRoot, "deployment-control/kernel/review-agent.ts"), reviewAgentBundle);
  build(join(repositoryRoot, "deployment-control/kernel/rollout-review-agent.ts"), rolloutReviewAgentBundle);
  build(join(repositoryRoot, "deployment-control/provider/broker.ts"), providerBrokerBundle);
  build(join(repositoryRoot, "deployment-control/provider/worker.ts"), providerWorkerBundle);
  build(join(repositoryRoot, "deployment-control/provider/continuity.ts"), providerContinuityBundle);

  const policySource = join(repositoryRoot, "config/deployment-repair-policy.toml");
  const policy = readFileSync(policySource);
  const kernel = readFileSync(kernelBundle);
  const coordinator = readFileSync(coordinatorBundle);
  const rollout = readFileSync(rolloutBundle);
  const builder = readFileSync(builderBundle);
  const providerAdapter = readFileSync(providerAdapterBundle);
  const repairAgent = readFileSync(repairAgentBundle);
  const reviewAgent = readFileSync(reviewAgentBundle);
  const rolloutReviewAgent = readFileSync(rolloutReviewAgentBundle);
  const providerBroker = readFileSync(providerBrokerBundle);
  const providerWorker = readFileSync(providerWorkerBundle);
  const providerContinuity = readFileSync(providerContinuityBundle);
  const dependencyLock = readFileSync(join(repositoryRoot, "bot/bun.lock"));
  const applicationLauncher = readFileSync(applicationLauncherSource);
  const repairCharter = readFileSync(repairCharterSource);
  const repairResultSchema = readFileSync(repairResultSchemaSource);
  const reviewCharter = readFileSync(reviewCharterSource);
  const reviewResultSchema = readFileSync(reviewResultSchemaSource);
  const rolloutReviewCharter = readFileSync(rolloutReviewCharterSource);
  const codexDigest = sha256(readFileSync(codexSource));
  const claudeDigest = sha256(readFileSync(claudeSource));
  const kernelVersion = sha256(
    kernel,
    builder,
    providerAdapter,
    repairAgent,
    reviewAgent,
    rolloutReviewAgent,
    applicationLauncher,
    repairCharter,
    repairResultSchema,
    reviewCharter,
    reviewResultSchema,
    rolloutReviewCharter,
    codexDigest,
    policy,
  );
  const coordinatorVersion = sha256(coordinator);
  const rolloutVersion = sha256(rollout);
  const providerVersion = sha256(providerBroker, providerWorker, providerContinuity, codexDigest, claudeDigest);
  const dependencyVersion = sha256(dependencyLock);
  const kernelParent = join(installRoot, "kernel");
  const coordinatorParent = join(installRoot, "coordinator");
  const rolloutParent = join(installRoot, "rollout");
  const providerParent = join(installRoot, "provider");
  const dependencyParent = join(installRoot, "dependencies");
  mkdirSync(kernelParent, { recursive: true, mode: 0o755 });
  mkdirSync(coordinatorParent, { recursive: true, mode: 0o755 });
  mkdirSync(rolloutParent, { recursive: true, mode: 0o755 });
  mkdirSync(providerParent, { recursive: true, mode: 0o755 });
  mkdirSync(dependencyParent, { recursive: true, mode: 0o755 });

  const installedKernel = currentVersion(kernelParent);
  const installedCoordinatorCatalog = readCoordinatorCatalog(coordinatorParent);
  const installedCoordinator = installedCoordinatorCatalog?.candidate_version || currentVersion(coordinatorParent);
  const installedRollout = currentVersion(rolloutParent);
  const installedProvider = currentVersion(providerParent);
  const installedDependencies = currentVersion(dependencyParent);
  if (!approved && ((installedKernel && installedKernel !== kernelVersion)
    || (installedCoordinator && installedCoordinator !== coordinatorVersion)
    || (installedRollout && installedRollout !== rolloutVersion)
    || (installedProvider && installedProvider !== providerVersion)
    || (installedDependencies && installedDependencies !== dependencyVersion))) {
    throw new Error(
      "Protected control-plane source changed. Set CONCIERGE_APPROVE_CONTROL_PLANE_UPDATE=1 only for a separately reviewed operator-approved promotion.",
    );
  }

  const kernelDestination = join(kernelParent, kernelVersion);
  if (!existsSync(kernelDestination)) {
    mkdirSync(kernelDestination, { mode: 0o700 });
    copyFileSync(kernelBundle, join(kernelDestination, "kernel.js"));
    copyFileSync(builderBundle, join(kernelDestination, "build-release.js"));
    copyFileSync(providerAdapterBundle, join(kernelDestination, "provider-adapter.js"));
    copyFileSync(repairAgentBundle, join(kernelDestination, "repair-agent.js"));
    copyFileSync(reviewAgentBundle, join(kernelDestination, "review-agent.js"));
    copyFileSync(rolloutReviewAgentBundle, join(kernelDestination, "rollout-review-agent.js"));
    copyFileSync(applicationLauncherSource, join(kernelDestination, "run-application.sh"));
    copyFileSync(repairCharterSource, join(kernelDestination, "repair-charter.md"));
    copyFileSync(repairResultSchemaSource, join(kernelDestination, "repair-result.schema.json"));
    copyFileSync(reviewCharterSource, join(kernelDestination, "review-charter.md"));
    copyFileSync(reviewResultSchemaSource, join(kernelDestination, "review-result.schema.json"));
    copyFileSync(rolloutReviewCharterSource, join(kernelDestination, "rollout-review-charter.md"));
    copyFileSync(policySource, join(kernelDestination, "deployment-repair-policy.toml"));
    writeFileSync(join(kernelDestination, "manifest.json"), `${JSON.stringify({
      kernel_bundle_sha256: sha256(kernel),
      builder_bundle_sha256: sha256(builder),
      provider_adapter_bundle_sha256: sha256(providerAdapter),
      repair_agent_bundle_sha256: sha256(repairAgent),
      review_agent_bundle_sha256: sha256(reviewAgent),
      rollout_review_agent_bundle_sha256: sha256(rolloutReviewAgent),
      application_launcher_sha256: sha256(applicationLauncher),
      repair_charter_sha256: sha256(repairCharter),
      repair_result_schema_sha256: sha256(repairResultSchema),
      review_charter_sha256: sha256(reviewCharter),
      review_result_schema_sha256: sha256(reviewResultSchema),
      rollout_review_charter_sha256: sha256(rolloutReviewCharter),
      codex_sha256: codexDigest,
      policy_sha256: sha256(policy),
      version: kernelVersion,
    }, null, 2)}\n`, { mode: 0o400 });
    chmodSync(join(kernelDestination, "kernel.js"), 0o555);
    chmodSync(join(kernelDestination, "build-release.js"), 0o555);
    chmodSync(join(kernelDestination, "provider-adapter.js"), 0o555);
    chmodSync(join(kernelDestination, "repair-agent.js"), 0o555);
    chmodSync(join(kernelDestination, "review-agent.js"), 0o555);
    chmodSync(join(kernelDestination, "rollout-review-agent.js"), 0o555);
    chmodSync(join(kernelDestination, "run-application.sh"), 0o555);
    chmodSync(join(kernelDestination, "repair-charter.md"), 0o444);
    chmodSync(join(kernelDestination, "repair-result.schema.json"), 0o444);
    chmodSync(join(kernelDestination, "review-charter.md"), 0o444);
    chmodSync(join(kernelDestination, "review-result.schema.json"), 0o444);
    chmodSync(join(kernelDestination, "rollout-review-charter.md"), 0o444);
    chmodSync(join(kernelDestination, "deployment-repair-policy.toml"), 0o400);
    chmodSync(kernelDestination, 0o555);
  }

  const coordinatorDestination = join(coordinatorParent, coordinatorVersion);
  if (!existsSync(coordinatorDestination)) {
    mkdirSync(coordinatorDestination, { mode: 0o755 });
    copyFileSync(coordinatorBundle, join(coordinatorDestination, "coordinator.js"));
    writeFileSync(join(coordinatorDestination, "manifest.json"), `${JSON.stringify({
      coordinator_bundle_sha256: sha256(coordinator),
      version: coordinatorVersion,
    }, null, 2)}\n`, { mode: 0o444 });
    chmodSync(join(coordinatorDestination, "coordinator.js"), 0o555);
    chmodSync(coordinatorDestination, 0o555);
  }
  const legacyCoordinatorVersion = currentVersion(coordinatorParent);
  const effectiveLegacyCoordinatorVersion = legacyCoordinatorVersion || coordinatorVersion;
  let candidateSlot = installedCoordinatorCatalog?.candidate_slot;
  let coordinatorSlots = { ...(installedCoordinatorCatalog?.slots || {}) };
  if (!candidateSlot || installedCoordinator !== coordinatorVersion) {
    const activeSlot = activeCoordinatorSlot();
    candidateSlot = activeSlot === "a" ? "b" : "a";
    const slotsRoot = join(coordinatorParent, "slots");
    mkdirSync(slotsRoot, { recursive: true, mode: 0o755 });
    activateNamed(slotsRoot, candidateSlot, `../${coordinatorVersion}`);
    coordinatorSlots[candidateSlot] = coordinatorVersion;
  }
  writeCoordinatorCatalog(coordinatorParent, {
    schema_version: 1,
    candidate_slot: candidateSlot,
    candidate_version: coordinatorVersion,
    legacy_version: effectiveLegacyCoordinatorVersion,
    slots: coordinatorSlots,
  });

  const rolloutDestination = join(rolloutParent, rolloutVersion);
  if (!existsSync(rolloutDestination)) {
    mkdirSync(rolloutDestination, { mode: 0o755 });
    copyFileSync(rolloutBundle, join(rolloutDestination, "rollout.js"));
    writeFileSync(join(rolloutDestination, "manifest.json"), `${JSON.stringify({
      rollout_bundle_sha256: sha256(rollout),
      version: rolloutVersion,
    }, null, 2)}\n`, { mode: 0o444 });
    chmodSync(join(rolloutDestination, "rollout.js"), 0o555);
    chmodSync(rolloutDestination, 0o555);
  }

  const providerDestination = join(providerParent, providerVersion);
  if (!existsSync(providerDestination)) {
    mkdirSync(providerDestination, { mode: 0o755 });
    copyFileSync(providerBrokerBundle, join(providerDestination, "broker.js"));
    copyFileSync(providerWorkerBundle, join(providerDestination, "worker.js"));
    copyFileSync(providerContinuityBundle, join(providerDestination, "continuity.js"));
    writeFileSync(join(providerDestination, "manifest.json"), `${JSON.stringify({
      broker_bundle_sha256: sha256(providerBroker),
      worker_bundle_sha256: sha256(providerWorker),
      continuity_bundle_sha256: sha256(providerContinuity),
      codex_sha256: codexDigest,
      claude_sha256: claudeDigest,
      version: providerVersion,
    }, null, 2)}\n`, { mode: 0o444 });
    chmodSync(join(providerDestination, "broker.js"), 0o555);
    chmodSync(join(providerDestination, "worker.js"), 0o555);
    chmodSync(join(providerDestination, "continuity.js"), 0o555);
    chmodSync(providerDestination, 0o555);
  }

  const dependencyDestination = join(dependencyParent, dependencyVersion);
  if (!existsSync(dependencyDestination)) {
    mkdirSync(dependencyDestination, { mode: 0o700 });
    cpSync(join(repositoryRoot, "bot/node_modules"), join(dependencyDestination, "node_modules"), {
      recursive: true,
      verbatimSymlinks: true,
    });
    copyFileSync(join(repositoryRoot, "bot/bun.lock"), join(dependencyDestination, "bun.lock"));
    writeFileSync(join(dependencyDestination, "manifest.json"), `${JSON.stringify({
      lock_sha256: sha256(dependencyLock),
      version: dependencyVersion,
    }, null, 2)}\n`, { mode: 0o444 });
    makeTreeReadOnly(dependencyDestination);
  }

  if (!installedKernel || installedKernel !== kernelVersion) activate(kernelParent, kernelVersion);
  if (!legacyCoordinatorVersion) activate(coordinatorParent, coordinatorVersion);
  if (!installedRollout || installedRollout !== rolloutVersion) activate(rolloutParent, rolloutVersion);
  if (!installedProvider || installedProvider !== providerVersion) activate(providerParent, providerVersion);
  if (!installedDependencies || installedDependencies !== dependencyVersion) activate(dependencyParent, dependencyVersion);

  const bunDestination = join(installRoot, "bun");
  const bunSource = realpathSync(process.execPath);
  if (!existsSync(bunDestination) || sha256(readFileSync(bunDestination)) !== sha256(readFileSync(bunSource))) {
    const temporary = join(dirname(bunDestination), `.bun-${process.pid}`);
    copyFileSync(bunSource, temporary);
    chmodSync(temporary, 0o555);
    renameSync(temporary, bunDestination);
  }

  const codexDestination = join(installRoot, "codex");
  if (!existsSync(codexDestination) || sha256(readFileSync(codexDestination)) !== codexDigest) {
    const temporary = join(dirname(codexDestination), `.codex-${process.pid}`);
    copyFileSync(codexSource, temporary);
    chmodSync(temporary, 0o555);
    renameSync(temporary, codexDestination);
  }

  const claudeDestination = join(installRoot, "claude");
  if (!existsSync(claudeDestination) || sha256(readFileSync(claudeDestination)) !== claudeDigest) {
    const temporary = join(dirname(claudeDestination), `.claude-${process.pid}`);
    copyFileSync(claudeSource, temporary);
    chmodSync(temporary, 0o555);
    renameSync(temporary, claudeDestination);
  }

  console.log(JSON.stringify({
    kernel_version: kernelVersion,
    coordinator_version: coordinatorVersion,
    coordinator_legacy_version: effectiveLegacyCoordinatorVersion,
    coordinator_candidate_slot: candidateSlot,
    coordinator_candidate_unit: `concierge-deployment-coordinator@${candidateSlot}.service`,
    rollout_version: rolloutVersion,
    provider_version: providerVersion,
    dependency_version: dependencyVersion,
    kernel_changed: installedKernel !== kernelVersion,
    coordinator_changed: installedCoordinator !== coordinatorVersion,
    rollout_changed: installedRollout !== rolloutVersion,
    provider_changed: installedProvider !== providerVersion,
    dependencies_changed: installedDependencies !== dependencyVersion,
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
