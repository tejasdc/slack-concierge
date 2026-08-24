import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installedIdentityManifest } from "../../../deployment-control/kernel/identity";

describe("closed installed control-plane identity", () => {
  let root: string;
  let kernelRoot: string;
  let runtimeRoot: string;
  let systemdRoot: string;
  let releaseRoot: string;
  let systemctl: string;
  let systemctlCalls: string;
  let providerRegistryPath: string;
  const projectId = "project-0123456789abcdefabcd";

  function sha256(path: string) {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  }

  function sha256All(values: Array<string | Buffer>) {
    const hash = createHash("sha256");
    for (const value of values) hash.update(value);
    return hash.digest("hex");
  }

  function write(path: string, contents = `${path}\n`) {
    writeFileSync(path, contents);
    return path;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "concierge-identity-"));
    kernelRoot = join(root, "kernel");
    runtimeRoot = join(root, "runtime");
    systemdRoot = join(root, "systemd");
    releaseRoot = join(root, "releases");
    mkdirSync(kernelRoot, { recursive: true });
    mkdirSync(join(runtimeRoot, "coordinator/current"), { recursive: true });
    mkdirSync(join(runtimeRoot, "rollout/current"), { recursive: true });
    mkdirSync(join(runtimeRoot, "provider/current"), { recursive: true });
    mkdirSync(systemdRoot, { recursive: true });
    mkdirSync(join(releaseRoot, "current"), { recursive: true });
    mkdirSync(join(runtimeRoot, "dependencies/current"), { recursive: true });
    const kernelFiles = {
      kernel_bundle_sha256: "kernel.js",
      builder_bundle_sha256: "build-release.js",
      provider_adapter_bundle_sha256: "provider-adapter.js",
      repair_agent_bundle_sha256: "repair-agent.js",
      review_agent_bundle_sha256: "review-agent.js",
      rollout_review_agent_bundle_sha256: "rollout-review-agent.js",
      application_launcher_sha256: "run-application.sh",
      repair_charter_sha256: "repair-charter.md",
      repair_result_schema_sha256: "repair-result.schema.json",
      review_charter_sha256: "review-charter.md",
      review_result_schema_sha256: "review-result.schema.json",
      rollout_review_charter_sha256: "rollout-review-charter.md",
      policy_sha256: "deployment-repair-policy.toml",
    };
    for (const name of Object.values(kernelFiles)) write(join(kernelRoot, name));
    const codex = write(join(runtimeRoot, "codex"));
    const kernelDigests = Object.fromEntries(Object.entries(kernelFiles).map(([field, name]) => [field, sha256(join(kernelRoot, name))]));
    writeFileSync(join(kernelRoot, "manifest.json"), JSON.stringify({
      ...kernelDigests,
      codex_sha256: sha256(codex),
      version: sha256All([
        ...Object.values(kernelFiles).slice(0, -1).map((name) => readFileSync(join(kernelRoot, name))),
        sha256(codex),
        readFileSync(join(kernelRoot, "deployment-repair-policy.toml")),
      ]),
    }));
    const coordinator = write(join(runtimeRoot, "coordinator/current/coordinator.js"));
    const coordinatorVersion = sha256(coordinator);
    writeFileSync(join(runtimeRoot, "coordinator/current/manifest.json"), JSON.stringify({
      coordinator_bundle_sha256: coordinatorVersion,
      version: coordinatorVersion,
    }));
    mkdirSync(join(runtimeRoot, "coordinator", coordinatorVersion), { recursive: true });
    const slottedCoordinator = write(join(runtimeRoot, "coordinator", coordinatorVersion, "coordinator.js"), readFileSync(coordinator));
    writeFileSync(join(runtimeRoot, "coordinator", coordinatorVersion, "manifest.json"), JSON.stringify({
      coordinator_bundle_sha256: sha256(slottedCoordinator),
      version: coordinatorVersion,
    }));
    mkdirSync(join(runtimeRoot, "coordinator/slots"), { recursive: true });
    symlinkSync(`../${coordinatorVersion}`, join(runtimeRoot, "coordinator/slots/a"));
    writeFileSync(join(runtimeRoot, "coordinator/catalog.json"), JSON.stringify({
      schema_version: 1,
      candidate_slot: "a",
      candidate_version: coordinatorVersion,
      legacy_version: coordinatorVersion,
      slots: { a: coordinatorVersion },
    }));
    const rollout = write(join(runtimeRoot, "rollout/current/rollout.js"));
    writeFileSync(join(runtimeRoot, "rollout/current/manifest.json"), JSON.stringify({
      rollout_bundle_sha256: sha256(rollout),
      version: sha256(rollout),
    }));
    const providerFiles = ["broker.js", "worker.js", "continuity.js"];
    for (const name of providerFiles) write(join(runtimeRoot, "provider/current", name));
    const claude = write(join(runtimeRoot, "claude"));
    writeFileSync(join(runtimeRoot, "provider/current/manifest.json"), JSON.stringify({
      broker_bundle_sha256: sha256(join(runtimeRoot, "provider/current/broker.js")),
      worker_bundle_sha256: sha256(join(runtimeRoot, "provider/current/worker.js")),
      continuity_bundle_sha256: sha256(join(runtimeRoot, "provider/current/continuity.js")),
      codex_sha256: sha256(codex),
      claude_sha256: sha256(claude),
      version: sha256All([
        ...providerFiles.map((name) => readFileSync(join(runtimeRoot, "provider/current", name))),
        sha256(codex),
        sha256(claude),
      ]),
    }));
    const lock = write(join(runtimeRoot, "dependencies/current/bun.lock"));
    writeFileSync(join(runtimeRoot, "dependencies/current/manifest.json"), JSON.stringify({
      lock_sha256: sha256(lock),
      version: sha256(lock),
    }));
    write(join(runtimeRoot, "bun"));
    mkdirSync(join(releaseRoot, "current/bot/src"), { recursive: true });
    mkdirSync(join(releaseRoot, "current/bot/scripts"), { recursive: true });
    const releaseFiles = [
      "bot/scripts/rename-exchange.py",
      "bot/src/codex-app-server-bridge.mjs",
      "bot/src/index.js",
    ];
    for (const relativePath of releaseFiles) write(join(releaseRoot, "current", relativePath));
    writeFileSync(join(releaseRoot, "current/manifest.json"), JSON.stringify({
      files: Object.fromEntries(releaseFiles.map((relativePath) => [
        relativePath,
        sha256(join(releaseRoot, "current", relativePath)),
      ])),
    }));
    write(join(root, "sysusers.conf"));
    write(join(root, "tmpfiles.conf"));
    providerRegistryPath = join(root, "provider-projects.json");
    writeFileSync(providerRegistryPath, JSON.stringify({
      schema_version: 1,
      projects: [{ id: projectId }],
    }));
    for (const unit of [
      "concierge-bot.service",
      "concierge-deployment-kernel.service",
      "concierge-deployment-provider-adapter.service",
      "concierge-deployment-coordinator.service",
      "concierge-deployment-coordinator@.service",
      "concierge-deployment-repair@.service",
      "concierge-deployment-review@.service",
      "concierge-deployment-rollout-review@.service",
      "concierge-deployment-rollout@.service",
      "concierge-provider-broker@.service",
      "concierge-provider-broker@.socket",
      "concierge-provider-worker@.service",
      "concierge-provider-worker@.socket",
    ]) writeFileSync(join(systemdRoot, unit), `[Unit]\nDescription=${unit}\n`);
    for (const unit of ["broker", "worker"]) {
      const dropInRoot = join(systemdRoot, `concierge-provider-${unit}@${projectId}.service.d`);
      mkdirSync(dropInRoot, { recursive: true });
      writeFileSync(join(dropInRoot, "50-application-cutover.conf"), `[Service]\nEnvironment=PROJECT=${projectId}\n`);
    }
    systemctl = join(root, "systemctl");
    systemctlCalls = join(root, "systemctl-calls");
    writeFileSync(systemctl, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(systemctlCalls)}\nprintf 'User=fixture\\nProtectSystem=strict\\nSocketMode=0600\\nIPAddressDeny=any\\n'\n`);
    chmodSync(systemctl, 0o755);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("binds every executable authority and effective unit profile", () => {
    const first = installedIdentityManifest({
      kernelRoot,
      runtimeRoot,
      releaseRoot,
      systemdUnitRoot: systemdRoot,
      providerRegistryPath,
      systemctlBin: systemctl,
      sysusersPath: join(root, "sysusers.conf"),
      tmpfilesPath: join(root, "tmpfiles.conf"),
    });
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.manifest.files).toHaveLength(51);
    expect(first.manifest.effective_units).toHaveLength(13);
    const effectiveQueries = readFileSync(systemctlCalls, "utf8");
    expect(effectiveQueries).toContain("SocketUser");
    expect(effectiveQueries).toContain("SocketMode");
    expect(effectiveQueries).toContain("IPAddressDeny");
    expect(effectiveQueries).toContain("RuntimeDirectoryMode");

    writeFileSync(join(releaseRoot, "current/manifest.json"), JSON.stringify({
      git_commit: "a".repeat(40),
      source_tree_digest: "b".repeat(64),
      files: Object.fromEntries([
        "bot/scripts/rename-exchange.py",
        "bot/src/codex-app-server-bridge.mjs",
        "bot/src/index.js",
      ].map((relativePath) => [relativePath, sha256(join(releaseRoot, "current", relativePath))])),
    }));
    const provenanceOnly = installedIdentityManifest({
      kernelRoot,
      runtimeRoot,
      releaseRoot,
      systemdUnitRoot: systemdRoot,
      providerRegistryPath,
      systemctlBin: systemctl,
      sysusersPath: join(root, "sysusers.conf"),
      tmpfilesPath: join(root, "tmpfiles.conf"),
    });
    expect(provenanceOnly.digest).toBe(first.digest);

    writeFileSync(join(systemdRoot, "concierge-deployment-rollout@.service"), "changed\n");
    const changed = installedIdentityManifest({
      kernelRoot,
      runtimeRoot,
      releaseRoot,
      systemdUnitRoot: systemdRoot,
      providerRegistryPath,
      systemctlBin: systemctl,
      sysusersPath: join(root, "sysusers.conf"),
      tmpfilesPath: join(root, "tmpfiles.conf"),
    });
    expect(changed.digest).not.toBe(first.digest);
  });

  test("binds last-known-good executable bytes independently of release provenance", () => {
    const first = installedIdentityManifest({
      kernelRoot,
      runtimeRoot,
      releaseRoot,
      systemdUnitRoot: systemdRoot,
      providerRegistryPath,
      systemctlBin: systemctl,
      sysusersPath: join(root, "sysusers.conf"),
      tmpfilesPath: join(root, "tmpfiles.conf"),
    });
    writeFileSync(join(releaseRoot, "current/bot/src/index.js"), "changed runtime\n");
    const manifest = JSON.parse(readFileSync(join(releaseRoot, "current/manifest.json"), "utf8"));
    manifest.files["bot/src/index.js"] = sha256(join(releaseRoot, "current/bot/src/index.js"));
    writeFileSync(join(releaseRoot, "current/manifest.json"), JSON.stringify(manifest));

    const changed = installedIdentityManifest({
      kernelRoot,
      runtimeRoot,
      releaseRoot,
      systemdUnitRoot: systemdRoot,
      providerRegistryPath,
      systemctlBin: systemctl,
      sysusersPath: join(root, "sysusers.conf"),
      tmpfilesPath: join(root, "tmpfiles.conf"),
    });
    expect(changed.digest).not.toBe(first.digest);
  });

  test("rejects executable bytes that no longer match their installed manifest", () => {
    writeFileSync(join(kernelRoot, "kernel.js"), "tampered\n");
    expect(() => installedIdentityManifest({
      kernelRoot,
      runtimeRoot,
      releaseRoot,
      systemdUnitRoot: systemdRoot,
      providerRegistryPath,
      systemctlBin: systemctl,
      sysusersPath: join(root, "sysusers.conf"),
      tmpfilesPath: join(root, "tmpfiles.conf"),
    })).toThrow("does not match");
  });

  test("binds provider executables, project drop-ins, and effective namespace properties", () => {
    const first = installedIdentityManifest({
      kernelRoot,
      runtimeRoot,
      releaseRoot,
      systemdUnitRoot: systemdRoot,
      providerRegistryPath,
      systemctlBin: systemctl,
      sysusersPath: join(root, "sysusers.conf"),
      tmpfilesPath: join(root, "tmpfiles.conf"),
    });
    writeFileSync(join(systemdRoot, `concierge-provider-broker@${projectId}.service.d/50-application-cutover.conf`), "changed\n");
    const changed = installedIdentityManifest({
      kernelRoot,
      runtimeRoot,
      releaseRoot,
      systemdUnitRoot: systemdRoot,
      providerRegistryPath,
      systemctlBin: systemctl,
      sysusersPath: join(root, "sysusers.conf"),
      tmpfilesPath: join(root, "tmpfiles.conf"),
    });
    expect(changed.digest).not.toBe(first.digest);
    expect(first.manifest.effective_units.some((unit) => unit.unit === `concierge-provider-worker@${projectId}.service`)).toBe(true);
  });
});
