import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspectReleaseTree } from "./releases";
import { repairTreeDigest } from "./repair-workspace";

interface SpawnResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export class RepairIntegrationAmbiguousError extends Error {}

export interface RepairIntegrationEnvironment {
  repositoryRoot: string;
  integrationRoot: string;
  originRemote: string;
  originBranch: string;
  home: string;
}

export interface RepairIntegrationServices {
  spawn(command: string[], options?: { cwd?: string; stdin?: Uint8Array; env?: Record<string, string> }): SpawnResult;
}

function defaultServices(): RepairIntegrationServices {
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
  };
}

function assertCommit(value: string, label: string) {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error(`${label} must be a full lowercase Git SHA.`);
}

function error(label: string, result: SpawnResult) {
  return new Error(`${label}: ${Buffer.from(result.stderr).toString("utf8").trim().slice(0, 2000)}`);
}

export class RepairIntegrationManager {
  constructor(
    readonly environment: RepairIntegrationEnvironment,
    readonly services: RepairIntegrationServices = defaultServices(),
  ) {}

  private command(repository: string, args: string[], stdin?: Uint8Array) {
    return this.services.spawn([
      "/usr/bin/git", "-c", "core.hooksPath=/dev/null", "-C", repository, ...args,
    ], {
      stdin,
      env: {
        ...process.env,
        HOME: this.environment.home,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
  }

  private checked(repository: string, label: string, args: string[], stdin?: Uint8Array) {
    const result = this.command(repository, args, stdin);
    if (result.exitCode !== 0) throw error(label, result);
    return Buffer.from(result.stdout).toString("utf8").trim();
  }

  private observedOriginCommit() {
    this.checked(this.environment.repositoryRoot, "Origin fetch failed", [
      "fetch", "--quiet", this.environment.originRemote, this.environment.originBranch,
    ]);
    return this.checked(this.environment.repositoryRoot, "Origin observation failed", [
      "rev-parse", `refs/remotes/${this.environment.originRemote}/${this.environment.originBranch}`,
    ]).toLowerCase();
  }

  integrate(input: {
    incidentId: string;
    originBaseCommit: string;
    reviewedTreeDigest: string;
    reviewedPatch: Uint8Array;
    summary: string;
  }) {
    assertCommit(input.originBaseCommit, "Repair origin base");
    if (!/^[0-9a-f]{64}$/.test(input.reviewedTreeDigest)) throw new Error("Reviewed tree digest is invalid.");
    if (this.observedOriginCommit() !== input.originBaseCommit) {
      throw new Error("origin/main moved after review; the repair must refresh and be reviewed again.");
    }
    mkdirSync(this.environment.integrationRoot, { recursive: true, mode: 0o700 });
    const staging = join(this.environment.integrationRoot, `.staging-${input.incidentId}-${randomUUID()}`);
    const verification = join(this.environment.integrationRoot, `.verify-${input.incidentId}-${randomUUID()}`);
    mkdirSync(staging, { mode: 0o700 });
    mkdirSync(verification, { mode: 0o700 });
    try {
      this.checked(staging, "Integration repository initialization failed", ["init", "--initial-branch=integration"]);
      this.checked(staging, "Integration base import failed", [
        "fetch", "--quiet", "--no-tags", this.environment.repositoryRoot, input.originBaseCommit,
      ]);
      this.checked(staging, "Integration base checkout failed", ["checkout", "--detach", input.originBaseCommit]);
      this.checked(staging, "Integration hook disable failed", ["config", "core.hooksPath", "/dev/null"]);
      this.checked(staging, "Integration author configuration failed", ["config", "user.name", "Concierge Deployment Repair"]);
      this.checked(staging, "Integration author configuration failed", [
        "config", "user.email", "deployment-repair@localhost",
      ]);
      this.checked(staging, "Reviewed patch application failed", ["apply", "--index", "--binary", "-"], input.reviewedPatch);
      const message = `Repair deployment incident ${input.incidentId}\n\n${input.summary.trim().slice(0, 2_000)}`;
      this.checked(staging, "Integrated repair commit failed", ["commit", "--no-gpg-sign", "-m", message]);
      const integratedCommit = this.checked(staging, "Integrated repair head lookup failed", ["rev-parse", "HEAD"]).toLowerCase();
      assertCommit(integratedCommit, "Integrated repair commit");
      const archive = this.command(staging, ["archive", "--format=tar", integratedCommit]);
      if (archive.exitCode !== 0) throw error("Integrated tree archive failed", archive);
      const extracted = this.services.spawn(["/usr/bin/tar", "-xf", "-", "-C", verification], { stdin: archive.stdout });
      if (extracted.exitCode !== 0) throw error("Integrated tree extraction failed", extracted);
      inspectReleaseTree(verification, { allowSymlinks: true });
      if (repairTreeDigest(verification) !== input.reviewedTreeDigest) {
        throw new Error("Integrated tree does not equal the independently reviewed tree.");
      }
      const originUrl = this.checked(this.environment.repositoryRoot, "Origin URL lookup failed", [
        "remote", "get-url", this.environment.originRemote,
      ]);
      this.checked(staging, "Integration origin registration failed", ["remote", "add", "origin", originUrl]);
      this.checked(staging, "Integration origin preflight failed", ["fetch", "--quiet", "origin", this.environment.originBranch]);
      const frozenOrigin = this.checked(staging, "Integration origin preflight failed", [
        "rev-parse", `refs/remotes/origin/${this.environment.originBranch}`,
      ]).toLowerCase();
      if (frozenOrigin !== input.originBaseCommit) {
        throw new Error("origin/main moved immediately before repair integration.");
      }
      const push = this.command(staging, ["push", "--porcelain", "origin", `HEAD:refs/heads/${this.environment.originBranch}`]);
      const confirmed = (() => {
        try {
          return this.observedOriginCommit();
        } catch {
          return null;
        }
      })();
      if (confirmed !== integratedCommit) {
        throw new RepairIntegrationAmbiguousError(
          `Repair push could not be proven${push.exitCode === 0 ? " after an accepted push" : `: ${Buffer.from(push.stderr).toString("utf8").trim().slice(0, 1000)}`}.`,
        );
      }
      writeFileSync(join(staging, "integration-result.json"), `${JSON.stringify({ integrated_commit: integratedCommit })}\n`, {
        mode: 0o400,
      });
      const completed = join(this.environment.integrationRoot, `${input.incidentId}-${integratedCommit}`);
      if (!existsSync(completed)) renameSync(staging, completed);
      return { integrated_commit: integratedCommit, origin_commit: confirmed };
    } finally {
      if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
      if (existsSync(verification)) rmSync(verification, { recursive: true, force: true });
    }
  }
}

export function defaultRepairIntegrationEnvironment(repositoryRoot: string): RepairIntegrationEnvironment {
  return {
    repositoryRoot,
    integrationRoot: process.env.CONCIERGE_REPAIR_INTEGRATION_ROOT || "/var/lib/concierge-deployment/integration",
    originRemote: "origin",
    originBranch: "main",
    home: "/root",
  };
}
