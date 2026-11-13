#!/usr/bin/env bun
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { TrustedRootReleaseManager, releaseFileSetDigest } from "../src/deployment-release";

// Real manager, shipped shell launcher and bundled manager command; synthetic
// sealed application/helpers and an owned supervisor replace all production work.
const repo = resolve(import.meta.dir, "../..");
const root = mkdtempSync(join(tmpdir(), "installed-control-command-"));
const releaseRoot = join(root, "deployment"), installRoot = join(root, "install");
const fakeBin = join(root, "bin"), state = join(root, "state");
mkdirSync(join(releaseRoot, "releases"), { recursive: true });
mkdirSync(fakeBin); mkdirSync(state); mkdirSync(installRoot);
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const executable = (path: string, bytes: string) => writeFileSync(path, bytes, { mode: 0o755 });
const runtime = join(root, "runtime");
executable(runtime, '#!/bin/sh\nexec "$FIXTURE_REAL_BUN" "$@"\n');
executable(join(fakeBin, "systemd-run"), '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do case "$1" in --*) shift;; *) break;; esac; done\nexec "$@"\n');
const env = { ...process.env, CONCIERGE_STATE_DIR: state, CONCIERGE_STATE_DB: join(state, "state.db"),
  CONCIERGE_DEPLOYMENT_RELEASE_ROOT: releaseRoot, CONCIERGE_DEPLOYMENT_RUNTIME_DIR: installRoot,
  FIXTURE_REAL_BUN: process.execPath, PATH: `${fakeBin}:${process.env.PATH}` };
const Manager = process.env.FIXTURE_RELEASE_MANAGER_MODULE
  ? (await import(process.env.FIXTURE_RELEASE_MANAGER_MODULE)).TrustedRootReleaseManager : TrustedRootReleaseManager;
const manager = new Manager({ repositoryRoot: repo, releaseRoot, installRoot, bunExecutable: runtime });
const run = (args: string[], extra = {}) => Bun.spawnSync({ cmd: args, env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
const check = (name: string, work: () => void) => {
  work(); console.log(JSON.stringify({ check: name, status: "passed" }));
};
function permissions(path: string, sealed: boolean) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    if (!sealed) chmodSync(path, 0o700);
    for (const name of readdirSync(path)) permissions(join(path, name), sealed);
    if (sealed) chmodSync(path, 0o555);
  } else chmodSync(path, sealed ? 0o444 : 0o600);
}
let managerBundle: Uint8Array;
async function bundleManager() {
  const build = await Bun.build({ entrypoints: [join(repo, "bot/scripts/release-manager.ts")], target: "bun" });
  assert.ok(build.success, build.logs.map(String).join("\n"));
  managerBundle = new Uint8Array(await build.outputs[0]!.arrayBuffer());
}
function artifact(name: string, modern = true, missing = false) {
  const stage = join(releaseRoot, "releases", `.${name}-stage`); mkdirSync(stage);
  const files: Record<string, string | Uint8Array> = {
    "control/deploy.sh": "#!/bin/sh\necho fixture-deploy\n",
    "control/deployment-repair.js": 'console.log("fixture-repair")',
    "control/recover-deployment.js": 'console.log("fixture-recovery")',
    "control/release-manager.js": modern ? managerBundle : 'throw new Error("old manager has no install-launchers command")',
    "control/deployment-launcher.sh": readFileSync(join(repo, "bot/scripts/deployment-launcher.sh")),
    "control/history-cache.js": 'console.log(JSON.stringify({status:"fixture-status",path:import.meta.dir,args:process.argv.slice(2)}))',
    "bot/src/index.js": `console.log("fixture-application-${name}")`,
  };
  if (!missing) files["control/deployment-control-launcher.sh"] = modern
    ? readFileSync(join(repo, "bot/scripts/deployment-control-launcher.sh"))
    : '#!/bin/sh\ncase "${1:-}" in deploy|repair|recover) echo fixture-old-control;; *) echo "usage: <deploy|repair|recover>" >&2; exit 2;; esac\n';
  if (modern) files["control/deployment-runtime-launchers.json"] = '{"format":1}';
  for (const [path, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(stage, path)), { recursive: true }); writeFileSync(join(stage, path), bytes);
  }
  const unsigned = { format: 2, git_commit: "a".repeat(40), control_git_commit: "b".repeat(40),
    source_tree_digest: hash(name), control_source_tree_digest: hash(`control-${name}`),
    runtime_digest: releaseFileSetDigest(stage, Object.keys(files)), compatibility_digest: hash("compatibility"),
    files: Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, hash(bytes)])) };
  const artifact_digest = hash(JSON.stringify(unsigned));
  writeFileSync(join(stage, "manifest.json"), JSON.stringify({ ...unsigned, artifact_digest }));
  permissions(stage, true);
  const path = join(releaseRoot, "releases", artifact_digest); renameSync(stage, path); return path;
}
const stable = join(installRoot, "control");
function status(expectedPath?: string) {
  const result = run([stable, "history-cache", "status"]);
  if (!expectedPath) { assert.equal(result.exitCode, 2); return; }
  assert.equal(result.exitCode, 0, result.stderr.toString());
  assert.deepEqual(JSON.parse(result.stdout.toString()), { status: "fixture-status", path: join(expectedPath, "control"), args: ["status"] });
}
function snapshot() {
  return { current: manager.currentArtifactPath(), control: manager.controlArtifactPath(),
    commands: ["launch", "control"].map(name => readFileSync(join(installRoot, name), "utf8")) };
}
function rejected(path: string) {
  const before = snapshot(); assert.throws(() => manager.activateControl(path)); assert.deepEqual(snapshot(), before);
  assert.throws(() => manager.restore(path)); assert.deepEqual(snapshot(), before);
}
try {
  await bundleManager();
  const old = artifact("old", false), modern = artifact("modern");
  // Begin with precisely the predecessor's copied regular-file entrance and
  // pointer publication. No new-manager activation may repair this setup.
  manager.activate(old);
  symlinkSync(old, join(releaseRoot, "control"));
  executable(stable, readFileSync(join(old, "control/deployment-control-launcher.sh"), "utf8"));
  executable(join(installRoot, "bun"), readFileSync(runtime, "utf8"));
  check("predecessor copied entrance rejects the installed maintenance command", () => status());

  manager.activate(modern);
  const unit = readFileSync(process.env.FIXTURE_SERVICE_UNIT || join(repo, "systemd/concierge-bot.service"), "utf8");
  const bootstrap = unit.split("\n").find(line => line.startsWith("ExecStartPre=") && line.includes(" install-launchers"));
  assert.ok(bootstrap, "the first rollout needs a candidate-owned pre-start entrance upgrade");
  assert.ok(unit.indexOf(bootstrap) < unit.indexOf("ExecStartPre=/usr/local/lib/slack-concierge-deployment/control recover"));
  const command = bootstrap.slice("ExecStartPre=".length).replaceAll("/usr/local/lib/slack-concierge-deployment", installRoot)
    .replaceAll("/var/lib/slack-concierge-deployment", releaseRoot);
  check("candidate pre-start upgrades the entrance while retaining predecessor control", () => {
    const result = run(["/usr/bin/bash", "-ec", command], { CONCIERGE_DEPLOYMENT_CONTROL_ROOT: join(old, "control") });
    assert.equal(result.exitCode, 0, result.stderr.toString()); status();
    assert.equal(existsSync(join(state, "state.db")), false, "file-only pre-start must not open a ledger");
  });
  const wrappers = snapshot().commands;
  // The old manager's promotion is an atomic pointer change, without any
  // new install callback. This proves the first fixing release, not only later ones.
  check("predecessor promotion exposes modern commands without another installation", () => {
    const next = join(releaseRoot, ".old-manager-promotion"); symlinkSync(modern, next); renameSync(next, join(releaseRoot, "control"));
    status(modern); assert.deepEqual(snapshot().commands, wrappers);
  });
  check("full rollback selects old command and application", () => {
    manager.restore(old); status();
    assert.equal(manager.currentArtifactPath(), old); assert.equal(manager.controlArtifactPath(), old);
    const result = run(["/usr/bin/bash", "-ec", command]);
    assert.equal(result.exitCode, 0, "a restored old application skips unsupported bootstrap"); status();
  });
  check("forward activation and application-only rollback preserve the selected controller", () => {
    manager.activate(modern); manager.activateControl(modern); status(modern);
    manager.activate(old); assert.equal(manager.controlArtifactPath(), modern); status(old);
    const launch = run([join(installRoot, "launch")]); assert.equal(launch.exitCode, 0, launch.stderr.toString());
    assert.match(launch.stdout.toString(), /fixture-application-old/);
  });
  check("explicit control recovery replaces old control without changing the application", () => {
    manager.restore(old); manager.activateControl(modern);
    assert.equal(manager.currentArtifactPath(), old); status(old);
  });
  check("runtime reinstall ignores stale invocation roots", () => {
    const result = run([process.execPath, join(modern, "control/release-manager.js"), "install-runtime"], {
      CONCIERGE_BUN_BIN: runtime, CONCIERGE_DEPLOYMENT_CONTROL_ROOT: join(old, "control"), CONCIERGE_DEPLOYMENT_SOURCE_ROOT: root,
    });
    assert.equal(result.exitCode, 0, result.stderr.toString()); status(old); assert.deepEqual(snapshot().commands, wrappers);
  });
  check("tampered, unpublished, unsealed and launcher-less releases preserve both entrances and pointers", () => {
    const tampered = artifact("tampered"); chmodSync(join(tampered, "control/deploy.sh"), 0o600);
    writeFileSync(join(tampered, "control/deploy.sh"), "tampered"); permissions(tampered, true); rejected(tampered);
    const unpublished = artifact("unpublished"), moved = join(releaseRoot, "releases", ".preparing-fixture"); renameSync(unpublished, moved); rejected(moved);
    const writable = artifact("writable"); chmodSync(writable, 0o755); rejected(writable);
    rejected(artifact("missing", true, true));
  });
  console.log(JSON.stringify({ fixture: "installed-control-command", status: "passed", productionStateOrCacheWorkload: false,
    substitutes: ["synthetic sealed application and helpers", "tiny Bun forwarding executable", "owned systemd-run forwarding executable"] }));
} finally {
  permissions(root, false); rmSync(root, { recursive: true, force: true });
}
