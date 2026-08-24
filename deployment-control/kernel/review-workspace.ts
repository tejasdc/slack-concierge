import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  chownSync,
  existsSync,
  lchownSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { inspectReleaseTree } from "./releases";

interface SpawnResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export interface ReviewWorkspaceEnvironment {
  workerRoot: string;
  controlRoot: string;
  runtimeRoot: string;
  providerAdapterSocket: string;
  providerAdapterPort: number;
  reviewUser: string;
  reviewGroup: string;
  systemctlBin: string;
}

export interface ReviewWorkspaceServices {
  spawn(command: string[], options?: { cwd?: string; stdin?: Uint8Array; env?: Record<string, string> }): SpawnResult;
  resolveIdentity(user: string, group: string): { uid: number; gid: number };
  now(): number;
}

export interface PreparedReviewWorkspace {
  reviewId: string;
  incidentId: string;
  repositoryPath: string;
  controlPath: string;
  capability: string;
  capabilityDigest: string;
  capabilityExpiresAtMs: number;
  workerUnit: string;
}

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function assertUuid(value: string, label: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${label} must be a UUID.`);
  }
}

function assertCommit(value: string, label: string) {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error(`${label} must be a full lowercase Git SHA.`);
}

function readOnlyTree(path: string, gid: number) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    lchownSync(path, 0, gid);
    return;
  }
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) readOnlyTree(join(path, entry), gid);
    chownSync(path, 0, gid);
    chmodSync(path, 0o550);
    return;
  }
  if (!stat.isFile()) throw new Error(`Review snapshot contains special file ${path}.`);
  chownSync(path, 0, gid);
  chmodSync(path, stat.mode & 0o111 ? 0o550 : 0o440);
}

function defaultServices(): ReviewWorkspaceServices {
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
      if (uid.exitCode !== 0 || groupRecord.exitCode !== 0) throw new Error("Review worker identity is unavailable.");
      return { uid: Number(uid.stdout.toString().trim()), gid: Number(groupRecord.stdout.toString().trim().split(":")[2]) };
    },
    now: () => Date.now(),
  };
}

function commandError(label: string, result: SpawnResult) {
  return new Error(`${label}: ${Buffer.from(result.stderr).toString("utf8").slice(0, 2000)}`);
}

export class ReviewWorkspaceManager {
  constructor(
    readonly environment: ReviewWorkspaceEnvironment,
    readonly services: ReviewWorkspaceServices = defaultServices(),
  ) {}

  prepare(input: {
    reviewId: string;
    incidentId: string;
    baseCommit: string;
    baselineLocalCommit: string;
    headCommit: string;
    treeDigest: string;
    policyDigest: string;
    enforcementDigest: string;
    evidenceDigest: string;
    repairResult: Record<string, unknown>;
    headArchive?: Uint8Array;
    exactPatch?: Uint8Array;
    charter: string;
    model: string;
    reasoningEffort: string;
    workerKind?: "incident" | "rollout";
  }): PreparedReviewWorkspace {
    assertUuid(input.reviewId, "Review identity");
    assertUuid(input.incidentId, "Review incident identity");
    assertCommit(input.baseCommit, "Review base");
    assertCommit(input.baselineLocalCommit, "Review local baseline");
    assertCommit(input.headCommit, "Review head");
    const identity = this.services.resolveIdentity(this.environment.reviewUser, this.environment.reviewGroup);
    const workerPath = join(this.environment.workerRoot, input.reviewId);
    const controlPath = join(this.environment.controlRoot, input.reviewId);
    const repositoryPath = join(workerPath, "repository");
    const metadataPath = join(controlPath, "metadata.json");
    if (existsSync(metadataPath)) {
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
      if (metadata.review_id !== input.reviewId || metadata.head_commit !== input.headCommit
        || metadata.repository_path !== repositoryPath) {
        throw new Error("Existing review workspace identity changed.");
      }
      const capability = readFileSync(join(controlPath, "provider.cap"), "utf8").trim();
      return {
        reviewId: input.reviewId,
        incidentId: input.incidentId,
        repositoryPath,
        controlPath,
        capability,
        capabilityDigest: sha256(capability),
        capabilityExpiresAtMs: metadata.capability_expires_at_ms,
        workerUnit: metadata.worker_unit,
      };
    }
    if (!input.headArchive || !input.exactPatch) {
      throw new Error("New review preparation requires a kernel-exported archive and exact patch.");
    }
    mkdirSync(this.environment.workerRoot, { recursive: true, mode: 0o711 });
    mkdirSync(this.environment.controlRoot, { recursive: true, mode: 0o700 });
    const workerStaging = join(this.environment.workerRoot, `.staging-${input.reviewId}`);
    const controlStaging = join(this.environment.controlRoot, `.staging-review-${input.reviewId}`);
    if (existsSync(workerStaging) || existsSync(controlStaging)) throw new Error("Review staging already exists.");
    mkdirSync(join(workerStaging, "repository"), { recursive: true, mode: 0o700 });
    mkdirSync(join(workerStaging, "codex"), { mode: 0o700 });
    mkdirSync(join(workerStaging, "home"), { mode: 0o700 });
    mkdirSync(join(workerStaging, "output"), { mode: 0o700 });
    mkdirSync(controlStaging, { mode: 0o700 });
    try {
      const stagedRepository = join(workerStaging, "repository");
      const extracted = this.services.spawn(["/usr/bin/tar", "-xf", "-", "-C", stagedRepository], {
        stdin: input.headArchive,
      });
      if (extracted.exitCode !== 0) throw commandError("Review snapshot extraction failed", extracted);
      inspectReleaseTree(stagedRepository, { allowSymlinks: true });
      readOnlyTree(stagedRepository, identity.gid);
      for (const directory of [
        join(workerStaging, "codex"),
        join(workerStaging, "home"),
        join(workerStaging, "output"),
      ]) {
        chownSync(directory, identity.uid, identity.gid);
        chmodSync(directory, 0o700);
      }
      chownSync(workerStaging, identity.uid, identity.gid);
      chmodSync(workerStaging, 0o700);
      const capability = randomBytes(32).toString("base64url");
      const capabilityExpiresAtMs = this.services.now() + 24 * 60 * 60 * 1000;
      const workerKind = input.workerKind || "incident";
      const workerUnit = workerKind === "rollout"
        ? `concierge-deployment-rollout-review@${input.reviewId}.service`
        : `concierge-deployment-review@${input.reviewId}.service`;
      const packet = {
        review_id: input.reviewId,
        incident_id: input.incidentId,
        base_commit: input.baseCommit,
        baseline_local_commit: input.baselineLocalCommit,
        head_commit: input.headCommit,
        tree_digest: input.treeDigest,
        policy_digest: input.policyDigest,
        enforcement_digest: input.enforcementDigest,
        evidence_digest: input.evidenceDigest,
        repair_result: input.repairResult,
      };
      const workerMetadata = {
        review_id: input.reviewId,
        incident_id: input.incidentId,
        repository_path: repositoryPath,
        worker_kind: workerKind,
      };
      writeFileSync(join(workerStaging, "metadata.json"), `${JSON.stringify(workerMetadata, null, 2)}\n`, { mode: 0o440 });
      chownSync(join(workerStaging, "metadata.json"), 0, identity.gid);
      const prompt = `${input.charter.trim()}\n\n## Immutable review packet\n\n${JSON.stringify(packet, null, 2)}\n\n## Exact patch\n\n${Buffer.from(input.exactPatch).toString("utf8")}`;
      const config = [
        `model = ${JSON.stringify(input.model)}`,
        `model_reasoning_effort = ${JSON.stringify(input.reasoningEffort)}`,
        'model_provider = "deployment-review"',
        'approval_policy = "never"',
        'default_permissions = "deployment-review"',
        'web_search = "disabled"',
        '',
        '[model_providers.deployment-review]',
        'name = "Deployment Review Credential Adapter"',
        `base_url = "http://127.0.0.1:${this.environment.providerAdapterPort}/incidents/${input.incidentId}/review"`,
        'env_key = "CONCIERGE_PROVIDER_CAPABILITY"',
        'wire_api = "responses"',
        'request_max_retries = 0',
        'stream_max_retries = 0',
        '',
        '[permissions.deployment-review.filesystem]',
        '":root" = "deny"',
        '":minimal" = "read"',
        `${JSON.stringify(join(this.environment.runtimeRoot, "codex"))} = "read"`,
        '":slash_tmp" = "write"',
        '":tmpdir" = "write"',
        '',
        '[permissions.deployment-review.filesystem.":workspace_roots"]',
        '"." = "read"',
        '',
        '[permissions.deployment-review.network]',
        'enabled = false',
        '',
        '[shell_environment_policy]',
        'inherit = "none"',
        'set = { PATH = "/usr/bin:/bin", HOME = "/tmp", GIT_CONFIG_NOSYSTEM = "1" }',
        '',
      ].join("\n");
      writeFileSync(join(workerStaging, "codex", "config.toml"), config, { mode: 0o440 });
      chownSync(join(workerStaging, "codex", "config.toml"), 0, identity.gid);
      for (const [name, contents] of [
        ["prompt.md", prompt],
        ["provider.cap", `${capability}\n`],
        ["metadata.json", `${JSON.stringify({
          ...packet,
          repository_path: repositoryPath,
          capability_expires_at_ms: capabilityExpiresAtMs,
          worker_unit: workerUnit,
        }, null, 2)}\n`],
      ]) {
        writeFileSync(join(controlStaging, name), contents, { mode: 0o440 });
        chownSync(join(controlStaging, name), 0, identity.gid);
      }
      chownSync(controlStaging, 0, identity.gid);
      chmodSync(controlStaging, 0o750);
      const reviewsParent = dirname(controlPath);
      mkdirSync(reviewsParent, { recursive: true, mode: 0o700 });
      chownSync(reviewsParent, 0, 0);
      chmodSync(reviewsParent, 0o700);
      renameSync(workerStaging, workerPath);
      renameSync(controlStaging, controlPath);
      return {
        reviewId: input.reviewId,
        incidentId: input.incidentId,
        repositoryPath,
        controlPath,
        capability,
        capabilityDigest: sha256(capability),
        capabilityExpiresAtMs,
        workerUnit,
      };
    } catch (error) {
      if (existsSync(workerStaging)) rmSync(workerStaging, { recursive: true, force: true });
      if (existsSync(controlStaging)) rmSync(controlStaging, { recursive: true, force: true });
      throw error;
    }
  }

  launch(workerUnit: string) {
    if (!/^concierge-deployment-(?:rollout-)?review@[0-9a-f-]{36}\.service$/i.test(workerUnit)) {
      throw new Error("Review worker unit identity is invalid.");
    }
    const result = this.services.spawn([this.environment.systemctlBin, "start", "--no-block", workerUnit]);
    if (result.exitCode !== 0) throw commandError("Review worker launch failed", result);
    return { worker_unit: workerUnit };
  }
}

export function defaultRolloutReviewWorkspaceEnvironment(): ReviewWorkspaceEnvironment {
  return {
    ...defaultReviewWorkspaceEnvironment(),
    workerRoot: process.env.CONCIERGE_ROLLOUT_REVIEW_WORKER_ROOT || "/var/lib/concierge-review/rollout-reviews",
    controlRoot: process.env.CONCIERGE_ROLLOUT_REVIEW_CONTROL_ROOT || "/var/lib/concierge-deployment/rollout-reviews",
  };
}

export function defaultReviewWorkspaceEnvironment(): ReviewWorkspaceEnvironment {
  return {
    workerRoot: process.env.CONCIERGE_REVIEW_WORKER_ROOT || "/var/lib/concierge-review/reviews",
    controlRoot: process.env.CONCIERGE_REVIEW_CONTROL_ROOT || "/var/lib/concierge-deployment/reviews",
    runtimeRoot: process.env.CONCIERGE_DEPLOYMENT_RUNTIME_DIR || "/usr/local/lib/concierge-deployment",
    providerAdapterSocket: process.env.CONCIERGE_PROVIDER_ADAPTER_SOCKET
      || "/run/concierge-deployment/provider-adapter.sock",
    providerAdapterPort: Number(process.env.CONCIERGE_PROVIDER_ADAPTER_PORT || 41951),
    reviewUser: "concierge-review",
    reviewGroup: "concierge-review",
    systemctlBin: "/usr/bin/systemctl",
  };
}
