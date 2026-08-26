import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../..");
const deployScript = join(repo, "bot/scripts/deploy.sh");
const bootstrapScript = join(repo, "bot/scripts/bootstrap-deploy.sh");
const deploymentRepairCutoverScript = join(repo, "bot/scripts/deployment-repair-cutover.sh");
const projectCutoverScript = join(repo, "bot/scripts/project-scaffold-cutover.sh");
const scratch: string[] = [];

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fakeDrain(statuses: number[], claimStatus = 0) {
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
    "if [[ \"$*\" == *'deploy-state.ts operator-request'* ]]; then echo '{\"status\":\"requested\",\"run_id\":\"operator-run\",\"unit_name\":\"concierge-deploy-operator\",\"launch_required\":true,\"run_status\":\"prepared\"}'; exit 0; fi",
    "if [[ \"$*\" == *'deploy-state.ts claim'* ]]; then echo '{\"status\":\"draining\"}'; exit 0; fi",
    "if [[ \"$*\" == *'deploy-state.ts phase'* ]]; then echo '{\"status\":\"updating\"}'; exit 0; fi",
    "if [[ \"$*\" == *'deploy-state.ts fail'* ]]; then echo '{\"status\":\"failed\"}'; exit 0; fi",
    "if [[ \"$*\" == *'migrate-deployment-repair.ts'* ]]; then echo '{\"status\":\"migrated\"}'; exit 0; fi",
    "if [[ \"$*\" == *'release-manager.ts lkg'* || \"$*\" == *'release-manager.ts restore-lkg'* ]]; then echo '{\"status\":\"lkg\",\"git_commit\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"}'; exit 0; fi",
    "if [[ \"$*\" == *' release '* || \"$*\" == *' release-live '* ]]; then echo '{\"status\":\"released\"}'; exit 0; fi",
    "if [[ \"$*\" == *' hold '* ]]; then echo '{\"status\":\"held\"}'; exit 0; fi",
    "if [[ \"$*\" == *capture-drain-status.ts*claim* ]]; then echo '{\"status\":\"claimed_drained\",\"token\":\"capture-token\"}'; exit 0; fi",
    "if [[ \"$*\" == *drain-status.ts*claim* ]]; then",
    `  if [ ${claimStatus} -ne 0 ]; then echo '{"status":"error"}'; exit ${claimStatus}; fi`,
    "  status=$(head -1 \"$state\")",
    "  tail -n +2 \"$state\" > \"$state.next\"",
    "  mv \"$state.next\" \"$state\"",
    "  if [ \"$status\" = 10 ]; then echo '{\"status\":\"claimed_draining\",\"token\":\"turn-token\",\"active\":[{\"turn_id\":1}],\"stale\":[]}'; else echo '{\"status\":\"claimed_drained\",\"token\":\"turn-token\",\"active\":[],\"stale\":[]}'; fi",
    "  exit 0",
    "fi",
    "status=$(head -1 \"$state\")",
    "[ -n \"$status\" ] || status=0",
    "tail -n +2 \"$state\" > \"$state.next\"",
    "mv \"$state.next\" \"$state\"",
    "if [ \"$status\" = 0 ]; then echo '{\"status\":\"drained\",\"active\":[],\"stale\":[]}'",
    "elif [ \"$status\" = 10 ]; then echo '{\"status\":\"active\",\"active\":[{\"turn_id\":1}],\"stale\":[]}'",
    "elif [ \"$status\" = 20 ]; then echo '{\"status\":\"stale\",\"active\":[],\"stale\":[{\"turn_id\":1}]}'",
    "else echo '{\"status\":\"error\"}'",
    "fi",
    "exit \"$status\"",
  ].join("\n"));
  chmodSync(bun, 0o755);
  return { bun, calls, dir };
}

function executable(path: string, lines: string[]) {
  writeFileSync(path, lines.join("\n"));
  chmodSync(path, 0o755);
}

function runClaim(bun: string) {
  return Bun.spawnSync({
    cmd: ["bash", "-c", `source "$1"; claim_deployment_gate`, "test", deployScript],
    env: {
      ...process.env,
      CONCIERGE_REPO: repo,
      CONCIERGE_BUN_BIN: bun,
      CONCIERGE_DRAIN_INTERVAL_SECONDS: "0",
      CONCIERGE_DEPLOY_IDLE_RECHECK_SECONDS: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("drain-aware deploy", () => {
  test.each(["success", "promotion-fails", "helper-missing"])("promotion refreshes the installed router wrapper before success (%s)", outcome => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-router-promotion-test-"));
    scratch.push(dir);
    const fixtureRepo = join(dir, "repo");
    const oldControl = join(dir, "lkg/control");
    const candidate = join(dir, "candidate");
    const installed = join(dir, "bin/router-actions.sh");
    const calls = join(dir, "calls");
    const oldWrapper = "#!/usr/bin/env bash\necho old-wrapper\n";
    const newWrapper = readFileSync(join(repo, "systemd/router-actions.sh"), "utf8");
    mkdirSync(join(fixtureRepo, "bot"), { recursive: true });
    mkdirSync(join(oldControl, "systemd"), { recursive: true });
    mkdirSync(join(candidate, "control/systemd"), { recursive: true });
    writeFileSync(join(oldControl, "deploy-state.js"), "");
    writeFileSync(join(oldControl, "systemd/router-actions.sh"), oldWrapper);
    if (outcome !== "helper-missing") writeFileSync(join(candidate, "control/systemd/router-actions.sh"), newWrapper);
    const result = Bun.spawnSync({
      cmd: ["bash", "-c", [
        'source "$1"',
        "for name in claim_run_and_enable_recovery validate_bootstrap_handoff prepare_capture_identity claim_capture_gate hold_capture_gate install_repository_git_hooks require_last_known_good_release install_deployment_runtime install_capture_runtime block_new_capture_connections wait_for_capture_connections unblock_capture_admission probe_capture_ingress record_deployment_phase cleanup_failed_deployment chown systemctl git; do",
        '  eval "$name() { :; }"',
        "done",
        'fake_bun() { if [[ "$*" == *" promote "* ]]; then echo promote >> "$TEST_CALLS"; return "$TEST_PROMOTION_STATUS"; fi; }',
        'BUN_BIN=fake_bun',
        'MIGRATION_DONE=1',
        'prepare_candidate_release() { CANDIDATE_ARTIFACT_PATH="$TEST_CANDIDATE"; CANDIDATE_ARTIFACT_DIGEST=fixture; }',
        'install_systemd_units() { printf "units:%s\\n" "$CONTROL_SYSTEMD_DIR" >> "$TEST_CALLS"; }',
        'probe_service() { cmp "$ROUTER_ACTIONS_DEST" "$TEST_OLD_WRAPPER"; }',
        'confirm_service_proof_is_current() { probe_service; }',
        'record_deployment_success() { echo success >> "$TEST_CALLS"; }',
        "deploy",
      ].join("\n"), "test", deployScript],
      env: { ...process.env, CONCIERGE_REPO: fixtureRepo, CONCIERGE_DEPLOY_RUN_ID: "fixture-run",
        CONCIERGE_DEPLOYMENT_CONTROL_ROOT: oldControl, CONCIERGE_ROUTER_ACTIONS_DEST: installed,
        CONCIERGE_BOOTSTRAP_STOPPED: "1", TEST_CANDIDATE: candidate, TEST_CALLS: calls,
        TEST_OLD_WRAPPER: join(oldControl, "systemd/router-actions.sh"),
        TEST_PROMOTION_STATUS: outcome === "promotion-fails" ? "1" : "0" },
      stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(outcome === "success" ? 0 : 1);
    expect(readFileSync(installed, "utf8")).toBe(outcome === "success" ? newWrapper : oldWrapper);
    const operations = readFileSync(calls, "utf8").trim().split("\n");
    expect(operations).toEqual([
      `units:${oldControl}/systemd`, "promote",
      ...(outcome === "promotion-fails" ? [] : [`units:${candidate}/control/systemd`]),
      ...(outcome === "success" ? ["success"] : []),
    ]);
    if (outcome === "helper-missing") expect(result.stderr.toString()).toContain("router action source is missing");
  });

  test("deploy installs the repository-owned router helper", () => {
    const source = readFileSync(deployScript, "utf8");
    expect(source).toContain('install -m 0755 "$source" "$ROUTER_ACTIONS_DEST"');
    expect(source).toContain("install_router_actions");
    expect(source).toContain("DRAIN_INTERVAL_SECONDS=${CONCIERGE_DRAIN_INTERVAL_SECONDS:-2}");
    expect(readFileSync(join(repo, "bot/src/index.ts"), "utf8"))
      .toContain('process.env.CONCIERGE_DRAIN_INTERVAL_SECONDS || "2"');
    expect(readFileSync(bootstrapScript, "utf8"))
      .toContain("DRAIN_INTERVAL_SECONDS=${CONCIERGE_DRAIN_INTERVAL_SECONDS:-2}");
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

    expect(result.exitCode, `${result.stdout.toString()}\n${result.stderr.toString()}`).toBe(1);
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

  test("yields admission to live owners and retries only after an activity wake", () => {
    const fake = fakeDrain([10, 10, 0]);
    const result = runClaim(fake.bun);

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const calls = readFileSync(fake.calls, "utf-8").trim().split("\n");
    expect(calls).toHaveLength(6);
    expect(calls[0]).toContain("drain-status.ts claim");
    expect(calls[1]).toContain("drain-status.ts release");
    expect(calls[5]).toContain("capture-drain-status.ts claim");
    expect(calls.filter((call) => call.includes("bot/scripts/drain-status.ts claim"))).toHaveLength(3);
    expect(result.stdout.toString()).toContain("deployment yields and Concierge remains open");
    expect(result.stdout.toString()).toContain("Deployment gate claimed at an idle boundary");
    expect(readFileSync(fake.calls, "utf-8")).toContain("--owner-pid");
  });

  test("an interrupted drain wait immediately rechecks live ownership", () => {
    const fake = fakeDrain([10, 0]);
    executable(join(fake.dir, "sleep"), ["#!/usr/bin/env bash", "exit 143"]);
    const result = Bun.spawnSync({
      cmd: ["bash", "-c", `source "$1"; claim_deployment_gate`, "test", deployScript],
      env: {
        ...process.env,
        PATH: `${fake.dir}:${process.env.PATH}`,
        CONCIERGE_REPO: repo,
        CONCIERGE_BUN_BIN: fake.bun,
        CONCIERGE_DEPLOY_IDLE_RECHECK_SECONDS: "1200",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(readFileSync(fake.calls, "utf-8").trim().split("\n")).toHaveLength(4);
    expect(result.stdout.toString()).toContain("Deployment gate claimed at an idle boundary");
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

  test("records a human failure reason while retaining the exit code as diagnostics", () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-deploy-failure-reason-test-"));
    scratch.push(dir);
    const argumentsPath = join(dir, "arguments");
    const bun = join(dir, "bun");
    executable(bun, [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$@" > ${JSON.stringify(argumentsPath)}`,
      "echo '{\"status\":\"failed\"}'",
    ]);
    const result = Bun.spawnSync({
      cmd: [
        "bash",
        "-c",
        [
          'source "$1"',
          "DEPLOY_RUN_ID=run-human-failure",
          "CURRENT_DEPLOY_STAGE=runtime-install",
          "DEPLOY_FAILURE_REASON='The provider adapter could not start because its systemd sandbox was unavailable.'",
          "LAST_FAILED_COMMAND=systemctl",
          "LAST_FAILURE_LINE=719",
          "record_deployment_failure 3",
        ].join("; "),
        "test",
        deployScript,
      ],
      env: { ...process.env, CONCIERGE_REPO: repo, CONCIERGE_BUN_BIN: bun },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const args = readFileSync(argumentsPath, "utf-8").trim().split("\n");
    expect(args[args.indexOf("--error") + 1]).toBe(
      "Runtime installation failed: The provider adapter could not start because its systemd sandbox was unavailable.",
    );
    expect(args[args.indexOf("--error") + 1]).not.toContain("status 3");
    expect(args.slice(args.indexOf("--stage"), args.indexOf("--stage") + 8)).toEqual([
      "--stage",
      "runtime-install",
      "--failed-command",
      "systemctl",
      "--failure-line",
      "719",
      "--exit-status",
      "3",
    ]);
  });

  test("records ambiguous outcomes with a separate Slack reason and structured diagnostics", () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-deploy-ambiguity-reason-test-"));
    scratch.push(dir);
    const argumentsPath = join(dir, "arguments");
    const bun = join(dir, "bun");
    executable(bun, [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$@" > ${JSON.stringify(argumentsPath)}`,
      "echo '{\"status\":\"ambiguous\"}'",
    ]);
    const result = Bun.spawnSync({
      cmd: [
        "bash",
        "-c",
        [
          'source "$1"',
          "DEPLOY_RUN_ID=run-ambiguous",
          "CURRENT_DEPLOY_STAGE=candidate-restart-and-health",
          "DEPLOYED_INVOCATION_ID=proven-invocation",
          "DEPLOYED_RUNTIME_SHA=proven-runtime",
          "probe_service() { return 3; }",
          "confirm_service_proof_is_current || true",
        ].join("; "),
        "test",
        deployScript,
      ],
      env: { ...process.env, CONCIERGE_REPO: repo, CONCIERGE_BUN_BIN: bun },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const args = readFileSync(argumentsPath, "utf-8").trim().split("\n");
    expect(args[args.indexOf("--error") + 1]).toBe(
      "The service could not be re-proven healthy immediately before deployment success.",
    );
    expect(args[args.indexOf("--notice-reason") + 1]).toBe(
      "The service could not be re-proven healthy immediately before deployment success.",
    );
    expect(args[args.indexOf("--stage") + 1]).toBe("candidate-restart-and-health");
    expect(args[args.indexOf("--failed-command") + 1]).toBe("probe_service");
    expect(Number(args[args.indexOf("--failure-line") + 1])).toBeGreaterThan(0);
    expect(args[args.indexOf("--exit-status") + 1]).toBe("3");
  });

  test("fails closed when ownership cannot be determined", () => {
    const fake = fakeDrain([], 1);
    const result = runClaim(fake.bun);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("provider admission could not be tested safely");
  });

  test("releases the exact token returned by the atomic claim", () => {
    const fake = fakeDrain([0, 0]);
    const result = Bun.spawnSync({
      cmd: ["bash", "-c", `source "$1"; claim_deployment_gate; release_deployment_gate`, "test", deployScript],
      env: { ...process.env, CONCIERGE_REPO: repo, CONCIERGE_BUN_BIN: fake.bun },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
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
    expect(botUnit).toContain("CONCIERGE_CODEX_REMOTE_EXCLUDE_CHANNELS=C0BNNP6U6GN,D0BMWUJ3RD5,slack-inbox");
    expect(botUnit).toContain("ExecStartPre=/usr/bin/test -x /usr/bin/node");
    expect(botUnit).toContain("ExecStartPre=/root/.codex/packages/standalone/current/codex app-server daemon start");
    expect(botUnit).toContain("ExecStartPre=/usr/local/lib/slack-concierge-deployment/control recover");
    const repairUnit = readFileSync(join(repo, "systemd/concierge-deployment-repair@.service"), "utf-8");
    expect(repairUnit).toContain("User=root");
    expect(repairUnit).toContain("ExecStart=/usr/local/lib/slack-concierge-deployment/control repair %i");
    expect(repairUnit).not.toMatch(/Protect(Home|System)|ReadWritePaths|NoNewPrivileges/);
    expect(captureUnit).toContain("TimeoutStopSec=infinity");
    expect(captureUnit).toContain("KillMode=mixed");
    expect(script).toContain("for unit in concierge-bot.service agent-inbox.service");
    expect(script).toContain("install --backend=copyfile --frozen-lockfile --production");
    expect(() => readFileSync(join(repo, "capture-slack-app-manifest.json"), "utf-8")).toThrow();
    const installer = readFileSync(join(repo, "bot/scripts/install-capture-ingress.ts"), "utf-8");
    expect(installer).not.toContain("slack.toml");
    expect(installer).toContain("capture-queue.token");
    expect(installer).not.toContain("auth.test");
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
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        CONCIERGE_REPO: repo,
        CONCIERGE_DEPLOY_COMMAND: join(dir, "missing-control"),
      },
      stdout: "pipe", stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    const invocation = readFileSync(calls, "utf-8");
    expect(invocation).toContain("--no-block");
    expect(invocation).toContain(`--setenv=HOME=${process.env.HOME}`);
    expect(invocation).toContain("--setenv=CONCIERGE_DEPLOY_DETACHED=1");
    expect(invocation).toContain(deployScript);
  });

  test("ordinary agent turns no longer enroll for deployment or success wakes", () => {
    const source = readFileSync(deployScript, "utf-8");
    expect(source).not.toContain("request_agent_deployment");
    expect(source).not.toContain("CONCIERGE_TURN_ID");
    expect(source).not.toContain("verification turn");
  });

  test("deployment installs the tracked commit provenance hook for every worktree", () => {
    const checkout = mkdtempSync(join(tmpdir(), "concierge-hook-install-"));
    scratch.push(checkout);
    const linkedWorktree = `${checkout}-linked`;
    scratch.push(linkedWorktree);
    mkdirSync(join(checkout, ".githooks"), { recursive: true });
    copyFileSync(join(repo, ".githooks/prepare-commit-msg"), join(checkout, ".githooks/prepare-commit-msg"));
    chmodSync(join(checkout, ".githooks/prepare-commit-msg"), 0o755);
    const initialized = Bun.spawnSync({ cmd: ["git", "init", "-q"], cwd: checkout, stderr: "pipe" });
    expect(initialized.exitCode, initialized.stderr.toString()).toBe(0);
    Bun.spawnSync({ cmd: ["git", "config", "user.name", "Concierge Test"], cwd: checkout });
    Bun.spawnSync({ cmd: ["git", "config", "user.email", "concierge@example.invalid"], cwd: checkout });
    writeFileSync(join(checkout, "seed.txt"), "seed\n");
    Bun.spawnSync({ cmd: ["git", "add", "seed.txt"], cwd: checkout });
    const committed = Bun.spawnSync({ cmd: ["git", "commit", "-qm", "test: seed"], cwd: checkout, stderr: "pipe" });
    expect(committed.exitCode, committed.stderr.toString()).toBe(0);

    const installed = Bun.spawnSync({
      cmd: ["bash", "-c", `source "$1"; install_repository_git_hooks`, "test", deployScript],
      env: { ...process.env, CONCIERGE_REPO: checkout },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(installed.exitCode, installed.stderr.toString()).toBe(0);
    const configured = Bun.spawnSync({
      cmd: ["git", "config", "--get", "core.hooksPath"],
      cwd: checkout,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(configured.exitCode, configured.stderr.toString()).toBe(0);
    expect(configured.stdout.toString().trim()).toBe(join(checkout, ".githooks"));

    const added = Bun.spawnSync({
      cmd: ["git", "worktree", "add", "-qb", "linked", linkedWorktree],
      cwd: checkout,
      stderr: "pipe",
    });
    expect(added.exitCode, added.stderr.toString()).toBe(0);
    const linkedConfigured = Bun.spawnSync({
      cmd: ["git", "config", "--get", "core.hooksPath"],
      cwd: linkedWorktree,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(linkedConfigured.exitCode, linkedConfigured.stderr.toString()).toBe(0);
    expect(linkedConfigured.stdout.toString().trim()).toBe(join(checkout, ".githooks"));
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

    expect(result.exitCode, `${result.stdout.toString()}\n${result.stderr.toString()}`).toBe(1);
    expect(readFileSync(fake.calls, "utf-8")).toContain("release-live capture-token");
  });

  test("a durable deployment failure restores LKG and launches trusted-root repair", () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-repair-handoff-test-"));
    scratch.push(dir);
    const calls = join(dir, "calls");
    const fakeBun = join(dir, "bun");
    executable(fakeBun, [
      "#!/usr/bin/env bash",
      `echo "$*" >> ${JSON.stringify(calls)}`,
      "if [[ \"$*\" == *'restore-lkg'* ]]; then echo '{\"status\":\"restored\",\"git_commit\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"}'; exit 0; fi",
      "if [[ \"$*\" == *'repair-begin'* ]]; then echo '{\"status\":\"restored\",\"incident_id\":\"incident-1\",\"unit_name\":\"concierge-deployment-repair@incident-1.service\"}'; exit 0; fi",
      `exec ${JSON.stringify(process.execPath)} "$@"`,
    ]);
    const systemd = join(dir, "systemd");
    const state = join(dir, "state");
    const captureState = join(dir, "capture-state");
    mkdirSync(systemd);
    mkdirSync(state);
    const initialized = Bun.spawnSync({
      cmd: [process.execPath, "--eval", 'await import("./src/state.ts")'],
      cwd: join(repo, "bot"),
      env: { ...process.env, CONCIERGE_STATE_DIR: state, CONCIERGE_TEST_MODE: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(initialized.exitCode, initialized.stderr.toString()).toBe(0);
    const result = Bun.spawnSync({
      cmd: ["bash", "-c", [
        "source \"$1\"",
        "BUN_BIN=$2",
        "SYSTEMD_DIR=$3",
        "STATE_DIR=$4",
        "CAPTURE_STATE_DIR=$5",
        "DEPLOY_RUN_ID=run-1",
        "DEPLOYED_COMMIT=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "CURRENT_DEPLOY_STAGE=dependency-install",
        "claim_deployment_gate",
        "probe_capture_ingress() { return 0; }",
        "probe_service() { return 0; }",
        `systemctl() { echo "systemctl $*" >> ${JSON.stringify(calls)}; return 0; }`,
        "handoff_failed_deployment_to_repair 17",
      ].join("\n"), "test", deployScript, fakeBun, systemd, state, captureState],
      env: { ...process.env, CONCIERGE_REPO: repo, CONCIERGE_TEST_MODE: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const operations = readFileSync(calls, "utf8");
    expect(operations).toContain("restore-lkg");
    expect(operations).toContain("repair-begin");
    expect(operations).toContain("drain-status.ts release");
    expect(operations).toContain("capture-drain-status.ts release");
    expect(operations).toContain("drain-status.ts recover");
    expect(operations).toContain("capture-drain-status.ts recover");
    expect(operations).toContain("systemctl start concierge-deployment-repair@incident-1.service");
  });

  test("LKG proof failure never replaces the failed candidate identity", () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-failed-candidate-identity-"));
    scratch.push(dir);
    const calls = join(dir, "calls");
    const fakeBun = join(dir, "bun");
    executable(fakeBun, [
      "#!/usr/bin/env bash",
      `echo "$*" >> ${JSON.stringify(calls)}`,
      "if [[ \"$*\" == *'restore-lkg'* ]]; then echo '{\"status\":\"restored\",\"git_commit\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"}'; exit 0; fi",
      "if [[ \"$*\" == *'repair-begin'* ]]; then echo '{\"status\":\"restored\",\"incident_id\":\"incident-identity\",\"unit_name\":\"concierge-deployment-repair@incident-identity.service\"}'; exit 0; fi",
      "exit 0",
    ]);
    const result = Bun.spawnSync({
      cmd: ["bash", "-c", [
        "source \"$1\"",
        "BUN_BIN=$2",
        "DEPLOY_RUN_ID=run-identity",
        "DEPLOYED_COMMIT=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "FAILED_CANDIDATE_COMMIT=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "CURRENT_DEPLOY_STAGE=candidate-restart-and-health",
        "probe_capture_ingress() { return 1; }",
        "probe_service() { return 1; }",
        "systemctl() { return 0; }",
        "handoff_failed_deployment_to_repair 17",
      ].join("\n"), "test", deployScript, fakeBun],
      env: { ...process.env, CONCIERGE_REPO: repo },
      stdout: "pipe", stderr: "pipe",
    });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const operations = readFileSync(calls, "utf8");
    expect(operations).toContain("--failed-commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(operations).toContain("--restored-commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
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
    const oldState = join(dir, "state");
    const uploadState = join(dir, "upload-state");
    mkdirSync(bin, { recursive: true });
    mkdirSync(cgroup, { recursive: true });
    mkdirSync(installed, { recursive: true });
    mkdirSync(oldState, { recursive: true });
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
      "esac",
    ]);
    executable(join(bin, "journalctl"), ["#!/usr/bin/env bash", "echo concierge_bot_online"]);
    executable(join(bin, "systemd-sysusers"), ["#!/usr/bin/env bash", "exit 0"]);
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
        CONCIERGE_IPTABLES_BIN: join(bin, "iptables"),
        CONCIERGE_SS_BIN: join(bin, "ss"),
        CONCIERGE_DRAIN_INTERVAL_SECONDS: "0.01",
        CONCIERGE_BOOTSTRAP_DETACHED: "1",
      },
      stdout: "pipe", stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
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

  test("trusted-root cutover seeds and proves the immutable LKG before retiring the old runtime", () => {
    const cutover = readFileSync(deploymentRepairCutoverScript, "utf8");
    expect(cutover).toContain('ln -s "$(realpath "$REPO/bot/node_modules")" "$SOURCE_ROOT/bot/node_modules"');
    const repairUnit = readFileSync(join(repo, "systemd/concierge-deployment-repair@.service"), "utf8");
    expect(cutover).toContain("CONCIERGE_EXPECTED_LKG_COMMIT");
    expect(cutover.indexOf(" prepare ")).toBeLessThan(cutover.lastIndexOf("systemctl restart \"$SERVICE\""));
    expect(cutover.indexOf("probe_service\n  app_server_after")).toBeLessThan(cutover.indexOf(" promote "));
    expect(cutover.indexOf("record_deployment_success")).toBeLessThan(cutover.indexOf("\n  retire_legacy_runtime\n"));
    expect(cutover).toContain("trap 'LAST_FAILED_COMMAND=${BASH_COMMAND%% *}; LAST_FAILURE_LINE=$LINENO' ERR");
    expect(cutover).toContain("trap - EXIT ERR INT TERM");
    expect(cutover).not.toContain("git pull");
    expect(repairUnit).toContain("User=root");
    expect(repairUnit).toContain("Environment=HOME=/root");
    expect(repairUnit).not.toMatch(/DynamicUser|ProtectHome|ReadWritePaths|BindPaths|PrivateUsers/);
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
