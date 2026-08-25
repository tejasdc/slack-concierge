import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

export interface InstalledIdentityManifest {
  schema_version: 1;
  files: Array<{
    path: string;
    real_path: string;
    sha256: string;
    mode: number;
    uid: number;
    gid: number;
  }>;
  effective_units: Array<{ unit: string; properties: string }>;
}

function canonicalJson(value: unknown): string {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function digest(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function digestAll(values: Array<string | Uint8Array>) {
  const hash = createHash("sha256");
  for (const value of values) hash.update(value);
  return hash.digest("hex");
}

function readManifest(path: string) {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`Installed identity manifest ${path} is invalid.`);
  }
  return manifest as Record<string, unknown>;
}

function assertDeclaredDigest(manifestPath: string, field: string, filePath: string) {
  const manifest = readManifest(manifestPath);
  const declared = manifest[field];
  const actual = digest(readFileSync(filePath));
  if (declared !== actual) {
    throw new Error(`Installed identity manifest ${manifestPath} does not match ${filePath}.`);
  }
}

function assertReleaseManifest(manifestPath: string, releasePath: string) {
  const manifest = readManifest(manifestPath);
  const declaredFiles = manifest.files;
  if (!declaredFiles || typeof declaredFiles !== "object" || Array.isArray(declaredFiles)) {
    throw new Error(`Installed release manifest ${manifestPath} has no file authority.`);
  }
  const entries = Object.entries(declaredFiles as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  const expectedFiles = [
    "bot/scripts/rename-exchange.py",
    "bot/src/codex-app-server-bridge.mjs",
    "bot/src/index.js",
  ];
  if (JSON.stringify(entries.map(([path]) => path)) !== JSON.stringify(expectedFiles)) {
    throw new Error(`Installed release manifest ${manifestPath} has an invalid file set.`);
  }
  for (const [relativePath, declared] of entries) {
    const filePath = join(releasePath, relativePath);
    if (declared !== digest(readFileSync(filePath))) {
      throw new Error(`Installed release manifest ${manifestPath} does not match ${filePath}.`);
    }
  }
}

export function installedIdentityManifest(input: {
  kernelRoot: string;
  runtimeRoot?: string;
  releaseRoot?: string;
  systemdUnitRoot?: string;
  sysusersPath?: string;
  tmpfilesPath?: string;
  systemctlBin?: string;
}): { manifest: InstalledIdentityManifest; digest: string } {
  const runtimeRoot = resolve(input.runtimeRoot || "/usr/local/lib/concierge-deployment");
  const releaseRoot = resolve(input.releaseRoot || "/var/lib/concierge-deployment");
  const systemdUnitRoot = resolve(input.systemdUnitRoot || "/etc/systemd/system");
  const kernelManifest = join(input.kernelRoot, "manifest.json");
  const coordinatorRoot = join(runtimeRoot, "coordinator/current");
  const coordinatorManifest = join(coordinatorRoot, "manifest.json");
  const coordinatorCatalogPath = join(runtimeRoot, "coordinator/catalog.json");
  const rolloutRoot = join(runtimeRoot, "rollout/current");
  const rolloutManifest = join(rolloutRoot, "manifest.json");
  const dependencyRoot = join(runtimeRoot, "dependencies/current");
  const dependencyManifest = join(dependencyRoot, "manifest.json");
  const releasePath = join(releaseRoot, "current");
  const releaseManifest = join(releasePath, "manifest.json");
  const kernelFields = [
    ["kernel_bundle_sha256", "kernel.js"],
    ["builder_bundle_sha256", "build-release.js"],
    ["provider_adapter_bundle_sha256", "provider-adapter.js"],
    ["repair_agent_bundle_sha256", "repair-agent.js"],
    ["review_agent_bundle_sha256", "review-agent.js"],
    ["application_launcher_sha256", "run-application.sh"],
    ["repair_charter_sha256", "repair-charter.md"],
    ["repair_result_schema_sha256", "repair-result.schema.json"],
    ["review_charter_sha256", "review-charter.md"],
    ["review_result_schema_sha256", "review-result.schema.json"],
    ["policy_sha256", "deployment-repair-policy.toml"],
  ] as const;
  for (const [field, name] of kernelFields) assertDeclaredDigest(kernelManifest, field, join(input.kernelRoot, name));
  assertDeclaredDigest(kernelManifest, "codex_sha256", join(runtimeRoot, "codex"));
  assertDeclaredDigest(coordinatorManifest, "coordinator_bundle_sha256", join(coordinatorRoot, "coordinator.js"));
  const coordinatorCatalog = readManifest(coordinatorCatalogPath);
  if (coordinatorCatalog.schema_version !== 1
    || (coordinatorCatalog.candidate_slot !== "a" && coordinatorCatalog.candidate_slot !== "b")
    || typeof coordinatorCatalog.candidate_version !== "string"
    || !/^[0-9a-f]{64}$/.test(coordinatorCatalog.candidate_version)) {
    throw new Error(`Installed coordinator catalog ${coordinatorCatalogPath} is invalid.`);
  }
  const coordinatorSlots = coordinatorCatalog.slots;
  if (!coordinatorSlots || typeof coordinatorSlots !== "object" || Array.isArray(coordinatorSlots)) {
    throw new Error(`Installed coordinator catalog ${coordinatorCatalogPath} has no slot authority.`);
  }
  const coordinatorSlotFiles = Object.entries(coordinatorSlots as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([slot, version]) => {
      if ((slot !== "a" && slot !== "b") || typeof version !== "string" || !/^[0-9a-f]{64}$/.test(version)) {
        throw new Error(`Installed coordinator catalog ${coordinatorCatalogPath} has an invalid slot.`);
      }
      const slotRoot = join(runtimeRoot, "coordinator/slots", slot);
      if (realpathSync(slotRoot) !== join(runtimeRoot, "coordinator", version)) {
        throw new Error(`Installed coordinator slot ${slot} does not match catalog version ${version}.`);
      }
      const manifestPath = join(slotRoot, "manifest.json");
      const bundlePath = join(slotRoot, "coordinator.js");
      assertDeclaredDigest(manifestPath, "coordinator_bundle_sha256", bundlePath);
      const manifest = readManifest(manifestPath);
      if (manifest.version !== version || manifest.version !== manifest.coordinator_bundle_sha256) {
        throw new Error(`Installed coordinator slot ${slot} manifest has an invalid aggregate version.`);
      }
      return [manifestPath, bundlePath];
    });
  if ((coordinatorSlots as Record<string, unknown>)[String(coordinatorCatalog.candidate_slot)]
    !== coordinatorCatalog.candidate_version) {
    throw new Error(`Installed coordinator catalog candidate does not match its slot.`);
  }
  assertDeclaredDigest(rolloutManifest, "rollout_bundle_sha256", join(rolloutRoot, "rollout.js"));
  assertDeclaredDigest(dependencyManifest, "lock_sha256", join(dependencyRoot, "bun.lock"));
  assertReleaseManifest(releaseManifest, releasePath);
  const kernelManifestValue = readManifest(kernelManifest);
  const codexDigest = digest(readFileSync(join(runtimeRoot, "codex")));
  const expectedKernelVersion = digestAll([
    ...kernelFields.slice(0, 10).map(([, name]) => readFileSync(join(input.kernelRoot, name))),
    codexDigest,
    readFileSync(join(input.kernelRoot, "deployment-repair-policy.toml")),
  ]);
  if (kernelManifestValue.version !== expectedKernelVersion) {
    throw new Error(`Installed identity manifest ${kernelManifest} has an invalid aggregate version.`);
  }
  for (const [manifestPath, field] of [
    [coordinatorManifest, "coordinator_bundle_sha256"],
    [rolloutManifest, "rollout_bundle_sha256"],
    [dependencyManifest, "lock_sha256"],
  ]) {
    const manifest = readManifest(manifestPath);
    if (manifest.version !== manifest[field]) {
      throw new Error(`Installed identity manifest ${manifestPath} has an invalid aggregate version.`);
    }
  }
  const files = [
    kernelManifest,
    ...kernelFields.map(([, name]) => join(input.kernelRoot, name)),
    coordinatorManifest,
    join(coordinatorRoot, "coordinator.js"),
    coordinatorCatalogPath,
    ...coordinatorSlotFiles,
    rolloutManifest,
    join(rolloutRoot, "rollout.js"),
    dependencyManifest,
    join(dependencyRoot, "bun.lock"),
    join(runtimeRoot, "bun"),
    join(runtimeRoot, "codex"),
    releaseManifest,
    ...Object.keys(readManifest(releaseManifest).files as Record<string, unknown>)
      .sort()
      .map((name) => join(releasePath, name)),
    resolve(input.sysusersPath || "/etc/sysusers.d/concierge-deployment.conf"),
    resolve(input.tmpfilesPath || "/etc/tmpfiles.d/concierge-deployment.conf"),
    join(systemdUnitRoot, "concierge-bot.service"),
    join(systemdUnitRoot, "concierge-deployment-kernel.service"),
    join(systemdUnitRoot, "concierge-deployment-provider-adapter.service"),
    join(systemdUnitRoot, "concierge-deployment-coordinator.service"),
    join(systemdUnitRoot, "concierge-deployment-coordinator@.service"),
    join(systemdUnitRoot, "concierge-deployment-repair@.service"),
    join(systemdUnitRoot, "concierge-deployment-review@.service"),
    join(systemdUnitRoot, "concierge-deployment-rollout@.service"),
  ].map((path) => {
    const realPath = realpathSync(path);
    const stat = lstatSync(realPath);
    if (!stat.isFile()) throw new Error(`Installed identity path ${path} is not a regular file.`);
    return {
      path,
      real_path: realPath,
      sha256: digest(readFileSync(realPath)),
      mode: stat.mode & 0o7777,
      uid: stat.uid,
      gid: stat.gid,
    };
  });
  const units = [
    "concierge-bot.service",
    "concierge-deployment-kernel.service",
    "concierge-deployment-provider-adapter.service",
    "concierge-deployment-coordinator.service",
    "concierge-deployment-coordinator@.service",
    "concierge-deployment-repair@.service",
    "concierge-deployment-review@.service",
    "concierge-deployment-rollout@.service",
  ];
  const effectiveUnits = units.map((unit) => {
    const result = Bun.spawnSync({
      cmd: [input.systemctlBin || "/usr/bin/systemctl", "show", unit,
        "--property=FragmentPath,User,Group,ExecStart,Environment,LoadCredential,NoNewPrivileges,PrivateNetwork,PrivateTmp,PrivateDevices,ProtectSystem,ProtectHome,ProtectProc,ProcSubset,CapabilityBoundingSet,RestrictAddressFamilies,ReadOnlyPaths,ReadWritePaths,InaccessiblePaths"],
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      throw new Error(`Cannot read effective identity for ${unit}: ${result.stderr.toString().trim().slice(0, 500)}`);
    }
    return { unit, properties: result.stdout.toString().trim() };
  });
  const manifest: InstalledIdentityManifest = {
    schema_version: 1,
    files,
    effective_units: effectiveUnits,
  };
  return { manifest, digest: digest(canonicalJson(manifest)) };
}
