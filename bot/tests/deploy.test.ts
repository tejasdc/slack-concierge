import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../..");
const deployScript = join(repo, "bot/scripts/deploy.sh");
const bootstrapScript = join(repo, "bot/scripts/bootstrap-deploy.sh");
const projectCutoverScript = join(repo, "bot/scripts/project-scaffold-cutover.sh");
const scratch: string[] = [];

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fakeDrain(statuses: number[]) {
  const dir = mkdtempSync(join(tmpdir(), "concierge-deploy-test-"));
  scratch.push(dir);
  const state = join(dir, "statuses");
  const calls = join(dir, "calls");
  const bun = join(dir, "bun");
  writeFileSync(state, `${statuses.join("\n")}\n`);
  writeFileSync(bun, [
    "#!/usr/bin/env bash",
    `state=${JSON.stringify(state)}`,
    `calls=${JSON.stringify(calls)}`,
    "echo \"$*\" >> \"$calls\"",
    "if [[ \"$*\" == *' release '* || \"$*\" == *' release-live '* ]]; then echo '{\"status\":\"released\"}'; exit 0; fi",
    "if [[ \"$*\" == *' hold '* ]]; then echo '{\"status\":\"held\"}'; exit 0; fi",
    "status=$(head -1 \"$state\")",
    "tail -n +2 \"$state\" > \"$state.next\"",
    "mv \"$state.next\" \"$state\"",
    "token=turn-token",
    "[[ \"$*\" == *capture-drain-status.ts* ]] && token=capture-token",
    "if [ \"$status\" = 0 ]; then printf '{\"status\":\"claimed_drained\",\"token\":\"%s\"}\\n' \"$token\"; else echo '{\"status\":\"active\"}'; fi",
    "exit \"$status\"",
  ].join("\n"));
  chmodSync(bun, 0o755);
  return { bun, calls, dir };
}

function executable(path: string, lines: string[]) {
  writeFileSync(path, lines.join("\n"));
  chmodSync(path, 0o755);
}

function cleanGitCheckout() {
  const dir = mkdtempSync(join(tmpdir(), "concierge-clean-git-checkout-"));
  scratch.push(dir);
  writeFileSync(join(dir, "tracked.txt"), "committed\n");
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "concierge-tests@example.invalid"],
    ["config", "user.name", "Concierge tests"],
    ["add", "tracked.txt"],
    ["commit", "-qm", "fixture"],
    ["remote", "add", "origin", Bun.spawnSync({
      cmd: ["git", "-C", repo, "remote", "get-url", "origin"],
      stdout: "pipe",
      stderr: "pipe",
    }).stdout.toString().trim()],
  ]) {
    const result = Bun.spawnSync({ cmd: ["git", ...args], cwd: dir, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  }
  return dir;
}

function runClaim(bun: string) {
  return Bun.spawnSync({
    cmd: ["bash", "-c", `source "$1"; claim_deployment_gate`, "test", deployScript],
    env: {
      ...process.env,
      CONCIERGE_REPO: repo,
      CONCIERGE_BUN_BIN: bun,
      CONCIERGE_DRAIN_INTERVAL_SECONDS: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("drain-aware deploy", () => {
  test("deploy installs the repository-owned router helper", () => {
    const source = readFileSync(deployScript, "utf8");
    expect(source).toContain('install -m 0755 "$source" "$ROUTER_ACTIONS_DEST"');
    expect(source).toContain("install_router_actions");
  });

  test("detached deploy rejects an unreadable origin with root credentials before claiming gates", () => {
    const fake = fakeDrain([0, 0]);
    const dir = mkdtempSync(join(tmpdir(), "concierge-git-preflight-test-"));
    scratch.push(dir);
    const gitCalls = join(dir, "git-calls");
    executable(join(dir, "git"), [
      "#!/usr/bin/env bash",
      `printf '%s|HOME=%s|PROMPT=%s\n' "$*" "$HOME" "$GIT_TERMINAL_PROMPT" >> ${JSON.stringify(gitCalls)}`,
      "exit 1",
    ]);
    const result = Bun.spawnSync({
      cmd: ["env", "-u", "HOME", "bash", deployScript],
      env: {
        ...process.env, PATH: `${dir}:${process.env.PATH}`, CONCIERGE_REPO: repo,
        CONCIERGE_BUN_BIN: fake.bun, CONCIERGE_DEPLOY_DETACHED: "1",
      },
      stdout: "pipe", stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Git origin is not readable non-interactively");
    expect(readFileSync(gitCalls, "utf-8")).toContain("ls-remote --exit-code origin HEAD|HOME=/root|PROMPT=0");
    expect(() => readFileSync(fake.calls, "utf-8")).toThrow();
  });

  test("bootstrap rejects missing Git credentials before freezing or stopping Concierge", () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-bootstrap-git-preflight-test-"));
    scratch.push(dir);
    const gitCalls = join(dir, "git-calls");
    const systemctlCalls = join(dir, "systemctl-calls");
    executable(join(dir, "git"), [
      "#!/usr/bin/env bash",
      `printf '%s|HOME=%s|PROMPT=%s\n' "$*" "$HOME" "$GIT_TERMINAL_PROMPT" >> ${JSON.stringify(gitCalls)}`,
      "exit 1",
    ]);
    executable(join(dir, "systemctl"), ["#!/usr/bin/env bash", `echo "$*" >> ${JSON.stringify(systemctlCalls)}`, "exit 1"]);
    const result = Bun.spawnSync({
      cmd: ["env", "-u", "HOME", "bash", bootstrapScript],
      env: {
        ...process.env, PATH: `${dir}:${process.env.PATH}`, CONCIERGE_REPO: repo,
        CONCIERGE_BOOTSTRAP_DETACHED: "1",
      },
      stdout: "pipe", stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(readFileSync(gitCalls, "utf-8")).toContain("fetch origin|HOME=/root|PROMPT=0");
    expect(() => readFileSync(systemctlCalls, "utf-8")).toThrow();
  });

  test("scaffold cutover rejects an unreadable origin before claiming gates or stopping Concierge", () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-cutover-git-preflight-test-"));
    scratch.push(dir);
    const bunCalls = join(dir, "bun-calls");
    const systemctlCalls = join(dir, "systemctl-calls");
    executable(join(dir, "git"), ["#!/usr/bin/env bash", "exit 1"]);
    executable(join(dir, "bun"), ["#!/usr/bin/env bash", `echo "$*" >> ${JSON.stringify(bunCalls)}`, "exit 1"]);
    executable(join(dir, "systemctl"), ["#!/usr/bin/env bash", `echo "$*" >> ${JSON.stringify(systemctlCalls)}`, "exit 1"]);
    const result = Bun.spawnSync({
      cmd: ["env", "-u", "HOME", "bash", projectCutoverScript],
      env: {
        ...process.env, PATH: `${dir}:${process.env.PATH}`, CONCIERGE_REPO: repo,
        CONCIERGE_BUN_BIN: join(dir, "bun"),
      },
      stdout: "pipe", stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Git origin is not readable non-interactively");
    expect(() => readFileSync(bunCalls, "utf-8")).toThrow();
    expect(() => readFileSync(systemctlCalls, "utf-8")).toThrow();
  });

  test("waits through live owners until the service is drained", () => {
    const fake = fakeDrain([0, 10, 10, 0]);
    const result = runClaim(fake.bun);

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(readFileSync(fake.calls, "utf-8").trim().split("\n")).toHaveLength(4);
    expect(result.stdout.toString()).toContain("Active provider work is still running");
    expect(result.stdout.toString()).toContain("Deployment gate claimed");
    expect(readFileSync(fake.calls, "utf-8")).toContain("--owner-pid");
  });

  test("an interrupted drain wait immediately rechecks live ownership", () => {
    const fake = fakeDrain([0, 10, 0]);
    executable(join(fake.dir, "sleep"), ["#!/usr/bin/env bash", "exit 143"]);
    const result = Bun.spawnSync({
      cmd: ["bash", "-c", `source "$1"; claim_deployment_gate`, "test", deployScript],
      env: {
        ...process.env,
        PATH: `${fake.dir}:${process.env.PATH}`,
        CONCIERGE_REPO: repo,
        CONCIERGE_BUN_BIN: fake.bun,
        CONCIERGE_DRAIN_INTERVAL_SECONDS: "1200",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(readFileSync(fake.calls, "utf-8").trim().split("\n")).toHaveLength(3);
    expect(result.stdout.toString()).toContain("Deployment gate claimed");
  });

  test("deployment phases preserve exact JSON details", () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-deploy-phase-test-"));
    scratch.push(dir);
    const details = join(dir, "details");
    const bun = join(dir, "bun");
    executable(bun, [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "\${!#}" >> ${JSON.stringify(details)}`,
      "exit 0",
    ]);
    const result = Bun.spawnSync({
      cmd: [
        "bash",
        "-c",
        `source "$1"; DEPLOY_RUN_ID=run-phase; record_deployment_phase updating '{"gate":"claimed"}'; record_deployment_phase restarting`,
        "test",
        deployScript,
      ],
      env: { ...process.env, CONCIERGE_REPO: repo, CONCIERGE_BUN_BIN: bun },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(readFileSync(details, "utf-8").trim().split("\n")).toEqual([
      '{"gate":"claimed"}',
      "{}",
    ]);
  });

  test("fails closed when ownership cannot be determined", () => {
    const fake = fakeDrain([0, 1]);
    const result = runClaim(fake.bun);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("could not be determined safely");
  });

  test("releases the exact token returned by the atomic claim", () => {
    const fake = fakeDrain([0, 0]);
    const result = Bun.spawnSync({
      cmd: ["bash", "-c", `source "$1"; claim_deployment_gate; release_deployment_gate`, "test", deployScript],
      env: { ...process.env, CONCIERGE_REPO: repo, CONCIERGE_BUN_BIN: fake.bun },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const calls = readFileSync(fake.calls, "utf-8");
    expect(calls).toContain("release turn-token");
    expect(calls).toContain("release capture-token");
  });

  test("versions the primary and capture service units and installs them during deploy", () => {
    const script = readFileSync(deployScript, "utf-8");
    expect(readFileSync(join(repo, "systemd/concierge-bot.service"), "utf-8")).toContain("ExecStart=");
    const captureUnit = readFileSync(join(repo, "systemd/agent-inbox.service"), "utf-8");
    const botUnit = readFileSync(join(repo, "systemd/concierge-bot.service"), "utf-8");
    expect(captureUnit).toContain("User=concierge-capture");
    expect(captureUnit).toContain("ProtectSystem=strict");
    expect(captureUnit).toContain("LoadCredential=capture_queue:");
    expect(captureUnit).not.toContain("slack_token");
    expect(botUnit).toContain("LoadCredential=capture_queue:");
    expect(botUnit).toContain("CONCIERGE_CAPTURE_QUEUE_URL=http://127.0.0.1:8081");
    expect(botUnit).toContain("CONCIERGE_CODEX_REMOTE_EXCLUDE_CHANNELS=slack-inbox");
    expect(botUnit).toContain("ExecStartPre=/usr/bin/test -x /usr/bin/node");
    expect(botUnit).toContain("ExecStartPre=/root/.codex/packages/standalone/current/codex app-server daemon start");
    expect(botUnit).toContain("CONCIERGE_ENABLE_CONTROL_REQUESTS=0");
    expect(botUnit).toContain("CONCIERGE_ENABLE_CONTROL_HANDOFFS=1");
    expect(captureUnit).toContain("TimeoutStopSec=infinity");
    expect(captureUnit).toContain("KillMode=mixed");
    expect(script).toContain("for unit in concierge-bot.service agent-inbox.service");
    expect(script).toContain("concierge-deployment-provider-adapter.service");
    expect(script).toContain("concierge-deployment-repair@.service");
    expect(script).toContain("concierge-deployment-review@.service");
    expect(script).toContain("concierge-deployment-rollout@.service");
    expect(script).toContain("concierge-deployment-coordinator@.service");
    expect(script).toContain("systemd-tmpfiles --create");
    expect(readFileSync(join(repo, "systemd/concierge-deployment.tmpfiles.conf"), "utf8"))
      .toContain("/var/lib/concierge-repair");
    expect(readFileSync(join(repo, "systemd/concierge-deployment.tmpfiles.conf"), "utf8"))
      .toContain("/root/.local/state/concierge-deployment 0700 root root");
    const kernelUnit = readFileSync(join(repo, "systemd/concierge-deployment-kernel.service"), "utf-8");
    const providerAdapterUnit = readFileSync(join(repo, "systemd/concierge-deployment-provider-adapter.service"), "utf-8");
    const repairUnit = readFileSync(join(repo, "systemd/concierge-deployment-repair@.service"), "utf-8");
    const reviewUnit = readFileSync(join(repo, "systemd/concierge-deployment-review@.service"), "utf-8");
    const coordinatorUnit = readFileSync(join(repo, "systemd/concierge-deployment-coordinator.service"), "utf-8");
    const coordinatorCandidateUnit = readFileSync(join(repo, "systemd/concierge-deployment-coordinator@.service"), "utf-8");
    const rolloutUnit = readFileSync(join(repo, "systemd/concierge-deployment-rollout@.service"), "utf-8");
    const providerBrokerUnit = readFileSync(join(repo, "systemd/concierge-provider-broker@.service"), "utf-8");
    const providerWorkerUnit = readFileSync(join(repo, "systemd/concierge-provider-worker@.service"), "utf-8");
    expect(kernelUnit).toContain("/usr/local/lib/concierge-deployment/kernel/current/kernel.js");
    expect(kernelUnit).toContain("ReadWritePaths=/root/.local/state/concierge-deployment");
    expect(kernelUnit).toContain("After=network-online.target systemd-tmpfiles-setup.service");
    expect(kernelUnit).toContain("/var/lib/concierge-repair /var/lib/concierge-review");
    expect(providerAdapterUnit).toContain("CONCIERGE_CODEX_AUTH_PATH=/root/.codex/auth.json");
    expect(providerAdapterUnit).toContain("CapabilityBoundingSet=");
    expect(rolloutUnit).toContain("User=concierge-rollout");
    expect(rolloutUnit).toContain("ReadOnlyPaths=/usr/local/lib/concierge-deployment/rollout /run/concierge-deployment");
    expect(rolloutUnit).not.toContain("/root/.local/state/concierge-deployment");
    expect(readFileSync(join(repo, "systemd/concierge-deployment.conf"), "utf8"))
      .toContain("u concierge-rollout");
    expect(providerAdapterUnit).not.toContain("IPAddressDeny=any");
    expect(providerAdapterUnit).not.toContain("Environment=OPENAI_API_KEY=");
    expect(repairUnit).toContain("User=concierge-repair");
    expect(repairUnit).toContain("IPAddressDeny=any");
    expect(repairUnit).toContain("IPAddressAllow=localhost");
    expect(repairUnit).toContain("InaccessiblePaths=/root /etc/concierge");
    expect(repairUnit).toContain("/var/lib/concierge-deployment/incidents/%i/repair:/var/lib/concierge-repair/incidents/%i/control");
    expect(repairUnit).toContain("ReadWritePaths=/var/lib/concierge-repair/incidents/%i");
    expect(repairUnit).not.toContain("LoadCredential=");
    expect(reviewUnit).toContain("User=concierge-review");
    expect(reviewUnit).toContain("ReadOnlyPaths=/var/lib/concierge-review/reviews/%i/repository");
    expect(reviewUnit).toContain("InaccessiblePaths=/root /etc/concierge");
    expect(reviewUnit).toContain("/var/lib/concierge-deployment/reviews/%i:/var/lib/concierge-review/reviews/%i/control");
    expect(reviewUnit).not.toContain("LoadCredential=");
    expect(coordinatorUnit).toContain("User=concierge-deploy");
    expect(coordinatorUnit).toContain("PrivateNetwork=true");
    expect(coordinatorUnit).toContain("CONCIERGE_DEPLOYMENT_CONTROL_ENABLED=0");
    expect(coordinatorUnit).toContain("CONCIERGE_AUTONOMOUS_REPAIR_ENABLED=0");
    expect(coordinatorUnit).toContain("CONCIERGE_COORDINATOR_SLOT=legacy");
    expect(coordinatorCandidateUnit).toContain("coordinator/slots/%i/coordinator.js");
    expect(coordinatorCandidateUnit).toContain("CONCIERGE_COORDINATOR_SLOT=%i");
    expect(coordinatorCandidateUnit).toContain("PrivateNetwork=true");
    expect(providerBrokerUnit).toContain("DynamicUser=yes");
    expect(providerBrokerUnit).toContain("User=cb-%i");
    expect(providerBrokerUnit).toContain("StateDirectory=concierge-provider-authority/%i");
    expect(providerWorkerUnit).toContain("DynamicUser=yes");
    expect(providerWorkerUnit).toContain("User=cp-%i");
    expect(providerWorkerUnit).toContain("StateDirectory=concierge-provider/projects/%i");
    expect(providerWorkerUnit).toContain("TemporaryFileSystem=/var/lib/concierge-provider/projects:ro");
    expect(script).toContain("install --backend=copyfile --frozen-lockfile --production");
    expect(() => readFileSync(join(repo, "capture-slack-app-manifest.json"), "utf-8")).toThrow();
    const installer = readFileSync(join(repo, "bot/scripts/install-capture-ingress.ts"), "utf-8");
    expect(installer).not.toContain("slack.toml");
    expect(installer).toContain("capture-queue.token");
    expect(installer).not.toContain("auth.test");
  });

  test("a changed kernel unit also restarts its dependent provider adapter", () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-control-activation-"));
    scratch.push(dir);
    const calls = join(dir, "systemctl.calls");
    const adapterVersionPath = join(dir, "provider-adapter-version");
    const providerRuntimeVersion = "c".repeat(64);
    const providerRuntimeRoot = join(dir, "provider-runtime");
    mkdirSync(join(providerRuntimeRoot, providerRuntimeVersion), { recursive: true });
    symlinkSync(providerRuntimeVersion, join(providerRuntimeRoot, "current"));
    const systemctl = join(dir, "systemctl");
    const bun = join(dir, "bun");
    executable(systemctl, [
      "#!/usr/bin/env bash",
      `echo "$*" >> ${JSON.stringify(calls)}`,
      `if [ "$*" = 'restart concierge-deployment-provider-adapter.service' ]; then echo '${"a".repeat(64)}' > ${JSON.stringify(adapterVersionPath)}; fi`,
      "exit 0",
    ]);
    executable(bun, [
      "#!/usr/bin/env bash",
      "if [[ \"$*\" == *'install-control-plane.ts'* ]]; then",
      `  printf '%s\\n' '{"kernel_version":"${"a".repeat(64)}","coordinator_version":"${"b".repeat(64)}","provider_version":"${providerRuntimeVersion}","kernel_changed":false,"coordinator_changed":false,"provider_changed":false,"dependencies_changed":false}'`,
      "else",
      `  printf '%s\\n' '{"kernel_runtime_version":"${"a".repeat(64)}"}'`,
      "fi",
    ]);
    const result = Bun.spawnSync({
      cmd: ["bash", "-c", `source "$1"; CONTROL_PLANE_KERNEL_UNIT_CHANGED=1; install_control_plane_runtime`, "test", deployScript],
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        CONCIERGE_REPO: repo,
        CONCIERGE_BUN_BIN: bun,
        CONCIERGE_PROVIDER_ADAPTER_VERSION_PATH: adapterVersionPath,
        CONCIERGE_PROVIDER_RUNTIME_CURRENT: join(providerRuntimeRoot, "current"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const serviceCalls = readFileSync(calls, "utf8");
    expect(serviceCalls).toContain("restart concierge-deployment-kernel.service");
    expect(serviceCalls).toContain("restart concierge-deployment-provider-adapter.service");
    expect(serviceCalls).not.toContain("restart concierge-deployment-coordinator.service");
    expect(serviceCalls.indexOf("restart concierge-deployment-kernel.service"))
      .toBeLessThan(serviceCalls.indexOf("restart concierge-deployment-provider-adapter.service"));
  });

  test("application containment is journaled under held gates and rolled back before admission release", () => {
    const script = readFileSync(deployScript, "utf8");
    const apply = script.indexOf("  apply_application_cutover\n");
    const activate = script.indexOf("  activate_immutable_release\n");
    const probe = script.indexOf("  probe_service\n", activate);
    const commit = script.indexOf("  commit_application_cutover\n");
    const release = script.indexOf("    release_deployment_gate\n", commit);
    expect(apply).toBeGreaterThan(0);
    expect(apply).toBeLessThan(activate);
    expect(activate).toBeLessThan(probe);
    expect(probe).toBeLessThan(commit);
    expect(commit).toBeLessThan(release);
    const cleanup = script.slice(
      script.indexOf("cleanup_failed_deployment()"),
      script.indexOf("block_new_capture_connections()"),
    );
    expect(cleanup.indexOf("rollback_application_cutover start"))
      .toBeLessThan(cleanup.indexOf("restore_prior_runtime"));
  });

  test("the committed lockfile supports the deploy's frozen production install", () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-frozen-install-"));
    scratch.push(dir);
    copyFileSync(join(repo, "bot/package.json"), join(dir, "package.json"));
    copyFileSync(join(repo, "bot/bun.lock"), join(dir, "bun.lock"));
    const result = Bun.spawnSync({
      cmd: [process.execPath, "install", "--backend=copyfile", "--frozen-lockfile", "--production"],
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  });

  test("the current-invocation online marker follows capture queue and user-token readiness", () => {
    const source = readFileSync(join(repo, "bot/src/index.ts"), "utf-8");
    const worker = readFileSync(join(repo, "bot/src/capture-delivery-worker.ts"), "utf-8");
    expect(source.indexOf("await captureDeliveryWorker.prepare()"))
      .toBeLessThan(source.indexOf("log(\"info\", \"concierge_bot_online\""));
    expect(source.indexOf("await captureDeliveryWorker.start()"))
      .toBeLessThan(source.indexOf("log(\"info\", \"concierge_bot_online\""));
    expect(source.indexOf("await verifySharedCodexAppServerReady()"))
      .toBeLessThan(source.indexOf("log(\"info\", \"concierge_bot_online\""));
    expect(readFileSync(join(repo, "bot/scripts/healthcheck.ts"), "utf-8"))
      .toContain('codex.request("model/list"');
    expect(worker).toContain("validateSlackUserToken");
    expect(worker).toContain("Capture queue readiness failed");
  });

  test("self-handoff escapes through systemd-run with the detached marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-handoff-test-"));
    scratch.push(dir);
    const calls = join(dir, "calls");
    executable(join(dir, "systemd-run"), ["#!/usr/bin/env bash", `printf '%s\\n' \"$*\" > ${JSON.stringify(calls)}`]);
    const result = Bun.spawnSync({
      cmd: ["bash", "-c", `source "$1"; handoff_from_concierge_service`, "test", deployScript],
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CONCIERGE_REPO: repo },
      stdout: "pipe", stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    const invocation = readFileSync(calls, "utf-8");
    expect(invocation).toContain("--no-block");
    expect(invocation).toContain(`--setenv=HOME=${process.env.HOME}`);
    expect(invocation).toContain("--setenv=CONCIERGE_DEPLOY_DETACHED=1");
    expect(invocation).toContain(deployScript);
  });

  test("agent deployment requests persist before launching one fixed transient unit", () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-agent-deploy-request-"));
    scratch.push(dir);
    const bunCalls = join(dir, "bun-calls");
    const systemdCalls = join(dir, "systemd-calls");
    executable(join(dir, "bun"), [
      "#!/usr/bin/env bash",
      `echo "$*|TURN=$CONCIERGE_TURN_ID|OWNER=$CONCIERGE_OWNER_INSTANCE_ID" >> ${JSON.stringify(bunCalls)}`,
      "echo '{\"status\":\"requested\",\"run_id\":\"run-1234567890\",\"request_id\":\"request-1\",\"unit_name\":\"concierge-deploy-run-1234567\",\"launch_required\":true,\"run_status\":\"prepared\"}'",
    ]);
    executable(join(dir, "systemd-run"), [
      "#!/usr/bin/env bash",
      `printf '%s\n' "$*" > ${JSON.stringify(systemdCalls)}`,
    ]);
    const sourceRepo = cleanGitCheckout();
    const result = Bun.spawnSync({
      cmd: ["bash", "-c", `source "$1"; request_agent_deployment`, "test", deployScript],
      cwd: sourceRepo,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        CONCIERGE_REPO: repo,
        CONCIERGE_BUN_BIN: join(dir, "bun"),
        CONCIERGE_TURN_ID: "42",
        CONCIERGE_OWNER_INSTANCE_ID: "runtime-42",
        CONCIERGE_APPROVE_CONTROL_PLANE_UPDATE: "1",
        CONCIERGE_PROMOTE_CONTROL_PLANE_CODEX_SHA256: "c".repeat(64),
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(readFileSync(bunCalls, "utf-8")).toContain("deploy-state.ts request --expected-commit");
    expect(readFileSync(bunCalls, "utf-8")).toContain("TURN=42|OWNER=runtime-42");
    const invocation = readFileSync(systemdCalls, "utf-8");
    expect(invocation).toContain("--unit concierge-deploy-run-1234567");
    expect(invocation).toContain("--setenv=CONCIERGE_DEPLOY_RUN_ID=run-1234567890");
    expect(invocation).toContain("--setenv=CONCIERGE_APPROVE_CONTROL_PLANE_UPDATE=1");
    expect(invocation).toContain(deployScript);
  });

  test("a coalesced agent deployment request does not launch another unit", () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-agent-deploy-coalesced-"));
    scratch.push(dir);
    executable(join(dir, "bun"), [
      "#!/usr/bin/env bash",
      "echo '{\"status\":\"requested\",\"run_id\":\"existing-run\",\"request_id\":\"request-2\",\"unit_name\":\"concierge-deploy-existing\",\"launch_required\":false,\"run_status\":\"draining\"}'",
    ]);
    const sourceRepo = cleanGitCheckout();
    const result = Bun.spawnSync({
      cmd: ["bash", "-c", `source "$1"; request_agent_deployment`, "test", deployScript],
      cwd: sourceRepo,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        CONCIERGE_REPO: repo,
        CONCIERGE_BUN_BIN: join(dir, "bun"),
        CONCIERGE_TURN_ID: "43",
        CONCIERGE_OWNER_INSTANCE_ID: "runtime-43",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toContain("joined existing batch existing-run");
  });

  test("one-shot control-plane authority cannot be dropped into an existing deployment batch", () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-agent-deploy-promotion-coalesced-"));
    scratch.push(dir);
    executable(join(dir, "bun"), [
      "#!/usr/bin/env bash",
      "echo '{\"status\":\"requested\",\"run_id\":\"existing-run\",\"request_id\":\"request-3\",\"unit_name\":\"concierge-deploy-existing\",\"launch_required\":false,\"run_status\":\"draining\"}'",
    ]);
    const sourceRepo = cleanGitCheckout();
    const result = Bun.spawnSync({
      cmd: ["bash", "-c", `source "$1"; request_agent_deployment`, "test", deployScript],
      cwd: sourceRepo,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        CONCIERGE_REPO: repo,
        CONCIERGE_BUN_BIN: join(dir, "bun"),
        CONCIERGE_TURN_ID: "44",
        CONCIERGE_OWNER_INSTANCE_ID: "runtime-44",
        CONCIERGE_APPROVE_CONTROL_PLANE_UPDATE: "1",
        CONCIERGE_PROMOTE_CONTROL_PLANE_CODEX_SHA256: "f".repeat(64),
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("cannot join an already-running deployment batch");
  });

  test("an agent deployment request preserves a captured state error", () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-agent-deploy-error-"));
    scratch.push(dir);
    executable(join(dir, "bun"), [
      "#!/usr/bin/env bash",
      "echo '{\"status\":\"error\",\"error\":\"no current owned turn\"}'",
      "exit 1",
    ]);
    const sourceRepo = cleanGitCheckout();
    const result = Bun.spawnSync({
      cmd: ["bash", "-c", `source "$1"; request_agent_deployment`, "test", deployScript],
      cwd: sourceRepo,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        CONCIERGE_REPO: repo,
        CONCIERGE_BUN_BIN: join(dir, "bun"),
        CONCIERGE_TURN_ID: "43",
        CONCIERGE_OWNER_INSTANCE_ID: "runtime-43",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("no current owned turn");
  });

  test("agent deployment rejects an uncommitted source worktree before persisting intent", () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-agent-deploy-dirty-"));
    scratch.push(dir);
    const sourceRepo = cleanGitCheckout();
    writeFileSync(join(sourceRepo, "uncommitted.txt"), "not in the requested commit\n");
    const bunCalls = join(dir, "bun-calls");
    executable(join(dir, "bun"), ["#!/usr/bin/env bash", `echo called >> ${JSON.stringify(bunCalls)}`]);
    const result = Bun.spawnSync({
      cmd: ["bash", "-c", `source "$1"; request_agent_deployment`, "test", deployScript],
      cwd: sourceRepo,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        CONCIERGE_REPO: repo,
        CONCIERGE_BUN_BIN: join(dir, "bun"),
        CONCIERGE_TURN_ID: "44",
        CONCIERGE_OWNER_INSTANCE_ID: "runtime-44",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("commit every source-worktree change");
    expect(() => readFileSync(bunCalls, "utf-8")).toThrow();
  });

  test("bootstrap handoff preserves HOME for GitHub credential lookup", () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-bootstrap-handoff-test-"));
    scratch.push(dir);
    const calls = join(dir, "calls");
    executable(join(dir, "systemd-run"), ["#!/usr/bin/env bash", `printf '%s\\n' "$*" > ${JSON.stringify(calls)}`]);
    const result = Bun.spawnSync({
      cmd: ["bash", "-c", `source "$1"; handoff_from_concierge_service`, "test", bootstrapScript],
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CONCIERGE_REPO: repo },
      stdout: "pipe", stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    const invocation = readFileSync(calls, "utf-8");
    expect(invocation).toContain(`--setenv=HOME=${process.env.HOME}`);
    expect(invocation).toContain("--setenv=CONCIERGE_BOOTSTRAP_DETACHED=1");
    expect(invocation).toContain(bootstrapScript);
  });

  test("pull failure releases the token through the EXIT trap", () => {
    const fake = fakeDrain([0, 0]);
    const dir = mkdtempSync(join(tmpdir(), "concierge-pull-test-"));
    scratch.push(dir);
    executable(join(dir, "git"), [
      "#!/usr/bin/env bash",
      "[ \"$1\" = ls-remote ] && exit 0",
      "[ \"$1\" = fetch ] && exit 0",
      "exit 1",
    ]);
    executable(join(dir, "systemd-sysusers"), ["#!/usr/bin/env bash", "exit 0"]);
    const result = Bun.spawnSync({
      cmd: ["bash", deployScript],
      env: {
        ...process.env, PATH: `${dir}:${process.env.PATH}`, CONCIERGE_REPO: repo,
        CONCIERGE_BUN_BIN: fake.bun, CONCIERGE_DEPLOY_DETACHED: "1",
        CONCIERGE_CAPTURE_USER: process.env.USER || "root",
        CONCIERGE_CAPTURE_STATE_DIR: join(dir, "capture-state"),
        CONCIERGE_CAPTURE_AUDIO_DIR: join(dir, "audio"),
        CONCIERGE_SYSUSERS_DIR: join(dir, "sysusers"),
      },
      stdout: "pipe", stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(readFileSync(fake.calls, "utf-8")).toContain("release-live capture-token");
  });

  test("TERM releases a claimed token", () => {
    const fake = fakeDrain([0, 0]);
    const result = Bun.spawnSync({
      cmd: ["bash", "-c", `source "$1"; claim_deployment_gate; trap release_deployment_gate EXIT; trap 'exit 143' TERM; kill -TERM $$`, "test", deployScript],
      env: { ...process.env, CONCIERGE_REPO: repo, CONCIERGE_BUN_BIN: fake.bun },
      stdout: "pipe", stderr: "pipe",
    });

    expect(result.exitCode).toBe(143);
    expect(readFileSync(fake.calls, "utf-8")).toContain("release capture-token");
  });

  test("a bot restart failure leaves capture delivery durably held", () => {
    const fake = fakeDrain([0, 0]);
    const dir = mkdtempSync(join(tmpdir(), "concierge-bot-restart-failure-"));
    scratch.push(dir);
    executable(join(dir, "systemctl"), ["#!/usr/bin/env bash", "exit 1"]);
    const result = Bun.spawnSync({
      cmd: ["bash", "-c", `source "$1"; claim_deployment_gate; trap cleanup_failed_deployment EXIT; hold_capture_gate; systemctl restart concierge-bot`, "test", deployScript],
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CONCIERGE_REPO: repo, CONCIERGE_BUN_BIN: fake.bun },
      stdout: "pipe", stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    const calls = readFileSync(fake.calls, "utf-8");
    expect(calls).toContain("hold capture-token");
    expect(calls).toContain("release turn-token");
    expect(calls).not.toContain("release capture-token");
  });

  test("a failed bot functional probe leaves capture delivery durably held", () => {
    const fake = fakeDrain([0, 0]);
    const dir = mkdtempSync(join(tmpdir(), "concierge-bot-probe-failure-"));
    scratch.push(dir);
    executable(join(dir, "systemctl"), ["#!/usr/bin/env bash", "exit 0"]);
    const result = Bun.spawnSync({
      cmd: ["bash", "-c", `source "$1"; claim_deployment_gate; trap cleanup_failed_deployment EXIT; hold_capture_gate; systemctl restart concierge-bot; probe_service() { return 1; }; probe_service`, "test", deployScript],
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CONCIERGE_REPO: repo, CONCIERGE_BUN_BIN: fake.bun },
      stdout: "pipe", stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    const calls = readFileSync(fake.calls, "utf-8");
    expect(calls).toContain("hold capture-token");
    expect(calls).toContain("release turn-token");
    expect(calls).not.toContain("release capture-token");
  });

  test("a bootstrap failure after ingress starts leaves capture delivery durably held", () => {
    const fake = fakeDrain([0]);
    const dir = mkdtempSync(join(tmpdir(), "concierge-bootstrap-capture-failure-"));
    scratch.push(dir);
    executable(join(dir, "systemctl"), ["#!/usr/bin/env bash", "exit 0"]);
    const result = Bun.spawnSync({
      cmd: ["bash", "-c", `source "$1"; claim_capture_gate; hold_capture_gate; trap cleanup_failed_deployment EXIT; systemctl restart agent-inbox.service; probe_capture_ingress() { return 1; }; probe_capture_ingress`, "test", deployScript],
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CONCIERGE_REPO: repo, CONCIERGE_BUN_BIN: fake.bun },
      stdout: "pipe", stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    const calls = readFileSync(fake.calls, "utf-8");
    expect(calls).toContain("hold capture-token");
    expect(calls).not.toContain("release capture-token");
  });

  test("cleanup cannot release a hold that committed before an ambiguous command failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-ambiguous-hold-"));
    scratch.push(dir);
    const calls = join(dir, "calls");
    const bun = join(dir, "bun");
    executable(bun, [
      "#!/usr/bin/env bash",
      `echo \"$*\" >> ${JSON.stringify(calls)}`,
      "if [[ \"$*\" == *' hold '* ]]; then echo '{\"status\":\"held\"}'; exit 7; fi",
      "if [[ \"$*\" == *' release-live '* ]]; then echo '{\"status\":\"retained_held\"}'; exit 0; fi",
      "exit 1",
    ]);
    const result = Bun.spawnSync({
      cmd: ["bash", "-c", `source "$1"; CAPTURE_DRAIN_TOKEN=capture-token; trap cleanup_failed_deployment EXIT; hold_capture_gate`, "test", deployScript],
      env: { ...process.env, CONCIERGE_REPO: repo, CONCIERGE_BUN_BIN: bun },
      stdout: "pipe", stderr: "pipe",
    });

    expect(result.exitCode).toBe(7);
    const operations = readFileSync(calls, "utf-8");
    expect(operations).toContain("hold capture-token");
    expect(operations).toContain("release-live capture-token");
    expect(operations).not.toMatch(/\srelease capture-token/);
  });

  test("probe requires the current InvocationID marker and Slack probe", () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-probe-test-"));
    scratch.push(dir);
    const bunCalls = join(dir, "bun-calls");
    const journalCalls = join(dir, "journal-calls");
    executable(join(dir, "systemctl"), [
      "#!/usr/bin/env bash",
      "case \"$*\" in",
      "  'is-active concierge-bot') echo active ;;",
      "  *'--property=MainPID'*) echo 321 ;;",
      "  *'--property=InvocationID'*) echo invocation-123 ;;",
      "esac",
    ]);
    executable(join(dir, "journalctl"), ["#!/usr/bin/env bash", `echo \"$*\" >> ${JSON.stringify(journalCalls)}`, "[ \"$1\" = '_SYSTEMD_INVOCATION_ID=invocation-123' ] && echo concierge_bot_online"]);
    executable(join(dir, "bun"), ["#!/usr/bin/env bash", `echo \"$*\" >> ${JSON.stringify(bunCalls)}`, "exit 0"]);
    const result = Bun.spawnSync({
      cmd: ["bash", "-c", `source "$1"; probe_service`, "test", deployScript],
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CONCIERGE_REPO: repo, CONCIERGE_BUN_BIN: join(dir, "bun") },
      stdout: "pipe", stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("InvocationID=invocation-123");
    expect(readFileSync(bunCalls, "utf-8")).toContain("healthcheck.ts");
    expect(readFileSync(journalCalls, "utf-8")).toContain("_SYSTEMD_INVOCATION_ID=invocation-123");
  });

  test("probe rejects an online marker from a stale InvocationID", () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-stale-probe-test-"));
    scratch.push(dir);
    const bunCalls = join(dir, "bun-calls");
    executable(join(dir, "systemctl"), [
      "#!/usr/bin/env bash", "case \"$*\" in",
      "  'is-active concierge-bot') echo active ;;",
      "  *'--property=MainPID'*) echo 321 ;;",
      "  *'--property=InvocationID'*) echo current-invocation ;;", "esac",
    ]);
    executable(join(dir, "journalctl"), ["#!/usr/bin/env bash", "[ \"$1\" = '_SYSTEMD_INVOCATION_ID=stale-invocation' ] && echo concierge_bot_online"]);
    executable(join(dir, "sleep"), ["#!/usr/bin/env bash", "exit 0"]);
    executable(join(dir, "bun"), ["#!/usr/bin/env bash", `echo called >> ${JSON.stringify(bunCalls)}`, "exit 0"]);
    const result = Bun.spawnSync({
      cmd: ["bash", "-c", `source "$1"; probe_service`, "test", deployScript],
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CONCIERGE_REPO: repo, CONCIERGE_BUN_BIN: join(dir, "bun") },
      stdout: "pipe", stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(() => readFileSync(bunCalls, "utf-8")).toThrow();
  });

  test("an enrolled deploy rejects a healthy service running the wrong commit", () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-provenance-probe-test-"));
    scratch.push(dir);
    const expected = "a".repeat(40);
    const actual = "b".repeat(40);
    executable(join(dir, "systemctl"), [
      "#!/usr/bin/env bash",
      "case \"$*\" in",
      "  'is-active concierge-bot') echo active ;;",
      "  *'--property=MainPID'*) echo 321 ;;",
      "  *'--property=InvocationID'*) echo invocation-provenance ;;",
      "esac",
    ]);
    executable(join(dir, "journalctl"), [
      "#!/usr/bin/env bash",
      `[ "$1" = '_SYSTEMD_INVOCATION_ID=invocation-provenance' ] && echo '{"event":"concierge_bot_online","git_sha":"${actual}"}'`,
    ]);
    executable(join(dir, "bun"), ["#!/usr/bin/env bash", "exit 0"]);
    const result = Bun.spawnSync({
      cmd: ["bash", "-c", `source "$1"; DEPLOYED_COMMIT=${expected}; probe_service`, "test", deployScript],
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        CONCIERGE_REPO: repo,
        CONCIERGE_BUN_BIN: join(dir, "bun"),
        CONCIERGE_DEPLOY_RUN_ID: "run-provenance",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(`runtime reported ${actual}, expected ${expected}`);
  });

  test("terminal success becomes ambiguous when the service invocation drifts after its health gate", () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-terminal-provenance-test-"));
    scratch.push(dir);
    const bunCalls = join(dir, "bun-calls");
    const expected = "c".repeat(40);
    executable(join(dir, "systemctl"), [
      "#!/usr/bin/env bash",
      "case \"$*\" in",
      "  'is-active concierge-bot') echo active ;;",
      "  *'--property=MainPID'*) echo 321 ;;",
      "  *'--property=InvocationID'*) echo invocation-replacement ;;",
      "esac",
    ]);
    executable(join(dir, "journalctl"), [
      "#!/usr/bin/env bash",
      `[ "$1" = '_SYSTEMD_INVOCATION_ID=invocation-replacement' ] && echo '{"event":"concierge_bot_online","git_sha":"${expected}"}'`,
    ]);
    executable(join(dir, "bun"), [
      "#!/usr/bin/env bash",
      `echo "$*" >> ${JSON.stringify(bunCalls)}`,
      "exit 0",
    ]);
    const result = Bun.spawnSync({
      cmd: [
        "bash",
        "-c",
        `source "$1"; DEPLOYED_COMMIT=${expected}; DEPLOYED_INVOCATION_ID=invocation-original; DEPLOYED_RUNTIME_SHA=${expected}; confirm_service_proof_is_current`,
        "test",
        deployScript,
      ],
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        CONCIERGE_REPO: repo,
        CONCIERGE_BUN_BIN: join(dir, "bun"),
        CONCIERGE_DEPLOY_RUN_ID: "run-terminal-provenance",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    const calls = readFileSync(bunCalls, "utf-8");
    expect(calls).toContain("healthcheck.ts");
    expect(calls).toContain("deploy-state.ts fail");
    expect(calls).toContain("--outcome ambiguous");
    expect(calls).not.toContain("deploy-state.ts succeed");
  });

  test("capture probe requires a live process and the local HTTP health check", () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-capture-probe-test-"));
    scratch.push(dir);
    const bunCalls = join(dir, "bun-calls");
    executable(join(dir, "systemctl"), [
      "#!/usr/bin/env bash",
      "case \"$*\" in",
      "  'is-active agent-inbox.service') echo active ;;",
      "  *'--property=MainPID'*) echo 654 ;;",
      "esac",
    ]);
    executable(join(dir, "bun"), ["#!/usr/bin/env bash", `echo "$*" >> ${JSON.stringify(bunCalls)}`, "exit 0"]);
    const result = Bun.spawnSync({
      cmd: ["bash", "-c", `source "$1"; probe_capture_ingress`, "test", deployScript],
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CONCIERGE_REPO: repo, CONCIERGE_BUN_BIN: join(dir, "bun") },
      stdout: "pipe", stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("Capture ingress probe passed");
    expect(readFileSync(bunCalls, "utf-8")).toContain("capture-healthcheck.ts");
  });

  test("bootstraps a pre-migration database through a stopped-admission restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-bootstrap-test-"));
    scratch.push(dir);
    const bin = join(dir, "bin");
    const cgroup = join(dir, "cgroup/fake");
    const installed = join(dir, "systemd");
    const serviceState = join(dir, "service-state");
    const calls = join(dir, "calls");
    const coordinatorVersionPath = join(dir, "coordinator-version");
    const adapterVersionPath = join(dir, "provider-adapter-version");
    const providerRuntimeVersion = "c".repeat(64);
    const providerRuntimeRoot = join(dir, "provider-runtime");
    const oldState = join(dir, "state");
    const uploadState = join(dir, "upload-state");
    mkdirSync(bin, { recursive: true });
    mkdirSync(cgroup, { recursive: true });
    mkdirSync(installed, { recursive: true });
    mkdirSync(oldState, { recursive: true });
    mkdirSync(join(providerRuntimeRoot, providerRuntimeVersion), { recursive: true });
    symlinkSync(providerRuntimeVersion, join(providerRuntimeRoot, "current"));
    writeFileSync(join(cgroup, "cgroup.procs"), "100\n");
    writeFileSync(serviceState, "active");
    writeFileSync(uploadState, "active");
    Bun.spawnSync({ cmd: ["sqlite3", join(oldState, "state.db"), "CREATE TABLE turns(id INTEGER PRIMARY KEY, status TEXT);"] });
    executable(join(bin, "git"), [
      "#!/usr/bin/env bash",
      `echo "git $*" >> ${JSON.stringify(calls)}`,
      "[ \"$*\" = 'rev-parse HEAD' ] && echo 0123456789abcdef0123456789abcdef01234567",
      "exit 0",
    ]);
    executable(join(bin, "systemctl"), [
      "#!/usr/bin/env bash",
      `state=${JSON.stringify(serviceState)}`,
      `calls=${JSON.stringify(calls)}`,
      "echo \"systemctl $*\" >> \"$calls\"",
      "case \"$*\" in",
      "  *'--property=MainPID'*) echo 100 ;;",
      "  *'--property=ControlGroup'*) echo /fake ;;",
      "  *'--property=InvocationID'*) echo bootstrap-invocation ;;",
      "  'is-active --quiet concierge-bot') [ \"$(cat \"$state\")\" = active ] ;;",
      "  'is-active concierge-bot') echo active ;;",
      "  'is-active agent-inbox.service') echo active ;;",
      "  'stop concierge-bot') echo stopped > \"$state\" ;;",
      "  'restart concierge-bot') echo active > \"$state\" ;;",
      `  'restart concierge-deployment-provider-adapter.service') echo '${"a".repeat(64)}' > ${JSON.stringify(adapterVersionPath)} ;;`,
      `  'restart concierge-deployment-coordinator.service') echo '${"b".repeat(64)}' > ${JSON.stringify(coordinatorVersionPath)} ;;`,
      "esac",
    ]);
    executable(join(bin, "journalctl"), ["#!/usr/bin/env bash", "echo concierge_bot_online"]);
    executable(join(bin, "systemd-sysusers"), ["#!/usr/bin/env bash", "exit 0"]);
    executable(join(bin, "systemd-tmpfiles"), ["#!/usr/bin/env bash", "exit 0"]);
    executable(join(bin, "iptables"), [
      "#!/usr/bin/env bash",
      `echo "iptables $*" >> ${JSON.stringify(calls)}`,
      "[[ \"$*\" == *' -C '* ]] && exit 1",
      "exit 0",
    ]);
    executable(join(bin, "ss"), [
      "#!/usr/bin/env bash",
      `calls=${JSON.stringify(calls)}`,
      `upload_state=${JSON.stringify(uploadState)}`,
      "if [ \"$(cat \"$upload_state\")\" = active ]; then",
      "  echo 'ss active' >> \"$calls\"",
      "  echo '127.0.0.1:8080 127.0.0.1:54321'",
      "  (sleep 0.05; echo drained > \"$upload_state\") >/dev/null 2>&1 &",
      "else",
      "  echo 'ss drained' >> \"$calls\"",
      "fi",
      "exit 0",
    ]);
    executable(join(bin, "bun"), [
      "#!/usr/bin/env bash",
      `echo "bun $*" >> ${JSON.stringify(calls)}`,
      "if [[ \"$*\" == *capture-drain-status.ts*claim* ]]; then echo '{\"status\":\"claimed_drained\",\"token\":\"capture-token\"}'; exit 0; fi",
      "if [[ \"$*\" == *capture-drain-status.ts*release* ]]; then echo '{\"status\":\"released\"}'; exit 0; fi",
      "if [[ \"$*\" == *'control.ts bootstrap-release'* ]]; then echo '{\"release\":{\"id\":\"release-1\",\"status\":\"candidate\"},\"prior_last_known_good\":null}'; exit 0; fi",
      "if [[ \"$*\" == *'control.ts notifier-bootstrap'* ]]; then echo '{\"target\":{\"slack_channel_id\":\"C-project\"}}'; exit 0; fi",
      "if [[ \"$*\" == *'control.ts notifier-preflight'* ]]; then echo '{\"target\":{\"preflight_at\":\"now\"}}'; exit 0; fi",
      `if [[ "$*" == *'install-control-plane.ts'* ]]; then echo '{"kernel_version":"${"a".repeat(64)}","coordinator_version":"${"b".repeat(64)}","provider_version":"${providerRuntimeVersion}","kernel_changed":false,"coordinator_changed":false,"provider_changed":false,"dependencies_changed":false}'; exit 0; fi`,
      `if [[ "$*" == *'control.ts snapshot'* ]]; then echo '{"kernel_runtime_version":"${"a".repeat(64)}"}'; exit 0; fi`,
      "if [[ \"$*\" == *'control.ts bootstrap-activate-release'* ]]; then systemctl restart concierge-bot; echo '{\"release\":{\"id\":\"release-1\"}}'; exit 0; fi",
      "if [[ \"$*\" == *'control.ts bootstrap-promote-release'* ]]; then echo '{\"release\":{\"id\":\"release-1\",\"status\":\"last_known_good\"}}'; exit 0; fi",
      "if [ \"$1\" = build ]; then for ((i=1; i<=$#; i++)); do [ \"${!i}\" = --outfile ] && { next=$((i+1)); touch \"${!next}\"; }; done; fi",
      "exit 0",
    ]);
    const result = Bun.spawnSync({
      cmd: ["bash", bootstrapScript],
      env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, CONCIERGE_REPO: repo,
        CONCIERGE_CGROUP_ROOT: join(dir, "cgroup"), CONCIERGE_SYSTEMD_DIR: installed,
        CONCIERGE_STATE_DIR: oldState, CONCIERGE_BUN_BIN: join(bin, "bun"),
        CONCIERGE_CAPTURE_USER: process.env.USER || "root",
        CONCIERGE_CAPTURE_STATE_DIR: join(dir, "capture-state"),
        CONCIERGE_CAPTURE_AUDIO_DIR: join(dir, "audio"),
        CONCIERGE_CAPTURE_RUNTIME_DIR: join(dir, "runtime"),
        CONCIERGE_CAPTURE_CONFIG_DEST: join(dir, "config/capture-routes.toml"),
        CONCIERGE_SYSUSERS_DIR: join(dir, "sysusers"),
        CONCIERGE_TMPFILES_DIR: join(dir, "tmpfiles"),
        CONCIERGE_COORDINATOR_VERSION_PATH: coordinatorVersionPath,
        CONCIERGE_PROVIDER_ADAPTER_VERSION_PATH: adapterVersionPath,
        CONCIERGE_PROVIDER_RUNTIME_CURRENT: join(providerRuntimeRoot, "current"),
        CONCIERGE_IPTABLES_BIN: join(bin, "iptables"),
        CONCIERGE_SS_BIN: join(bin, "ss"),
        CONCIERGE_DRAIN_INTERVAL_SECONDS: "0.01",
        CONCIERGE_BOOTSTRAP_DETACHED: "1",
      },
      stdout: "pipe", stderr: "pipe",
    });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const operations = readFileSync(calls, "utf-8");
    expect(operations.indexOf("systemctl stop concierge-bot")).toBeLessThan(operations.indexOf("git pull --rebase origin main"));
    expect(operations).not.toContain("git ls-remote");
    expect(operations.indexOf("systemctl freeze concierge-bot")).toBeLessThan(operations.indexOf("systemctl stop concierge-bot"));
    expect(operations).toContain("systemctl restart concierge-bot");
    expect(operations.indexOf("capture-drain-status.ts claim")).toBeLessThan(operations.indexOf("systemctl start agent-inbox.service"));
    expect(operations.indexOf("capture-drain-status.ts hold")).toBeLessThan(operations.indexOf("systemctl start agent-inbox.service"));
    expect(operations.indexOf("iptables -w -I OUTPUT")).toBeLessThan(operations.indexOf("systemctl stop agent-inbox.service"));
    expect(operations).toContain("ss active");
    expect(operations.indexOf("ss drained")).toBeLessThan(operations.indexOf("systemctl stop agent-inbox.service"));
    expect(operations.indexOf("systemctl stop agent-inbox.service")).toBeLessThan(operations.indexOf("systemctl start agent-inbox.service"));
    expect(operations.indexOf("systemctl start agent-inbox.service")).toBeLessThan(operations.indexOf("iptables -w -D OUTPUT"));
    expect(operations.indexOf("systemctl restart concierge-bot")).toBeLessThan(operations.indexOf("capture-drain-status.ts release"));
    expect(readFileSync(join(installed, "concierge-bot.service"), "utf-8")).toContain("KillMode=mixed");
  });

  test("bootstrap bypass is refused while the service is active", () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-bootstrap-refusal-test-"));
    scratch.push(dir);
    const stateDir = join(dir, "state");
    mkdirSync(stateDir);
    writeFileSync(join(stateDir, "bootstrap-deploy.token"), "valid-token\n");
    executable(join(dir, "systemctl"), ["#!/usr/bin/env bash", "[ \"$1\" = is-active ] && exit 0", "exit 0"]);
    executable(join(dir, "systemd-sysusers"), ["#!/usr/bin/env bash", "exit 0"]);
    const result = Bun.spawnSync({
      cmd: ["bash", deployScript],
      env: {
        ...process.env, PATH: `${dir}:${process.env.PATH}`, CONCIERGE_REPO: repo,
        CONCIERGE_STATE_DIR: stateDir, CONCIERGE_BOOTSTRAP_STOPPED: "1",
        CONCIERGE_BOOTSTRAP_TOKEN: "valid-token", CONCIERGE_DEPLOY_DETACHED: "1",
        CONCIERGE_CAPTURE_USER: process.env.USER || "root",
        CONCIERGE_CAPTURE_STATE_DIR: join(dir, "capture-state"),
        CONCIERGE_CAPTURE_AUDIO_DIR: join(dir, "audio"),
        CONCIERGE_SYSUSERS_DIR: join(dir, "sysusers"),
      },
      stdout: "pipe", stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("still active");
    expect(readFileSync(join(stateDir, "bootstrap-deploy.token"), "utf-8")).toContain("valid-token");
  });

  test("systemd graceful stop signals only main and reserves cgroup cleanup for forced kill", () => {
    const unit = readFileSync(join(repo, "systemd/concierge-bot.service"), "utf-8");
    expect(unit).toContain("TimeoutStopSec=infinity");
    expect(unit).toContain("KillMode=mixed");
  });

  test("mixed KillMode leaves a provider child unsignaled during main-process drain", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-systemd-stop-test-"));
    scratch.push(dir);
    const ready = join(dir, "ready");
    const completed = join(dir, "child-completed");
    const childTerm = join(dir, "child-term");
    const runner = join(dir, "runner.sh");
    const unit = `concierge-stop-test-${process.pid}-${Date.now()}`;
    executable(runner, [
      "#!/usr/bin/env bash",
      "set -u",
      "ready=$1; completed=$2; child_term=$3",
      "( trap 'echo term > \"$child_term\"; exit 99' TERM; sleep 1; echo complete > \"$completed\" ) &",
      "child=$!",
      "trap 'wait \"$child\"; exit 0' TERM",
      "echo ready > \"$ready\"",
      "wait \"$child\"",
    ]);
    const started = Bun.spawnSync({
      cmd: ["systemd-run", "--unit", unit, "--property=Type=simple", "--property=KillMode=mixed", "--property=TimeoutStopSec=10s", runner, ready, completed, childTerm],
      stdout: "pipe", stderr: "pipe",
    });
    expect(started.exitCode).toBe(0);
    for (let attempt = 0; attempt < 20 && !Bun.file(ready).size; attempt++) await Bun.sleep(50);
    expect(Bun.file(ready).size).toBeGreaterThan(0);

    const stopped = Bun.spawnSync({ cmd: ["systemctl", "stop", unit], stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync({ cmd: ["systemctl", "reset-failed", unit], stdout: "ignore", stderr: "ignore" });
    expect(stopped.exitCode).toBe(0);
    expect(readFileSync(completed, "utf-8")).toContain("complete");
    expect(() => readFileSync(childTerm, "utf-8")).toThrow();
  }, 15_000);

  test("legacy bootstrap does not stop while a provider child remains", () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-legacy-wait-test-"));
    scratch.push(dir);
    const bin = join(dir, "bin");
    const cgroup = join(dir, "cgroup/fake");
    const procs = join(cgroup, "cgroup.procs");
    const calls = join(dir, "calls");
    mkdirSync(bin, { recursive: true });
    mkdirSync(cgroup, { recursive: true });
    writeFileSync(procs, "100\n200\n");
    executable(join(bin, "systemctl"), [
      "#!/usr/bin/env bash",
      `echo \"$*\" >> ${JSON.stringify(calls)}`,
      "case \"$*\" in",
      "  'is-active --quiet concierge-bot') exit 0 ;;",
      "  *'--property=MainPID'*) echo 100 ;;",
      "  *'--property=ControlGroup'*) echo /fake ;;",
      "esac",
    ]);
    executable(join(bin, "sleep"), ["#!/usr/bin/env bash", `printf '100\\n' > ${JSON.stringify(procs)}`]);
    const result = Bun.spawnSync({
      cmd: ["bash", "-c", `source "$1"; count=0; systemctl() { if [ \"$*\" = 'is-active --quiet concierge-bot' ]; then count=$((count+1)); [ $count -le 2 ]; else command systemctl \"$@\"; fi; }; wait_for_legacy_turns`, "test", bootstrapScript],
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CONCIERGE_REPO: repo, CONCIERGE_CGROUP_ROOT: join(dir, "cgroup"), CONCIERGE_DRAIN_INTERVAL_SECONDS: "0" },
      stdout: "pipe", stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("still owns child process(es): 200");
  });
});
