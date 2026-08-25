import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "concierge-identity-"));
    kernelRoot = join(root, "kernel");
    runtimeRoot = join(root, "runtime");
    systemdRoot = join(root, "systemd");
    releaseRoot = join(root, "releases");
    mkdirSync(kernelRoot, { recursive: true });
    mkdirSync(join(runtimeRoot, "coordinator/current"), { recursive: true });
    mkdirSync(join(runtimeRoot, "rollout/current"), { recursive: true });
    mkdirSync(systemdRoot, { recursive: true });
    mkdirSync(join(releaseRoot, "current"), { recursive: true });
    for (const path of [
      join(kernelRoot, "manifest.json"),
      join(runtimeRoot, "coordinator/current/manifest.json"),
      join(runtimeRoot, "rollout/current/manifest.json"),
      join(runtimeRoot, "bun"),
      join(runtimeRoot, "codex"),
      join(releaseRoot, "current/manifest.json"),
      join(root, "sysusers.conf"),
      join(root, "tmpfiles.conf"),
    ]) writeFileSync(path, `${path}\n`);
    for (const unit of [
      "concierge-bot.service",
      "concierge-deployment-kernel.service",
      "concierge-deployment-provider-adapter.service",
      "concierge-deployment-coordinator.service",
      "concierge-deployment-repair@.service",
      "concierge-deployment-review@.service",
      "concierge-deployment-rollout@.service",
    ]) writeFileSync(join(systemdRoot, unit), `[Unit]\nDescription=${unit}\n`);
    systemctl = join(root, "systemctl");
    writeFileSync(systemctl, "#!/bin/sh\nprintf 'User=fixture\\nProtectSystem=strict\\n'\n");
    chmodSync(systemctl, 0o755);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("binds every executable authority and effective unit profile", () => {
    const first = installedIdentityManifest({
      kernelRoot,
      runtimeRoot,
      releaseRoot,
      systemdUnitRoot: systemdRoot,
      systemctlBin: systemctl,
      sysusersPath: join(root, "sysusers.conf"),
      tmpfilesPath: join(root, "tmpfiles.conf"),
    });
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.manifest.files).toHaveLength(15);
    expect(first.manifest.effective_units).toHaveLength(7);

    writeFileSync(join(systemdRoot, "concierge-deployment-rollout@.service"), "changed\n");
    const changed = installedIdentityManifest({
      kernelRoot,
      runtimeRoot,
      releaseRoot,
      systemdUnitRoot: systemdRoot,
      systemctlBin: systemctl,
      sysusersPath: join(root, "sysusers.conf"),
      tmpfilesPath: join(root, "tmpfiles.conf"),
    });
    expect(changed.digest).not.toBe(first.digest);
  });
});
