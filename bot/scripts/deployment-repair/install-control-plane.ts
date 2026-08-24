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
  const builderBundle = join(staging, "build-release.js");
  build(join(repositoryRoot, "deployment-control/kernel/server.ts"), kernelBundle);
  build(join(repositoryRoot, "deployment-control/coordinator/index.ts"), coordinatorBundle);
  build(join(repositoryRoot, "deployment-control/kernel/build-release.ts"), builderBundle);

  const policySource = join(repositoryRoot, "config/deployment-repair-policy.toml");
  const policy = readFileSync(policySource);
  const kernel = readFileSync(kernelBundle);
  const coordinator = readFileSync(coordinatorBundle);
  const builder = readFileSync(builderBundle);
  const dependencyLock = readFileSync(join(repositoryRoot, "bot/bun.lock"));
  const kernelVersion = sha256(kernel, builder, policy);
  const coordinatorVersion = sha256(coordinator);
  const dependencyVersion = sha256(dependencyLock);
  const kernelParent = join(installRoot, "kernel");
  const coordinatorParent = join(installRoot, "coordinator");
  const dependencyParent = join(installRoot, "dependencies");
  mkdirSync(kernelParent, { recursive: true, mode: 0o755 });
  mkdirSync(coordinatorParent, { recursive: true, mode: 0o755 });
  mkdirSync(dependencyParent, { recursive: true, mode: 0o755 });

  const installedKernel = currentVersion(kernelParent);
  const installedCoordinator = currentVersion(coordinatorParent);
  const installedDependencies = currentVersion(dependencyParent);
  if (!approved && ((installedKernel && installedKernel !== kernelVersion)
    || (installedCoordinator && installedCoordinator !== coordinatorVersion)
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
    copyFileSync(policySource, join(kernelDestination, "deployment-repair-policy.toml"));
    writeFileSync(join(kernelDestination, "manifest.json"), `${JSON.stringify({
      kernel_bundle_sha256: sha256(kernel),
      builder_bundle_sha256: sha256(builder),
      policy_sha256: sha256(policy),
      version: kernelVersion,
    }, null, 2)}\n`, { mode: 0o400 });
    chmodSync(join(kernelDestination, "kernel.js"), 0o555);
    chmodSync(join(kernelDestination, "build-release.js"), 0o555);
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
  if (!installedCoordinator || installedCoordinator !== coordinatorVersion) activate(coordinatorParent, coordinatorVersion);
  if (!installedDependencies || installedDependencies !== dependencyVersion) activate(dependencyParent, dependencyVersion);

  const bunDestination = join(installRoot, "bun");
  const bunSource = realpathSync(process.execPath);
  if (!existsSync(bunDestination) || sha256(readFileSync(bunDestination)) !== sha256(readFileSync(bunSource))) {
    const temporary = join(dirname(bunDestination), `.bun-${process.pid}`);
    copyFileSync(bunSource, temporary);
    chmodSync(temporary, 0o555);
    renameSync(temporary, bunDestination);
  }

  console.log(JSON.stringify({
    kernel_version: kernelVersion,
    coordinator_version: coordinatorVersion,
    dependency_version: dependencyVersion,
    kernel_changed: installedKernel !== kernelVersion,
    coordinator_changed: installedCoordinator !== coordinatorVersion,
    dependencies_changed: installedDependencies !== dependencyVersion,
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
