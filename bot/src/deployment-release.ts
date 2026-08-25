import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
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
import { dirname, join, relative, resolve, sep } from "node:path";

export interface ReleaseManifest {
  format: 1;
  git_commit: string;
  source_tree_digest: string;
  runtime_digest: string;
  compatibility_digest: string;
  artifact_digest: string;
  files: Record<string, string>;
}

export interface PreparedRelease {
  artifactPath: string;
  manifest: ReleaseManifest;
}

export interface ReleaseEnvironment {
  repositoryRoot: string;
  releaseRoot: string;
  installRoot: string;
  bunExecutable: string;
}

interface SpawnResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export interface ReleaseServices {
  spawn(command: string[], options?: { cwd?: string; stdin?: Uint8Array }): SpawnResult;
  build(entrypoint: string, outputDirectory: string): Promise<void>;
}

const RUNTIME_FILES = [
  "bot/src/index.js",
  "bot/src/codex-app-server-bridge.mjs",
  "bot/scripts/rename-exchange.py",
];

const COMPATIBILITY_FILES = [
  "bot/src/state.ts",
  "bot/src/capture-state.ts",
  "bot/src/deployment-state.ts",
];

function digest(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function assertCommit(value: string) {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error("Release commit must be a full lowercase Git SHA.");
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} is not a SHA-256 digest.`);
  }
}

function assertInside(root: string, path: string) {
  const relativePath = relative(resolve(root), resolve(path));
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || relativePath.startsWith(sep)) {
    throw new Error(`${path} escapes ${root}.`);
  }
}

function listRegularFiles(root: string, directory = root): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Release tree contains symlink ${path}.`);
    if (stat.isDirectory()) {
      files.push(...listRegularFiles(root, path));
      continue;
    }
    if (!stat.isFile()) throw new Error(`Release tree contains special file ${path}.`);
    files.push(relative(root, path).split(sep).join("/"));
  }
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

function makeReadOnly(path: string) {
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) makeReadOnly(join(path, entry));
    chmodSync(path, 0o555);
    return;
  }
  chmodSync(path, (stat.mode & 0o111) ? 0o555 : 0o444);
}

function defaultServices(): ReleaseServices {
  return {
    spawn(command, options = {}) {
      return Bun.spawnSync({
        cmd: command,
        cwd: options.cwd,
        stdin: options.stdin,
        stdout: "pipe",
        stderr: "pipe",
      }) as SpawnResult;
    },
    async build(entrypoint, outputDirectory) {
      const result = await Bun.build({
        entrypoints: [entrypoint],
        target: "bun",
        outdir: outputDirectory,
        naming: "index.js",
      });
      if (!result.success) {
        throw new Error(`Application bundle failed: ${result.logs.map((entry) => entry.message).join("\n").slice(0, 4000)}`);
      }
    },
  };
}

export function defaultReleaseEnvironment(repositoryRoot: string): ReleaseEnvironment {
  return {
    repositoryRoot,
    releaseRoot: process.env.CONCIERGE_DEPLOYMENT_RELEASE_ROOT || "/var/lib/slack-concierge-deployment",
    installRoot: process.env.CONCIERGE_DEPLOYMENT_RUNTIME_DIR || "/usr/local/lib/slack-concierge-deployment",
    bunExecutable: process.env.CONCIERGE_BUN_BIN || "/root/.bun/bin/bun",
  };
}

export class TrustedRootReleaseManager {
  constructor(
    readonly environment: ReleaseEnvironment,
    readonly services: ReleaseServices = defaultServices(),
  ) {}

  installRuntime(launcherSource: string) {
    mkdirSync(this.environment.installRoot, { recursive: true, mode: 0o755 });
    const bunDestination = join(this.environment.installRoot, "bun");
    const launcherDestination = join(this.environment.installRoot, "launch");
    const temporaryBun = `${bunDestination}.${process.pid}.tmp`;
    const temporaryLauncher = `${launcherDestination}.${process.pid}.tmp`;
    copyFileSync(realpathSync(this.environment.bunExecutable), temporaryBun);
    copyFileSync(launcherSource, temporaryLauncher);
    chmodSync(temporaryBun, 0o555);
    chmodSync(temporaryLauncher, 0o555);
    renameSync(temporaryBun, bunDestination);
    renameSync(temporaryLauncher, launcherDestination);
  }

  async prepare(attemptId: string, gitCommit: string): Promise<PreparedRelease> {
    assertCommit(gitCommit);
    if (!/^[0-9a-z-]{8,100}$/.test(attemptId)) throw new Error("Release attempt identity is invalid.");
    const stagingRoot = join(this.environment.releaseRoot, "staging", `${attemptId}-${randomUUID()}`);
    const sourceRoot = join(stagingRoot, "source");
    const outputRoot = join(stagingRoot, "release");
    mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
    mkdirSync(outputRoot, { recursive: true, mode: 0o700 });

    try {
      const archive = this.services.spawn([
        "/usr/bin/git", "-C", this.environment.repositoryRoot, "archive", "--format=tar", gitCommit,
      ]);
      if (archive.exitCode !== 0) {
        throw new Error(`Git archive failed: ${Buffer.from(archive.stderr).toString("utf8").slice(0, 1000)}`);
      }
      const sourceTreeDigest = digest(archive.stdout);
      const extracted = this.services.spawn(["/usr/bin/tar", "-xf", "-", "-C", sourceRoot], { stdin: archive.stdout });
      if (extracted.exitCode !== 0) {
        throw new Error(`Release extraction failed: ${Buffer.from(extracted.stderr).toString("utf8").slice(0, 1000)}`);
      }
      listRegularFiles(sourceRoot);
      mkdirSync(join(outputRoot, "bot/src"), { recursive: true, mode: 0o700 });
      mkdirSync(join(outputRoot, "bot/scripts"), { recursive: true, mode: 0o700 });
      await this.services.build(join(sourceRoot, "bot/src/index.ts"), join(outputRoot, "bot/src"));
      copyFileSync(
        join(sourceRoot, "bot/src/codex-app-server-bridge.mjs"),
        join(outputRoot, "bot/src/codex-app-server-bridge.mjs"),
      );
      copyFileSync(
        join(sourceRoot, "bot/scripts/rename-exchange.py"),
        join(outputRoot, "bot/scripts/rename-exchange.py"),
      );
      const runtimeDigest = releaseFileSetDigest(outputRoot, RUNTIME_FILES);
      const compatibilityDigest = releaseFileSetDigest(sourceRoot, COMPATIBILITY_FILES);
      const files = Object.fromEntries(RUNTIME_FILES.map((path) => [path, digest(readFileSync(join(outputRoot, path)))]));
      const unsigned = {
        format: 1 as const,
        git_commit: gitCommit,
        source_tree_digest: sourceTreeDigest,
        runtime_digest: runtimeDigest,
        compatibility_digest: compatibilityDigest,
        files,
      };
      const artifactDigest = digest(JSON.stringify(unsigned));
      const manifest: ReleaseManifest = { ...unsigned, artifact_digest: artifactDigest };
      writeFileSync(join(outputRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o444 });
      const artifactPath = join(this.environment.releaseRoot, "releases", artifactDigest);
      mkdirSync(dirname(artifactPath), { recursive: true, mode: 0o755 });
      if (existsSync(artifactPath)) {
        const existing = this.verify(artifactPath);
        if (existing.git_commit !== gitCommit || existing.source_tree_digest !== sourceTreeDigest) {
          throw new Error("Existing release digest does not match the prepared source.");
        }
      } else {
        makeReadOnly(outputRoot);
        renameSync(outputRoot, artifactPath);
      }
      return { artifactPath, manifest: this.verify(artifactPath) };
    } finally {
      if (existsSync(stagingRoot)) rmSync(stagingRoot, { recursive: true, force: true });
    }
  }

  verify(artifactPath: string): ReleaseManifest {
    const canonical = realpathSync(artifactPath);
    assertInside(join(this.environment.releaseRoot, "releases"), canonical);
    const files = listRegularFiles(canonical);
    const expectedFiles = [...RUNTIME_FILES, "manifest.json"].sort();
    if (JSON.stringify(files) !== JSON.stringify(expectedFiles)) {
      throw new Error(`Release artifact file set is invalid: ${files.join(", ")}`);
    }
    const manifest = JSON.parse(readFileSync(join(canonical, "manifest.json"), "utf8")) as ReleaseManifest;
    assertCommit(manifest.git_commit);
    for (const [value, label] of [
      [manifest.source_tree_digest, "source tree digest"],
      [manifest.runtime_digest, "runtime digest"],
      [manifest.compatibility_digest, "compatibility digest"],
      [manifest.artifact_digest, "artifact digest"],
    ] as Array<[unknown, string]>) assertDigest(value, label);
    for (const path of RUNTIME_FILES) {
      assertDigest(manifest.files?.[path], `file digest for ${path}`);
      if (digest(readFileSync(join(canonical, path))) !== manifest.files[path]) {
        throw new Error(`Release file digest is invalid for ${path}.`);
      }
    }
    if (releaseFileSetDigest(canonical, RUNTIME_FILES) !== manifest.runtime_digest) {
      throw new Error("Release runtime digest is invalid.");
    }
    const { artifact_digest: _artifactDigest, ...unsigned } = manifest;
    if (digest(JSON.stringify(unsigned)) !== manifest.artifact_digest) {
      throw new Error("Release manifest digest is invalid.");
    }
    if (canonical !== join(this.environment.releaseRoot, "releases", manifest.artifact_digest)) {
      throw new Error("Release directory name does not match its manifest digest.");
    }
    return manifest;
  }

  currentArtifactPath(): string | null {
    const current = join(this.environment.releaseRoot, "current");
    if (!existsSync(current)) return null;
    if (!lstatSync(current).isSymbolicLink()) throw new Error("Stable release pointer is not a symlink.");
    const path = resolve(this.environment.releaseRoot, readlinkSync(current));
    this.verify(path);
    return realpathSync(path);
  }

  activate(artifactPath: string) {
    const canonical = realpathSync(artifactPath);
    const manifest = this.verify(canonical);
    mkdirSync(this.environment.releaseRoot, { recursive: true, mode: 0o755 });
    const temporary = join(this.environment.releaseRoot, `.current-${randomUUID()}`);
    symlinkSync(relative(this.environment.releaseRoot, canonical), temporary);
    renameSync(temporary, join(this.environment.releaseRoot, "current"));
    const proven = this.currentArtifactPath();
    if (proven !== canonical) throw new Error("Stable release pointer did not activate the requested artifact.");
    return manifest;
  }
}
