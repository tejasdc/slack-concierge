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
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import BUILT_IN_DECLARATION from "./deployment-artifact-files.json";

export interface ReleaseManifest {
  format: 2;
  git_commit: string;
  control_git_commit: string;
  source_tree_digest: string;
  control_source_tree_digest: string;
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
  build(entrypoint: string, outputFile: string, target?: "bun" | "node"): Promise<void>;
}

const APPLICATION_FILES = [
  "bot/src/index.js",
  "bot/src/codex-app-server-bridge.mjs",
  "bot/scripts/rename-exchange.py",
];

// What goes into a release's control directory is declared once, in
// deployment-artifact-files.json, and read from the source being packaged — never from the
// code doing the packaging. The two differ during every rollout (the running control builds
// the next candidate), and on September 21, 2026 that difference stranded deployments: the
// running control's older list left a newly added file out of a release whose own code
// required it, so the release could not verify itself and every later deploy refused to run.
// See docs/architecture/DEPLOYMENT-REPAIR.md, "Artifact contents".

interface ArtifactDeclaration {
  controlBundles: Record<string, string>;
  controlFiles: Record<string, string>;
}

function checkedDeclaration(value: unknown, label: string): ArtifactDeclaration {
  const candidate = value as { format?: unknown; controlBundles?: unknown; controlFiles?: unknown } | null;
  if (!candidate || candidate.format !== 1) throw new Error(`${label} has an unsupported format.`);
  const table = (entries: unknown, name: string, sourcePattern: RegExp) => {
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw new Error(`${label} ${name} is not a table.`);
    const result: Record<string, string> = {};
    for (const [destination, source] of Object.entries(entries as Record<string, unknown>)) {
      if (!/^control\/[A-Za-z0-9@._\/-]+$/.test(destination) || destination.includes("..")
        || typeof source !== "string" || source.includes("..") || source.startsWith("/") || !sourcePattern.test(source)) {
        throw new Error(`${label} ${name} entry ${destination} is not a safe release path.`);
      }
      result[destination] = source;
    }
    return result;
  };
  return {
    controlBundles: table(candidate.controlBundles, "controlBundles", /^bot\/[A-Za-z0-9._\/-]+\.ts$/),
    controlFiles: table(candidate.controlFiles, "controlFiles", /^[A-Za-z0-9._\/@-]+$/),
  };
}

const BUILT_IN = checkedDeclaration(BUILT_IN_DECLARATION, "Built-in artifact declaration");

// A source that predates the declaration file (an old commit being rebuilt) uses this code's list.
function declarationFor(controlSourceRoot: string): ArtifactDeclaration {
  const path = join(controlSourceRoot, "bot/src/deployment-artifact-files.json");
  if (!existsSync(path)) return BUILT_IN;
  return checkedDeclaration(JSON.parse(readFileSync(path, "utf8")), "Candidate artifact declaration");
}

function runtimeFilesFor(declaration: ArtifactDeclaration) {
  return [
    ...APPLICATION_FILES,
    "control/codex-app-server-bridge.mjs",
    ...Object.keys(declaration.controlBundles),
    ...Object.keys(declaration.controlFiles),
  ].sort();
}

// The stable launcher runs these by name; a release without them could not deploy or repair.
const LAUNCHER_ENTRYPOINTS = ["control/deploy.sh", "control/deployment-repair.js", "control/release-manager.js"];

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
    async build(entrypoint, outputFile, target = "bun") {
      const result = await Bun.build({
        entrypoints: [entrypoint],
        target,
        format: target === "node" ? "esm" : undefined,
        outdir: dirname(outputFile),
        naming: basename(outputFile),
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

  installRuntime(launcherSource: string, controlLauncherSource: string) {
    mkdirSync(this.environment.installRoot, { recursive: true, mode: 0o755 });
    const bunDestination = join(this.environment.installRoot, "bun");
    const launcherDestination = join(this.environment.installRoot, "launch");
    const controlDestination = join(this.environment.installRoot, "control");
    const temporaryBun = `${bunDestination}.${process.pid}.tmp`;
    const temporaryLauncher = `${launcherDestination}.${process.pid}.tmp`;
    const temporaryControl = `${controlDestination}.${process.pid}.tmp`;
    copyFileSync(realpathSync(this.environment.bunExecutable), temporaryBun);
    copyFileSync(launcherSource, temporaryLauncher);
    copyFileSync(controlLauncherSource, temporaryControl);
    chmodSync(temporaryBun, 0o555);
    chmodSync(temporaryLauncher, 0o555);
    chmodSync(temporaryControl, 0o555);
    renameSync(temporaryBun, bunDestination);
    renameSync(temporaryLauncher, launcherDestination);
    renameSync(temporaryControl, controlDestination);
  }

  async prepare(attemptId: string, gitCommit: string, controlGitCommit = gitCommit): Promise<PreparedRelease> {
    assertCommit(gitCommit);
    assertCommit(controlGitCommit);
    if (!/^[0-9a-z-]{8,100}$/.test(attemptId)) throw new Error("Release attempt identity is invalid.");
    const stagingRoot = join(this.environment.releaseRoot, "staging", `${attemptId}-${randomUUID()}`);
    const sourceRoot = join(stagingRoot, "source");
    const controlSourceRoot = join(stagingRoot, "control-source");
    const outputRoot = join(stagingRoot, "release");
    mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
    mkdirSync(controlSourceRoot, { recursive: true, mode: 0o700 });
    mkdirSync(outputRoot, { recursive: true, mode: 0o700 });

    try {
      const extractCommit = (commit: string, destination: string) => {
        const archive = this.services.spawn([
          "/usr/bin/git", "-C", this.environment.repositoryRoot, "archive", "--format=tar", commit,
        ]);
        if (archive.exitCode !== 0) {
          throw new Error(`Git archive failed for ${commit}: ${Buffer.from(archive.stderr).toString("utf8").slice(0, 1000)}`);
        }
        const extracted = this.services.spawn(["/usr/bin/tar", "-xf", "-", "-C", destination], { stdin: archive.stdout });
        if (extracted.exitCode !== 0) {
          throw new Error(`Release extraction failed for ${commit}: ${Buffer.from(extracted.stderr).toString("utf8").slice(0, 1000)}`);
        }
        return digest(archive.stdout);
      };
      const sourceTreeDigest = extractCommit(gitCommit, sourceRoot);
      const controlSourceTreeDigest = controlGitCommit === gitCommit
        ? sourceTreeDigest
        : extractCommit(controlGitCommit, controlSourceRoot);
      const effectiveControlSourceRoot = controlGitCommit === gitCommit ? sourceRoot : controlSourceRoot;
      const dependencyRoot = realpathSync(join(this.environment.repositoryRoot, "bot/node_modules"));
      symlinkSync(dependencyRoot, join(sourceRoot, "bot/node_modules"), "dir");
      if (effectiveControlSourceRoot !== sourceRoot) {
        symlinkSync(dependencyRoot, join(effectiveControlSourceRoot, "bot/node_modules"), "dir");
      }
      mkdirSync(join(outputRoot, "bot/src"), { recursive: true, mode: 0o700 });
      mkdirSync(join(outputRoot, "bot/scripts"), { recursive: true, mode: 0o700 });
      mkdirSync(join(outputRoot, "control"), { recursive: true, mode: 0o700 });
      await this.services.build(join(sourceRoot, "bot/src/index.ts"), join(outputRoot, "bot/src/index.js"));
      await this.services.build(
        join(sourceRoot, "bot/src/codex-app-server-bridge.mjs"),
        join(outputRoot, "bot/src/codex-app-server-bridge.mjs"),
        "node",
      );
      const declaration = declarationFor(effectiveControlSourceRoot);
      const runtimeFiles = runtimeFilesFor(declaration);
      for (const [destination, source] of Object.entries(declaration.controlBundles)) {
        mkdirSync(dirname(join(outputRoot, destination)), { recursive: true, mode: 0o700 });
        await this.services.build(join(effectiveControlSourceRoot, source), join(outputRoot, destination));
      }
      for (const [destination, source] of Object.entries(declaration.controlFiles)) {
        mkdirSync(dirname(join(outputRoot, destination)), { recursive: true, mode: 0o700 });
        copyFileSync(join(effectiveControlSourceRoot, source), join(outputRoot, destination));
      }
      await this.services.build(
        join(effectiveControlSourceRoot, "bot/src/codex-app-server-bridge.mjs"),
        join(outputRoot, "control/codex-app-server-bridge.mjs"),
        "node",
      );
      copyFileSync(
        join(sourceRoot, "bot/scripts/rename-exchange.py"),
        join(outputRoot, "bot/scripts/rename-exchange.py"),
      );
      const runtimeDigest = releaseFileSetDigest(outputRoot, runtimeFiles);
      const compatibilityDigest = releaseFileSetDigest(sourceRoot, COMPATIBILITY_FILES);
      const files = Object.fromEntries(runtimeFiles.map((path) => [path, digest(readFileSync(join(outputRoot, path)))]));
      const unsigned = {
        format: 2 as const,
        git_commit: gitCommit,
        control_git_commit: controlGitCommit,
        source_tree_digest: sourceTreeDigest,
        control_source_tree_digest: controlSourceTreeDigest,
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
        if (existing.git_commit !== gitCommit
          || existing.control_git_commit !== controlGitCommit
          || existing.source_tree_digest !== sourceTreeDigest
          || existing.control_source_tree_digest !== controlSourceTreeDigest) {
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
    // Checked against the file list sealed in its own manifest, not against this code's current
    // list: a release stays valid when later code adds or removes files. The manifest cannot be
    // altered without changing its digest, which is also the directory's name.
    const manifest = JSON.parse(readFileSync(join(canonical, "manifest.json"), "utf8")) as ReleaseManifest;
    if (manifest.format !== 2) throw new Error("Release manifest format is unsupported.");
    if (!manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) {
      throw new Error("Release manifest has no file list.");
    }
    const sealedFiles = Object.keys(manifest.files).sort();
    for (const path of sealedFiles) {
      if (path === "manifest.json" || path.startsWith("/") || path.split("/").includes("..")) {
        throw new Error(`Release manifest lists an unsafe path ${path}.`);
      }
    }
    for (const path of LAUNCHER_ENTRYPOINTS) {
      if (!sealedFiles.includes(path)) throw new Error(`Release is missing launcher entrypoint ${path}.`);
    }
    const files = listRegularFiles(canonical);
    const expectedFiles = [...sealedFiles, "manifest.json"].sort();
    if (JSON.stringify(files) !== JSON.stringify(expectedFiles)) {
      throw new Error(`Release artifact file set does not match its manifest: ${files.join(", ")}`);
    }
    assertCommit(manifest.git_commit);
    assertCommit(manifest.control_git_commit);
    for (const [value, label] of [
      [manifest.source_tree_digest, "source tree digest"],
      [manifest.control_source_tree_digest, "control source tree digest"],
      [manifest.runtime_digest, "runtime digest"],
      [manifest.compatibility_digest, "compatibility digest"],
      [manifest.artifact_digest, "artifact digest"],
    ] as Array<[unknown, string]>) assertDigest(value, label);
    for (const path of sealedFiles) {
      assertDigest(manifest.files[path], `file digest for ${path}`);
      if (digest(readFileSync(join(canonical, path))) !== manifest.files[path]) {
        throw new Error(`Release file digest is invalid for ${path}.`);
      }
    }
    if (releaseFileSetDigest(canonical, sealedFiles) !== manifest.runtime_digest) {
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

  controlArtifactPath(): string | null {
    const control = join(this.environment.releaseRoot, "control");
    if (!existsSync(control)) return null;
    if (!lstatSync(control).isSymbolicLink()) throw new Error("Stable control pointer is not a symlink.");
    const path = resolve(this.environment.releaseRoot, readlinkSync(control));
    this.verify(path);
    return realpathSync(path);
  }

  activateControl(artifactPath: string) {
    const canonical = realpathSync(artifactPath);
    const manifest = this.verify(canonical);
    mkdirSync(this.environment.releaseRoot, { recursive: true, mode: 0o755 });
    const temporary = join(this.environment.releaseRoot, `.control-${randomUUID()}`);
    symlinkSync(relative(this.environment.releaseRoot, canonical), temporary);
    renameSync(temporary, join(this.environment.releaseRoot, "control"));
    const proven = this.controlArtifactPath();
    if (proven !== canonical) throw new Error("Stable control pointer did not activate the requested artifact.");
    return manifest;
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

  restore(artifactPath: string) {
    const manifest = this.activate(artifactPath);
    this.activateControl(artifactPath);
    return manifest;
  }
}
