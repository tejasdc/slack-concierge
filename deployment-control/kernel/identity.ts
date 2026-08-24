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
  const files = [
    join(input.kernelRoot, "manifest.json"),
    join(runtimeRoot, "coordinator/current/manifest.json"),
    join(runtimeRoot, "rollout/current/manifest.json"),
    join(runtimeRoot, "bun"),
    join(runtimeRoot, "codex"),
    join(releaseRoot, "current/manifest.json"),
    resolve(input.sysusersPath || "/etc/sysusers.d/concierge-deployment.conf"),
    resolve(input.tmpfilesPath || "/etc/tmpfiles.d/concierge-deployment.conf"),
    join(systemdUnitRoot, "concierge-bot.service"),
    join(systemdUnitRoot, "concierge-deployment-kernel.service"),
    join(systemdUnitRoot, "concierge-deployment-provider-adapter.service"),
    join(systemdUnitRoot, "concierge-deployment-coordinator.service"),
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
