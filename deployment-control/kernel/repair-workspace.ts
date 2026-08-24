import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  chownSync,
  existsSync,
  lchownSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { dirname, join, relative, resolve, sep } from "node:path";
import { inspectReleaseTree } from "./releases";

interface SpawnResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export interface RepairWorkspaceEnvironment {
  repositoryRoot: string;
  workerRoot: string;
  controlRoot: string;
  runtimeRoot: string;
  providerAdapterSocket: string;
  providerAdapterPort: number;
  repairUser: string;
  repairGroup: string;
  systemctlBin: string;
}

export interface RepairWorkspaceServices {
  spawn(command: string[], options?: { cwd?: string; stdin?: Uint8Array; env?: Record<string, string> }): SpawnResult;
  resolveIdentity(user: string, group: string): { uid: number; gid: number };
  now(): number;
}

export interface PreparedRepairWorkspace {
  incidentId: string;
  baseCommit: string;
  baselineLocalCommit: string;
  repositoryPath: string;
  evidenceDigest: string;
  capability: string;
  capabilityDigest: string;
  capabilityExpiresAtMs: number;
  workerUnit: string;
  controlPath: string;
}

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function assertIncidentId(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("Repair incident identity must be a UUID.");
  }
}

function assertCommit(value: string) {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error("Repair base must be a full lowercase Git SHA.");
}

function normalizeOwnedTree(path: string, uid: number, gid: number) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    lchownSync(path, uid, gid);
    return;
  }
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) normalizeOwnedTree(join(path, entry), uid, gid);
    chownSync(path, uid, gid);
    chmodSync(path, 0o700);
    return;
  }
  if (!stat.isFile()) throw new Error(`Repair materialization contains special file ${path}.`);
  chownSync(path, uid, gid);
  chmodSync(path, stat.mode & 0o111 ? 0o700 : 0o600);
}

function treeDigest(root: string, directory = root, hash = createHash("sha256")) {
  const entries = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => !(directory === root && entry.name === ".git"))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const normalized = relative(root, path).split(sep).join("/");
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(path);
      hash.update(`link\0${normalized}\0${Buffer.byteLength(target)}\0${target}`);
      continue;
    }
    if (stat.isDirectory()) {
      treeDigest(root, path, hash);
      continue;
    }
    if (!stat.isFile()) throw new Error(`Repair repository contains special file ${path}.`);
    const contents = readFileSync(path);
    hash.update(`file\0${normalized}\0${stat.mode & 0o111 ? "x" : "-"}\0${contents.byteLength}\0`);
    hash.update(contents);
  }
  return hash;
}

export function repairTreeDigest(root: string) {
  return treeDigest(realpathSync(root)).digest("hex");
}

function defaultServices(): RepairWorkspaceServices {
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
      const groupRecord = Bun.spawnSync({ cmd: ["/usr/bin/getent", "group", group], stdout: "pipe", stderr: "pipe" });
      if (uid.exitCode !== 0 || groupRecord.exitCode !== 0) throw new Error("Repair worker identity is unavailable.");
      const numericUid = Number(uid.stdout.toString().trim());
      const numericGid = Number(groupRecord.stdout.toString().trim().split(":")[2]);
      if (!Number.isSafeInteger(numericUid) || !Number.isSafeInteger(numericGid)) {
        throw new Error("Repair worker identity is invalid.");
      }
      return { uid: numericUid, gid: numericGid };
    },
    now: () => Date.now(),
  };
}

function commandError(label: string, result: SpawnResult) {
  return new Error(`${label}: ${Buffer.from(result.stderr).toString("utf8").slice(0, 2000)}`);
}

export class RepairWorkspaceManager {
  constructor(
    readonly environment: RepairWorkspaceEnvironment,
    readonly services: RepairWorkspaceServices = defaultServices(),
  ) {}

  private loadControl(incidentId: string, incidentControlRoot: string): PreparedRepairWorkspace {
    const incidentWorkerRoot = join(this.environment.workerRoot, incidentId);
    const metadata = JSON.parse(readFileSync(join(incidentControlRoot, "metadata.json"), "utf8"));
    const repositoryPath = join(incidentWorkerRoot, "repository");
    if (metadata.incident_id !== incidentId || metadata.repository_path !== repositoryPath) {
      throw new Error("Existing repair workspace identity does not match the incident.");
    }
    this.assertRepositoryPath(incidentId, repositoryPath);
    const capability = readFileSync(join(incidentControlRoot, "provider.cap"), "utf8").trim();
    return {
      incidentId,
      baseCommit: metadata.base_commit,
      baselineLocalCommit: metadata.baseline_local_commit,
      repositoryPath,
      evidenceDigest: metadata.evidence_digest,
      capability,
      capabilityDigest: sha256(capability),
      capabilityExpiresAtMs: metadata.capability_expires_at_ms,
      workerUnit: metadata.worker_unit,
      controlPath: incidentControlRoot,
    };
  }

  load(incidentId: string): PreparedRepairWorkspace {
    assertIncidentId(incidentId);
    return this.loadControl(incidentId, join(this.environment.controlRoot, incidentId, "repair"));
  }

  private assertRepositoryPath(incidentId: string, repositoryPath: string) {
    const expected = resolve(this.environment.workerRoot, incidentId, "repository");
    if (resolve(repositoryPath) !== expected) throw new Error("Repair repository path escaped its incident root.");
    const repository = lstatSync(repositoryPath);
    const gitDirectory = lstatSync(join(repositoryPath, ".git"));
    if (!repository.isDirectory() || repository.isSymbolicLink()
      || !gitDirectory.isDirectory() || gitDirectory.isSymbolicLink()
      || realpathSync(repositoryPath) !== expected) {
      throw new Error("Repair repository must be the exact standalone incident directory.");
    }
  }

  runIsolatedGit(incidentId: string, args: string[]) {
    assertIncidentId(incidentId);
    const repositoryPath = join(this.environment.workerRoot, incidentId, "repository");
    this.assertRepositoryPath(incidentId, repositoryPath);
    const identity = this.services.resolveIdentity(this.environment.repairUser, this.environment.repairGroup);
    const command = [
      "/usr/bin/bwrap",
      "--unshare-all",
      "--die-with-parent",
      "--new-session",
      "--ro-bind", "/usr", "/usr",
      "--ro-bind", "/lib", "/lib",
      ...(existsSync("/lib64") ? ["--ro-bind", "/lib64", "/lib64"] : []),
      "--proc", "/proc",
      "--dev", "/dev",
      "--tmpfs", "/tmp",
      "--ro-bind", repositoryPath, repositoryPath,
      "--chdir", repositoryPath,
      "--setenv", "HOME", "/tmp",
      "--setenv", "PATH", "/usr/bin:/bin",
      "--setenv", "GIT_CONFIG_NOSYSTEM", "1",
      "--setenv", "GIT_OPTIONAL_LOCKS", "0",
      "--uid", String(identity.uid),
      "--gid", String(identity.gid),
      "/usr/bin/git",
      "-c", "core.hooksPath=/dev/null",
      "-c", "core.fsmonitor=false",
      "-c", "diff.external=",
      "-c", "credential.helper=",
      ...args,
    ];
    return this.services.spawn(command, { env: {} });
  }

  private workerCommand(identity: { uid: number; gid: number }, home: string, args: string[]) {
    return [
      "/usr/bin/setpriv",
      `--reuid=${identity.uid}`,
      `--regid=${identity.gid}`,
      "--clear-groups",
      "/usr/bin/env",
      "-i",
      `HOME=${home}`,
      "PATH=/usr/bin:/bin",
      "GIT_CONFIG_NOSYSTEM=1",
      ...args,
    ];
  }

  prepare(input: {
    incidentId: string;
    baseCommit: string;
    evidence: Record<string, unknown>;
    charter: string;
    model: string;
    reasoningEffort: string;
    refresh?: boolean;
  }): PreparedRepairWorkspace {
    assertIncidentId(input.incidentId);
    assertCommit(input.baseCommit);
    if (!/^gpt-[A-Za-z0-9.-]+$/.test(input.model)) throw new Error("Repair model is invalid.");
    if (!new Set(["low", "medium", "high", "xhigh"]).has(input.reasoningEffort)) {
      throw new Error("Repair reasoning effort is invalid.");
    }
    const identity = this.services.resolveIdentity(this.environment.repairUser, this.environment.repairGroup);
    const incidentWorkerRoot = join(this.environment.workerRoot, input.incidentId);
    const incidentControlRoot = join(this.environment.controlRoot, input.incidentId, "repair");
    const repositoryPath = join(incidentWorkerRoot, "repository");
    const codexHome = join(incidentWorkerRoot, "codex");
    const existingMetadata = join(incidentControlRoot, "metadata.json");
    if (existsSync(existingMetadata)) {
      const prepared = this.load(input.incidentId);
      const metadata = JSON.parse(readFileSync(existingMetadata, "utf8"));
      if (metadata.incident_id !== input.incidentId || metadata.repository_path !== repositoryPath) {
        throw new Error("Existing repair workspace identity does not match the incident.");
      }
      if (!input.refresh) {
        if (metadata.base_commit !== input.baseCommit) {
          throw new Error("Existing repair workspace base changed without an authorized refresh.");
        }
        return prepared;
      }
      const active = this.services.spawn([this.environment.systemctlBin, "is-active", prepared.workerUnit]);
      if (active.exitCode === 0) throw new Error("Repair workspace cannot refresh while its worker unit is active.");
      const refreshRoot = join(incidentWorkerRoot, `.refresh-${randomBytes(8).toString("hex")}`);
      const stagedRepository = join(refreshRoot, "repository");
      mkdirSync(stagedRepository, { recursive: true, mode: 0o700 });
      try {
        const archive = this.services.spawn([
          "/usr/bin/git", "-C", this.environment.repositoryRoot, "archive", "--format=tar", input.baseCommit,
        ]);
        if (archive.exitCode !== 0) throw commandError("Repair refresh base archive failed", archive);
        const extracted = this.services.spawn(["/usr/bin/tar", "-xf", "-", "-C", stagedRepository], {
          stdin: archive.stdout,
        });
        if (extracted.exitCode !== 0) throw commandError("Repair refresh base extraction failed", extracted);
        inspectReleaseTree(stagedRepository, { allowSymlinks: true });
        normalizeOwnedTree(stagedRepository, identity.uid, identity.gid);
        const git = (args: string[]) => this.services.spawn(this.workerCommand(identity, join(incidentWorkerRoot, "home"), [
          "/usr/bin/git", "-c", "core.hooksPath=/dev/null", "-C", stagedRepository, ...args,
        ]));
        for (const [label, args] of [
          ["init", ["init", "--initial-branch=repair"]],
          ["disable hooks", ["config", "core.hooksPath", "/dev/null"]],
          ["user name", ["config", "user.name", "Concierge Deployment Repair"]],
          ["user email", ["config", "user.email", "deployment-repair@localhost"]],
          ["stage", ["add", "--all"]],
          ["baseline commit", ["commit", "--no-gpg-sign", "-m", `Incident refresh base ${input.baseCommit}`]],
        ] as Array<[string, string[]]>) {
          const result = git(args);
          if (result.exitCode !== 0) throw commandError(`Repair refresh repository ${label} failed`, result);
        }
        const baseline = git(["rev-parse", "HEAD"]);
        if (baseline.exitCode !== 0) throw commandError("Repair refresh baseline lookup failed", baseline);
        const baselineLocalCommit = baseline.stdout.toString().trim().toLowerCase();
        assertCommit(baselineLocalCommit);

        const evidenceJson = `${JSON.stringify(input.evidence, null, 2)}\n`;
        const evidenceDigest = sha256(evidenceJson);
        const capability = randomBytes(32).toString("base64url");
        const capabilityExpiresAtMs = this.services.now() + 24 * 60 * 60 * 1000;
        const prompt = `${input.charter.trim()}\n\n## Refreshed incident packet\n\n${evidenceJson}`;
        const metadata = {
          format: 1,
          incident_id: input.incidentId,
          base_commit: input.baseCommit,
          baseline_local_commit: baselineLocalCommit,
          repository_path: repositoryPath,
          evidence_digest: evidenceDigest,
          capability_expires_at_ms: capabilityExpiresAtMs,
          worker_unit: prepared.workerUnit,
        };
        const swapToken = randomBytes(8).toString("hex");
        const refreshedControl = join(dirname(incidentControlRoot), `.repair-refreshed-${swapToken}`);
        const previousControl = join(dirname(incidentControlRoot), `.repair-previous-${swapToken}`);
        mkdirSync(refreshedControl, { mode: 0o750 });
        chownSync(refreshedControl, 0, identity.gid);
        for (const [name, contents] of [
          ["evidence.json", evidenceJson],
          ["prompt.md", prompt],
          ["provider.cap", `${capability}\n`],
          ["metadata.json", `${JSON.stringify(metadata, null, 2)}\n`],
        ]) {
          const path = join(refreshedControl, name);
          writeFileSync(path, contents, { mode: 0o440 });
          chownSync(path, 0, identity.gid);
          chmodSync(path, 0o440);
        }
        const previousRepository = join(incidentWorkerRoot, `.repository-previous-${swapToken}`);
        renameSync(incidentControlRoot, previousControl);
        try {
          renameSync(refreshedControl, incidentControlRoot);
        } catch (error) {
          renameSync(previousControl, incidentControlRoot);
          if (existsSync(refreshedControl)) rmSync(refreshedControl, { recursive: true, force: true });
          throw error;
        }
        try {
          renameSync(repositoryPath, previousRepository);
          renameSync(stagedRepository, repositoryPath);
        } catch (error) {
          if (existsSync(previousRepository) && !existsSync(repositoryPath)) {
            renameSync(previousRepository, repositoryPath);
          }
          renameSync(incidentControlRoot, refreshedControl);
          renameSync(previousControl, incidentControlRoot);
          rmSync(refreshedControl, { recursive: true, force: true });
          throw error;
        }
        rmSync(previousRepository, { recursive: true, force: true });
        rmSync(previousControl, { recursive: true, force: true });
        return {
          incidentId: input.incidentId,
          baseCommit: input.baseCommit,
          baselineLocalCommit,
          repositoryPath,
          evidenceDigest,
          capability,
          capabilityDigest: sha256(capability),
          capabilityExpiresAtMs,
          workerUnit: prepared.workerUnit,
          controlPath: incidentControlRoot,
        };
      } finally {
        if (existsSync(refreshRoot)) rmSync(refreshRoot, { recursive: true, force: true });
      }
    }

    mkdirSync(this.environment.workerRoot, { recursive: true, mode: 0o711 });
    mkdirSync(this.environment.controlRoot, { recursive: true, mode: 0o700 });
    const workerStaging = join(this.environment.workerRoot, `.staging-${input.incidentId}`);
    const controlStaging = join(this.environment.controlRoot, `.staging-repair-${input.incidentId}`);
    if (existsSync(workerStaging) || existsSync(controlStaging)) {
      throw new Error("Repair workspace staging already exists.");
    }
    mkdirSync(workerStaging, { mode: 0o700 });
    mkdirSync(controlStaging, { recursive: true, mode: 0o700 });
    try {
      const stagedRepository = join(workerStaging, "repository");
      const stagedCodexHome = join(workerStaging, "codex");
      const workerHome = join(workerStaging, "home");
      mkdirSync(stagedRepository, { mode: 0o700 });
      mkdirSync(stagedCodexHome, { mode: 0o700 });
      mkdirSync(workerHome, { mode: 0o700 });
      const archive = this.services.spawn([
        "/usr/bin/git", "-C", this.environment.repositoryRoot, "archive", "--format=tar", input.baseCommit,
      ]);
      if (archive.exitCode !== 0) throw commandError("Repair base archive failed", archive);
      const extracted = this.services.spawn(["/usr/bin/tar", "-xf", "-", "-C", stagedRepository], { stdin: archive.stdout });
      if (extracted.exitCode !== 0) throw commandError("Repair base extraction failed", extracted);
      inspectReleaseTree(stagedRepository, { allowSymlinks: true });
      normalizeOwnedTree(workerStaging, identity.uid, identity.gid);
      const git = (args: string[]) => this.services.spawn(this.workerCommand(identity, workerHome, [
        "/usr/bin/git", "-c", "core.hooksPath=/dev/null", "-C", stagedRepository, ...args,
      ]));
      for (const [label, args] of [
        ["init", ["init", "--initial-branch=repair"]],
        ["disable hooks", ["config", "core.hooksPath", "/dev/null"]],
        ["user name", ["config", "user.name", "Concierge Deployment Repair"]],
        ["user email", ["config", "user.email", "deployment-repair@localhost"]],
        ["stage", ["add", "--all"]],
        ["baseline commit", ["commit", "--no-gpg-sign", "-m", `Incident base ${input.baseCommit}`]],
      ] as Array<[string, string[]]>) {
        const result = git(args);
        if (result.exitCode !== 0) throw commandError(`Repair repository ${label} failed`, result);
      }
      const baseline = git(["rev-parse", "HEAD"]);
      if (baseline.exitCode !== 0) throw commandError("Repair baseline lookup failed", baseline);
      const baselineLocalCommit = Buffer.from(baseline.stdout).toString("utf8").trim().toLowerCase();
      assertCommit(baselineLocalCommit);

      const evidenceJson = `${JSON.stringify(input.evidence, null, 2)}\n`;
      const evidenceDigest = sha256(evidenceJson);
      const capability = randomBytes(32).toString("base64url");
      const capabilityExpiresAtMs = this.services.now() + 24 * 60 * 60 * 1000;
      const workerUnit = `concierge-deployment-repair@${input.incidentId}.service`;
      const prompt = `${input.charter.trim()}\n\n## Incident packet\n\n${evidenceJson}`;
      const config = [
        `model = ${JSON.stringify(input.model)}`,
        `model_reasoning_effort = ${JSON.stringify(input.reasoningEffort)}`,
        'model_provider = "deployment-repair"',
        'approval_policy = "never"',
        'default_permissions = "deployment-repair"',
        'web_search = "disabled"',
        '',
        '[model_providers.deployment-repair]',
        'name = "Deployment Repair Credential Adapter"',
        `base_url = "http://127.0.0.1:${this.environment.providerAdapterPort}/incidents/${input.incidentId}/repair"`,
        'env_key = "CONCIERGE_PROVIDER_CAPABILITY"',
        'wire_api = "responses"',
        'request_max_retries = 0',
        'stream_max_retries = 0',
        '',
        '[permissions.deployment-repair.filesystem]',
        '":root" = "deny"',
        '":minimal" = "read"',
        `${JSON.stringify(join(this.environment.runtimeRoot, "codex"))} = "read"`,
        '":slash_tmp" = "write"',
        '":tmpdir" = "write"',
        '',
        '[permissions.deployment-repair.filesystem.":workspace_roots"]',
        '"." = "write"',
        '',
        '[permissions.deployment-repair.network]',
        'enabled = false',
        '',
        '[shell_environment_policy]',
        'inherit = "none"',
        'set = { PATH = "/usr/bin:/bin", HOME = "/tmp", GIT_CONFIG_NOSYSTEM = "1" }',
        '',
      ].join("\n");
      writeFileSync(join(stagedCodexHome, "config.toml"), config, { mode: 0o400 });
      chownSync(join(stagedCodexHome, "config.toml"), 0, identity.gid);
      chmodSync(join(stagedCodexHome, "config.toml"), 0o440);
      writeFileSync(join(controlStaging, "evidence.json"), evidenceJson, { mode: 0o400 });
      writeFileSync(join(controlStaging, "prompt.md"), prompt, { mode: 0o400 });
      writeFileSync(join(controlStaging, "provider.cap"), `${capability}\n`, { mode: 0o400 });
      const metadata = {
        format: 1,
        incident_id: input.incidentId,
        base_commit: input.baseCommit,
        baseline_local_commit: baselineLocalCommit,
        repository_path: repositoryPath,
        evidence_digest: evidenceDigest,
        capability_expires_at_ms: capabilityExpiresAtMs,
        worker_unit: workerUnit,
      };
      writeFileSync(join(controlStaging, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o400 });
      for (const path of [
        join(controlStaging, "evidence.json"),
        join(controlStaging, "prompt.md"),
        join(controlStaging, "provider.cap"),
        join(controlStaging, "metadata.json"),
      ]) {
        chownSync(path, 0, identity.gid);
        chmodSync(path, 0o440);
      }
      chmodSync(controlStaging, 0o750);
      chownSync(controlStaging, 0, identity.gid);
      mkdirSync(dirname(incidentWorkerRoot), { recursive: true, mode: 0o711 });
      const incidentControlParent = dirname(incidentControlRoot);
      mkdirSync(incidentControlParent, { recursive: true, mode: 0o700 });
      chownSync(incidentControlParent, 0, 0);
      chmodSync(incidentControlParent, 0o700);
      renameSync(workerStaging, incidentWorkerRoot);
      renameSync(controlStaging, incidentControlRoot);
      return {
        incidentId: input.incidentId,
        baseCommit: input.baseCommit,
        baselineLocalCommit,
        repositoryPath,
        evidenceDigest,
        capability,
        capabilityDigest: sha256(capability),
        capabilityExpiresAtMs,
        workerUnit,
        controlPath: incidentControlRoot,
      };
    } catch (error) {
      if (existsSync(workerStaging)) rmSync(workerStaging, { recursive: true, force: true });
      if (existsSync(controlStaging)) rmSync(controlStaging, { recursive: true, force: true });
      throw error;
    }
  }

  private capabilityRotationPaths(incidentId: string) {
    const controlPath = join(this.environment.controlRoot, incidentId, "repair");
    const parent = dirname(controlPath);
    return {
      controlPath,
      pendingPath: join(parent, `.repair-capability-pending-${incidentId}`),
      previousPath: join(parent, `.repair-capability-previous-${incidentId}`),
    };
  }

  prepareCapabilityRotation(incidentId: string) {
    assertIncidentId(incidentId);
    const paths = this.capabilityRotationPaths(incidentId);
    if (existsSync(paths.pendingPath)) return this.loadControl(incidentId, paths.pendingPath);
    const prepared = this.loadControl(incidentId, paths.controlPath);
    const active = this.services.spawn([this.environment.systemctlBin, "is-active", prepared.workerUnit]);
    if (active.exitCode === 0) throw new Error("Repair capability cannot rotate while its worker unit is active.");
    if (existsSync(paths.previousPath)) rmSync(paths.previousPath, { recursive: true, force: true });
    const identity = this.services.resolveIdentity(this.environment.repairUser, this.environment.repairGroup);
    const capability = randomBytes(32).toString("base64url");
    const capabilityExpiresAtMs = this.services.now() + 24 * 60 * 60 * 1000;
    const metadata = JSON.parse(readFileSync(join(prepared.controlPath, "metadata.json"), "utf8"));
    metadata.capability_expires_at_ms = capabilityExpiresAtMs;
    mkdirSync(paths.pendingPath, { mode: 0o750 });
    chownSync(paths.pendingPath, 0, identity.gid);
    try {
      const contents: Record<string, string> = {
        "evidence.json": readFileSync(join(prepared.controlPath, "evidence.json"), "utf8"),
        "prompt.md": readFileSync(join(prepared.controlPath, "prompt.md"), "utf8"),
        "provider.cap": `${capability}\n`,
        "metadata.json": `${JSON.stringify(metadata, null, 2)}\n`,
      };
      for (const [name, value] of Object.entries(contents)) {
        const path = join(paths.pendingPath, name);
        writeFileSync(path, value, { mode: 0o440 });
        chownSync(path, 0, identity.gid);
        chmodSync(path, 0o440);
      }
      return this.loadControl(incidentId, paths.pendingPath);
    } catch (error) {
      if (existsSync(paths.pendingPath)) rmSync(paths.pendingPath, { recursive: true, force: true });
      throw error;
    }
  }

  activateCapabilityRotation(incidentId: string, capabilityDigest: string) {
    assertIncidentId(incidentId);
    if (!/^[0-9a-f]{64}$/.test(capabilityDigest)) throw new Error("Pending repair capability digest is invalid.");
    const paths = this.capabilityRotationPaths(incidentId);
    if (existsSync(paths.controlPath)) {
      const current = this.loadControl(incidentId, paths.controlPath);
      if (current.capabilityDigest === capabilityDigest) return current;
      if (existsSync(paths.previousPath)) {
        throw new Error("Repair capability rotation has conflicting previous material.");
      }
      renameSync(paths.controlPath, paths.previousPath);
    }
    if (!existsSync(paths.previousPath) || !existsSync(paths.pendingPath)) {
      throw new Error("Repair capability rotation material is incomplete.");
    }
    const pending = this.loadControl(incidentId, paths.pendingPath);
    if (pending.capabilityDigest !== capabilityDigest) {
      throw new Error("Pending repair capability does not match durable rotation state.");
    }
    renameSync(paths.pendingPath, paths.controlPath);
    return this.loadControl(incidentId, paths.controlPath);
  }

  finishCapabilityRotation(incidentId: string, capabilityDigest: string) {
    const paths = this.capabilityRotationPaths(incidentId);
    const current = this.loadControl(incidentId, paths.controlPath);
    if (current.capabilityDigest !== capabilityDigest) {
      throw new Error("Activated repair capability does not match durable state.");
    }
    if (existsSync(paths.pendingPath)) rmSync(paths.pendingPath, { recursive: true, force: true });
    if (existsSync(paths.previousPath)) rmSync(paths.previousPath, { recursive: true, force: true });
    return current;
  }

  launch(workerUnit: string) {
    if (!/^concierge-deployment-repair@[0-9a-f-]{36}\.service$/i.test(workerUnit)) {
      throw new Error("Repair worker unit identity is invalid.");
    }
    const result = this.services.spawn([this.environment.systemctlBin, "start", "--no-block", workerUnit]);
    if (result.exitCode !== 0) throw commandError("Repair worker launch failed", result);
    return { worker_unit: workerUnit };
  }
}

export async function registerProviderCapability(input: {
  socketPath: string;
  incidentId: string;
  workerKind: "repair" | "review";
  capability: string;
  expiresAtMs: number;
  replace?: boolean;
  timeoutMs?: number;
}) {
  return await new Promise<Record<string, unknown>>((resolvePromise, reject) => {
    const socket = createConnection(input.socketPath);
    let response = "";
    let settled = false;
    const finish = (error?: Error, result?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolvePromise(result || {});
    };
    socket.setTimeout(input.timeoutMs || 5_000, () => finish(new Error("Provider adapter registration timed out.")));
    socket.on("connect", () => socket.write(`${JSON.stringify({
      command: input.replace ? "replace" : "register",
      incident_id: input.incidentId,
      worker_kind: input.workerKind,
      capability: input.capability,
      expires_at_ms: input.expiresAtMs,
    })}\n`));
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      const newline = response.indexOf("\n");
      if (newline < 0) return;
      try {
        const parsed = JSON.parse(response.slice(0, newline));
        if (!parsed.ok) finish(new Error(`Provider adapter rejected registration: ${parsed.error || "unknown"}`));
        else finish(undefined, parsed.result);
      } catch (error) {
        finish(new Error(`Provider adapter returned invalid JSON: ${String(error)}`));
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("end", () => {
      if (!settled) finish(new Error("Provider adapter closed without a response."));
    });
  });
}

export function defaultRepairWorkspaceEnvironment(repositoryRoot: string): RepairWorkspaceEnvironment {
  const runtimeRoot = process.env.CONCIERGE_DEPLOYMENT_RUNTIME_DIR || "/usr/local/lib/concierge-deployment";
  return {
    repositoryRoot,
    workerRoot: process.env.CONCIERGE_REPAIR_WORKER_ROOT || "/var/lib/concierge-repair/incidents",
    controlRoot: process.env.CONCIERGE_REPAIR_CONTROL_ROOT || "/var/lib/concierge-deployment/incidents",
    runtimeRoot,
    providerAdapterSocket: process.env.CONCIERGE_PROVIDER_ADAPTER_SOCKET
      || "/run/concierge-provider-adapter/adapter.sock",
    providerAdapterPort: Number(process.env.CONCIERGE_PROVIDER_ADAPTER_PORT || 41951),
    repairUser: "concierge-repair",
    repairGroup: "concierge-repair",
    systemctlBin: "/usr/bin/systemctl",
  };
}
