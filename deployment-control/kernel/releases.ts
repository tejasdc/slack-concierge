import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  chownSync,
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
  unlinkSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export interface ReleaseManagerEnvironment {
  repositoryRoot: string;
  releaseRoot: string;
  installRoot: string;
  builderUser: string;
  builderGroup: string;
  systemdRunBin: string;
  systemctlBin: string;
  serviceName: string;
}

export interface PreparedRelease {
  gitCommit: string;
  artifactPath: string;
  artifactDigest: string;
  runtimeDigest: string;
  compatibilityDigest: string;
  sourceTreeDigest: string;
  builderUnit: string;
}

interface SpawnResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export interface ReleaseManagerServices {
  spawn(command: string[], options?: { cwd?: string; stdin?: Uint8Array; env?: Record<string, string> }): SpawnResult;
  resolveIdentity(user: string, group: string): { uid: number; gid: number };
}

export class ReleaseEffectAmbiguousError extends Error {}

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} is not a SHA-256 digest.`);
  }
}

function assertCommit(value: string) {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error("Release commit must be a full lowercase Git SHA.");
}

function assertInside(root: string, path: string) {
  const relativePath = relative(resolve(root), resolve(path));
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || relativePath.startsWith(sep)) {
    throw new Error(`${path} escapes release root ${root}.`);
  }
}

export function inspectReleaseTree(root: string, options: { allowSymlinks: boolean }) {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        if (!options.allowSymlinks) throw new Error(`Release artifact contains symlink ${path}.`);
        const target = readlinkSync(path);
        if (target.startsWith("/")) throw new Error(`Release source contains absolute symlink ${path}.`);
        const resolvedTarget = resolve(dirname(path), target);
        assertInside(root, resolvedTarget);
        if (!existsSync(resolvedTarget)) throw new Error(`Release source contains dangling symlink ${path}.`);
        continue;
      }
      if (stat.isDirectory()) {
        visit(path);
        continue;
      }
      if (!stat.isFile()) throw new Error(`Release tree contains special file ${path}.`);
      files.push(relative(root, path).split(sep).join("/"));
    }
  };
  visit(root);
  return files.sort();
}

export function releaseFileSetDigest(root: string, paths: string[]) {
  const hash = createHash("sha256");
  for (const path of [...paths].sort()) {
    const contents = readFileSync(join(root, path));
    hash.update(`${path}\0${contents.byteLength}\0`);
    hash.update(contents);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function normalizeTree(path: string, owner: { uid: number; gid: number }, readOnly: boolean) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    chownSync(path, owner.uid, owner.gid);
    return;
  }
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) normalizeTree(join(path, entry), owner, readOnly);
    chownSync(path, owner.uid, owner.gid);
    chmodSync(path, readOnly ? 0o555 : 0o700);
    return;
  }
  chownSync(path, owner.uid, owner.gid);
  chmodSync(path, readOnly ? ((stat.mode & 0o111) ? 0o555 : 0o444) : 0o600);
}

function defaultServices(): ReleaseManagerServices {
  return {
    spawn(command, options = {}) {
      return Bun.spawnSync({
        cmd: command,
        cwd: options.cwd,
        stdin: options.stdin,
        stdout: "pipe",
        stderr: "pipe",
        env: options.env || process.env,
      }) as SpawnResult;
    },
    resolveIdentity(user, group) {
      const uid = Bun.spawnSync({ cmd: ["/usr/bin/id", "-u", user], stdout: "pipe", stderr: "pipe" });
      const gid = Bun.spawnSync({ cmd: ["/usr/bin/getent", "group", group], stdout: "pipe", stderr: "pipe" });
      if (uid.exitCode !== 0 || gid.exitCode !== 0) throw new Error("Release builder identity is unavailable.");
      const numericUid = Number(uid.stdout.toString().trim());
      const numericGid = Number(gid.stdout.toString().trim().split(":")[2]);
      if (!Number.isSafeInteger(numericUid) || !Number.isSafeInteger(numericGid)) {
        throw new Error("Release builder identity is invalid.");
      }
      return { uid: numericUid, gid: numericGid };
    },
  };
}

export class ImmutableReleaseManager {
  constructor(
    readonly environment: ReleaseManagerEnvironment,
    readonly services: ReleaseManagerServices = defaultServices(),
  ) {}

  prepare(attemptId: string, gitCommit: string): PreparedRelease {
    assertCommit(gitCommit);
    if (!/^[0-9a-f-]{16,100}$/.test(attemptId)) throw new Error("Release attempt identity is invalid.");
    const stagingRoot = join(this.environment.releaseRoot, "staging", attemptId);
    if (existsSync(stagingRoot)) throw new Error(`Release staging already exists for attempt ${attemptId}.`);
    const source = join(stagingRoot, "source");
    const outputParent = join(stagingRoot, "output");
    const output = join(outputParent, "release");
    mkdirSync(join(this.environment.releaseRoot, "staging"), { recursive: true, mode: 0o711 });
    mkdirSync(stagingRoot, { mode: 0o711 });
    mkdirSync(source, { mode: 0o700 });
    mkdirSync(outputParent, { mode: 0o700 });

    const archive = this.services.spawn([
      "/usr/bin/git", "-C", this.environment.repositoryRoot, "archive", "--format=tar", gitCommit,
    ]);
    if (archive.exitCode !== 0) {
      throw new Error(`Git archive failed: ${Buffer.from(archive.stderr).toString("utf8").slice(0, 1000)}`);
    }
    const sourceTreeDigest = sha256(archive.stdout);
    const extracted = this.services.spawn(["/usr/bin/tar", "-xf", "-", "-C", source], { stdin: archive.stdout });
    if (extracted.exitCode !== 0) {
      throw new Error(`Release extraction failed: ${Buffer.from(extracted.stderr).toString("utf8").slice(0, 1000)}`);
    }
    inspectReleaseTree(source, { allowSymlinks: true });
    normalizeTree(source, { uid: 0, gid: 0 }, true);
    const builderIdentity = this.services.resolveIdentity(this.environment.builderUser, this.environment.builderGroup);
    normalizeTree(outputParent, builderIdentity, false);

    const builderUnit = `concierge-build-${attemptId.slice(0, 20)}`;
    const builder = this.services.spawn([
      this.environment.systemdRunBin,
      "--wait", "--pipe", "--collect", "--unit", builderUnit,
      "--property=Type=exec",
      `--property=User=${this.environment.builderUser}`,
      `--property=Group=${this.environment.builderGroup}`,
      "--property=NoNewPrivileges=yes",
      "--property=PrivateNetwork=yes",
      "--property=PrivateTmp=yes",
      "--property=PrivateDevices=yes",
      "--property=ProtectSystem=strict",
      "--property=ProtectHome=yes",
      "--property=ProtectProc=invisible",
      "--property=ProcSubset=pid",
      "--property=CapabilityBoundingSet=",
      "--property=RestrictAddressFamilies=AF_UNIX",
      `--property=ReadOnlyPaths=${source} ${join(this.environment.installRoot, "kernel/current")} ${join(this.environment.installRoot, "dependencies/current")}`,
      `--property=ReadWritePaths=${outputParent}`,
      `--setenv=NODE_PATH=${join(this.environment.installRoot, "dependencies/current/node_modules")}`,
      join(this.environment.installRoot, "bun"),
      join(this.environment.installRoot, "kernel/current/build-release.js"),
      "--source", source,
      "--output", output,
      "--commit", gitCommit,
      "--source-tree-digest", sourceTreeDigest,
    ]);
    if (builder.exitCode !== 0) {
      throw new Error(`Contained release build failed: ${Buffer.from(builder.stderr).toString("utf8").slice(0, 4000)}`);
    }
    const prepared = this.verifyBuilderOutput(output, gitCommit, sourceTreeDigest);
    const artifactPath = join(this.environment.releaseRoot, "releases", prepared.artifactDigest);
    mkdirSync(dirname(artifactPath), { recursive: true, mode: 0o755 });
    if (existsSync(artifactPath)) {
      this.verifyBuilderOutput(artifactPath, gitCommit, sourceTreeDigest);
      rmSync(output, { recursive: true, force: true });
    } else {
      normalizeTree(output, { uid: 0, gid: 0 }, true);
      renameSync(output, artifactPath);
    }
    rmSync(stagingRoot, { recursive: true, force: true });
    return { ...prepared, artifactPath, sourceTreeDigest, builderUnit };
  }

  verifyBuilderOutput(output: string, gitCommit: string, sourceTreeDigest: string) {
    const files = inspectReleaseTree(output, { allowSymlinks: false });
    const expectedFiles = [
      "artifact.sha256",
      "bot/scripts/rename-exchange.py",
      "bot/src/codex-app-server-bridge.mjs",
      "bot/src/index.js",
      "builder-result.json",
      "manifest.json",
    ];
    if (JSON.stringify(files) !== JSON.stringify(expectedFiles)) {
      throw new Error(`Release artifact file set is invalid: ${files.join(", ")}`);
    }
    const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
    const result = JSON.parse(readFileSync(join(output, "builder-result.json"), "utf8"));
    const claimedArtifactDigest = readFileSync(join(output, "artifact.sha256"), "utf8").trim();
    for (const [value, label] of [
      [manifest.runtime_digest, "manifest runtime digest"],
      [manifest.compatibility_digest, "manifest compatibility digest"],
      [result.artifact_digest, "result artifact digest"],
      [result.runtime_digest, "result runtime digest"],
      [result.compatibility_digest, "result compatibility digest"],
      [claimedArtifactDigest, "artifact digest"],
    ] as Array<[unknown, string]>) assertDigest(value, label);
    if (manifest.git_commit !== gitCommit || result.git_commit !== gitCommit) {
      throw new Error("Release artifact commit does not match the requested commit.");
    }
    if (manifest.source_tree_digest !== sourceTreeDigest) {
      throw new Error("Release artifact source-tree digest does not match the root materialization.");
    }
    const runtimeFiles = [
      "bot/src/index.js",
      "bot/src/codex-app-server-bridge.mjs",
      "bot/scripts/rename-exchange.py",
    ];
    if (releaseFileSetDigest(output, runtimeFiles) !== manifest.runtime_digest
      || result.runtime_digest !== manifest.runtime_digest
      || result.compatibility_digest !== manifest.compatibility_digest) {
      throw new Error("Release runtime or compatibility digest is invalid.");
    }
    const actualArtifactDigest = releaseFileSetDigest(output, [...runtimeFiles, "manifest.json"]);
    if (actualArtifactDigest !== claimedArtifactDigest || result.artifact_digest !== claimedArtifactDigest) {
      throw new Error("Release artifact digest is invalid.");
    }
    return {
      gitCommit,
      artifactDigest: claimedArtifactDigest,
      runtimeDigest: manifest.runtime_digest as string,
      compatibilityDigest: manifest.compatibility_digest as string,
    };
  }

  activate(artifactPath: string) {
    const releaseDirectory = realpathSync(artifactPath);
    assertInside(join(this.environment.releaseRoot, "releases"), releaseDirectory);
    const manifest = JSON.parse(readFileSync(join(releaseDirectory, "manifest.json"), "utf8"));
    this.verifyBuilderOutput(releaseDirectory, manifest.git_commit, manifest.source_tree_digest);
    const current = join(this.environment.releaseRoot, "current");
    if (existsSync(current) && !lstatSync(current).isSymbolicLink()) {
      throw new Error("Stable release pointer is not a symlink.");
    }
    const previousTarget = existsSync(current) ? readlinkSync(current) : null;
    const temporary = join(this.environment.releaseRoot, `.current-${randomUUID()}`);
    symlinkSync(relative(this.environment.releaseRoot, releaseDirectory), temporary);
    renameSync(temporary, current);
    const restarted = this.services.spawn([this.environment.systemctlBin, "restart", this.environment.serviceName]);
    if (restarted.exitCode !== 0) {
      const restorePointer = join(this.environment.releaseRoot, `.current-restore-${randomUUID()}`);
      if (previousTarget) {
        symlinkSync(previousTarget, restorePointer);
        renameSync(restorePointer, current);
      } else {
        unlinkSync(current);
      }
      const restored = previousTarget
        ? this.services.spawn([this.environment.systemctlBin, "restart", this.environment.serviceName])
        : null;
      const detail = Buffer.from(restarted.stderr).toString("utf8").slice(0, 1000);
      if (restored && restored.exitCode === 0) {
        throw new Error(`Candidate service restart failed and the prior release pointer was restored: ${detail}`);
      }
      throw new ReleaseEffectAmbiguousError(`Candidate service restart failed and prior runtime restoration was not proven: ${detail}`);
    }
    const invocation = this.services.spawn([
      this.environment.systemctlBin, "show", this.environment.serviceName, "--property=InvocationID", "--value",
    ]);
    if (invocation.exitCode !== 0 || !Buffer.from(invocation.stdout).toString("utf8").trim()) {
      throw new Error("Service restart succeeded but its invocation identity is unavailable.");
    }
    return {
      git_commit: manifest.git_commit as string,
      artifact_digest: basename(releaseDirectory),
      service_invocation_id: Buffer.from(invocation.stdout).toString("utf8").trim(),
    };
  }
}

export function defaultReleaseManagerEnvironment(repositoryRoot: string): ReleaseManagerEnvironment {
  return {
    repositoryRoot,
    releaseRoot: process.env.CONCIERGE_DEPLOYMENT_RELEASE_ROOT || "/var/lib/concierge-deployment",
    installRoot: process.env.CONCIERGE_DEPLOYMENT_RUNTIME_DIR || "/usr/local/lib/concierge-deployment",
    builderUser: "concierge-builder",
    builderGroup: "concierge-builder",
    systemdRunBin: "/usr/bin/systemd-run",
    systemctlBin: "/usr/bin/systemctl",
    serviceName: "concierge-bot.service",
  };
}
