import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { singleClickJournalSink } from "../scripts/sandbox-capture-source";
import { randomInt } from "node:crypto";

const repository = resolve(import.meta.dir, "../..");
const controlScript = join(repository, "bot/scripts/sandbox-lane-control.sh");

type Claim = {
  lane: number;
  run_id: string;
  owner: string;
  generation: number;
  slack_enabled: boolean;
  capability_socket: string | null;
  source: { git_sha: string; dirty_digest: string | null; source_id: string };
  candidate: { pid: number };
  supervisor: { pid: number };
  paths: {
    state: string;
    capture_state: string;
    evidence: string;
    workspace: string;
    browser_profile: string;
    capture_config: string;
    capture_credentials: string;
    capture_journal: string;
    capture_audio: string;
  };
  reserved_capture: {
    ingress_url: string;
    ingress_port: number;
    queue_url: string;
    queue_port: number;
    queue_token_file: string;
    pebble_token_file: string;
    journal_root: string;
    process: { pid: number; start_ticks: string };
    active: boolean;
  };
};

type Harness = {
  root: string;
  env: Record<string, string>;
  claims: Claim[];
};

const harnesses: Harness[] = [];

function createHarness(): Harness {
  // Independent worktrees run this gate on the same host. Probe a private
  // port block instead of competing for the old globally fixed 1908x/1918x ports.
  let portBase: number;
  for (;;) {
    portBase = randomInt(20000, 55000);
    const probes: ReturnType<typeof Bun.serve>[] = [];
    try {
      for (const offset of [1, 2, 3, 4, 11, 12, 13, 14]) {
        probes.push(Bun.serve({ hostname: "127.0.0.1", port: portBase + offset, fetch: () => new Response() }));
      }
      break;
    } catch { /* A live owner keeps its port; choose another block. */ }
    finally { for (const probe of probes) probe.stop(true); }
  }
  const root = mkdtempSync(join(tmpdir(), "concierge-sandbox-lanes-"));
  const fakeBun = join(root, "fake-bun");
  writeFileSync(fakeBun, [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "mkdir -p \"$CONCIERGE_SANDBOX_EVIDENCE_DIR\"",
    "lock_fd_count=0",
    "for descriptor in /proc/$$/fd/*; do",
    "  [ \"$(readlink \"$descriptor\" 2>/dev/null || true)\" != \"$CONCIERGE_SANDBOX_CONTROL_ROOT/lane-$CONCIERGE_SANDBOX_LANE.lock\" ] || lock_fd_count=$((lock_fd_count + 1))",
    "done",
    "printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' \"$$\" \"$CONCIERGE_SANDBOX_LANE\" \"$CONCIERGE_SANDBOX_RUN_ID\" \"$CONCIERGE_STATE_DIR\" \"${CONCIERGE_CAPTURE_QUEUE_URL-unset}\" \"${CONCIERGE_CAPTURE_QUEUE_TOKEN_FILE-unset}\" \"${CONCIERGE_CAPTURE_JOURNAL_ROOT-unset}\" \"$CONCIERGE_TEST_MODE\" \"$lock_fd_count\" \"$CONCIERGE_WORKSPACE_ROOT\" \"$CONCIERGE_SANDBOX_SOURCE_HEAD\" \"$CONCIERGE_SANDBOX_SOURCE_DIFF_DIGEST\" >> \"$CONCIERGE_SANDBOX_EVIDENCE_DIR/candidate-starts.tsv\"",
    "ready_temporary=\"$CONCIERGE_SANDBOX_READY_FILE.tmp.$$\"",
    "if [ \"${FAKE_READY_MODE-valid}\" != missing ]; then",
    "  ready_pid=$$",
    "  [ \"${FAKE_READY_MODE-valid}\" != wrong ] || ready_pid=$((ready_pid + 1))",
    "  if [ \"$CONCIERGE_SLACK_ENABLED\" = 0 ]; then",
    "    [ -z \"${CONCIERGE_CONFIG_PATH-unset}\" ] || [ \"${CONCIERGE_CONFIG_PATH-unset}\" = unset ] || exit 22",
    "    native_socket=\"$CONCIERGE_STATE_DIR/requests.sock\"",
    "    [ \"${FAKE_NATIVE_READY_MODE-valid}\" != wrong-socket ] || native_socket=/wrong/requests.sock",
    "    jq -cn --argjson pid \"$ready_pid\" --arg run_id \"$CONCIERGE_SANDBOX_RUN_ID\" --argjson lane \"$CONCIERGE_SANDBOX_LANE\" --arg owner_socket \"$native_socket\" --arg mode \"${FAKE_NATIVE_READY_MODE-valid}\" '{schema_version:1,pid:$pid,run_id:$run_id,lane:$lane,slack_enabled:false,owner_socket:$owner_socket,ready_at:\"2026-09-15T00:00:00Z\"} + (if $mode == \"copied-slack\" then {team_id:\"TLANE1\",app_id:\"ALANE1\",bot_user_id:\"ULANE1\",bot_id:\"BLANE1\"} else {} end)' > \"$ready_temporary\"",
    "  else",
    "  jq -cn --argjson pid \"$ready_pid\" --arg run_id \"$CONCIERGE_SANDBOX_RUN_ID\" --argjson lane \"$CONCIERGE_SANDBOX_LANE\" --arg team_id \"$CONCIERGE_SANDBOX_EXPECTED_TEAM_ID\" --arg app_id \"$CONCIERGE_SANDBOX_EXPECTED_APP_ID\" --arg bot_user_id \"$CONCIERGE_SANDBOX_EXPECTED_BOT_USER_ID\" --arg bot_id \"$CONCIERGE_SANDBOX_EXPECTED_BOT_ID\" '{schema_version:1,pid:$pid,run_id:$run_id,lane:$lane,team_id:$team_id,app_id:$app_id,bot_user_id:$bot_user_id,bot_id:$bot_id,ready_at:\"2026-08-27T00:00:00Z\"}' > \"$ready_temporary\"",
    "  fi",
    "  mv \"$ready_temporary\" \"$CONCIERGE_SANDBOX_READY_FILE\"",
    "fi",
    "trap 'exit 0' TERM INT",
    "while true; do sleep 0.05; done",
  ].join("\n"));
  chmodSync(fakeBun, 0o755);
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    CONCIERGE_BUN_BIN: fakeBun,
    CONCIERGE_SANDBOX_CAPTURE_BUN_BIN: process.execPath,
    CONCIERGE_SANDBOX_CONTROL_ROOT: join(root, "control"),
    CONCIERGE_SANDBOX_LANE_ROOT: join(root, "lanes"),
    CONCIERGE_SANDBOX_CONFIG_ROOT: join(root, "config"),
    CONCIERGE_SANDBOX_BROWSER_ROOT: join(root, "browser"),
    CONCIERGE_SANDBOX_START_TIMEOUT_SECONDS: "5",
    CONCIERGE_SANDBOX_OWNER_PUBLICATION_TIMEOUT_SECONDS: "1",
    CONCIERGE_SANDBOX_CAPTURE_PORT_BASE: String(portBase),
    CONCIERGE_SANDBOX_CAPTURE_QUEUE_PORT_BASE: String(portBase + 10),
  };
  for (let lane = 1; lane <= 4; lane += 1) {
    const laneConfig = join(env.CONCIERGE_SANDBOX_CONFIG_ROOT, `lane-${lane}`);
    mkdirSync(laneConfig, { recursive: true });
    writeFileSync(join(laneConfig, "identity.json"), JSON.stringify({
      schema_version: 1,
      lane_id: `lane-${lane}`,
      team_id: `TLANE${lane}`,
      app_id: `ALANE${lane}`,
      bot_user_id: `ULANE${lane}`,
      bot_id: `BLANE${lane}`,
      manifest_digest: String(lane).repeat(64),
    }));
    writeFileSync(join(laneConfig, "fixtures.json"), JSON.stringify({
      schema_version: 1,
      lane_id: `lane-${lane}`,
      installer_user_id: "UINSTALLER",
      dm_channel_id: `DLANE${lane}`,
      channels: {
        core: { id: `CLANE${lane}CORE`, name: `concierge-lane-${lane}-core` },
        project: { id: `CLANE${lane}PROJECT`, name: `concierge-lane-${lane}-project` },
        capture: { id: `CLANE${lane}CAPTURE`, name: `concierge-lane-${lane}-capture` },
      },
      browser: {
        namespace: `concierge-lane-${lane}`,
        profile_path: join(root, "browser", `lane-${lane}`),
        client_workspace_id: `EENTERPRISE${lane}`,
        canonical_workspace_domain: `sandbox-lane-${lane}.slack.com`,
      },
    }));
    writeFileSync(join(laneConfig, "slack.toml"), "# test-only placeholder\n");
    chmodSync(join(laneConfig, "slack.toml"), 0o600);
  }
  const harness = { root, env, claims: [] };
  harnesses.push(harness);
  return harness;
}

function runControl(harness: Harness, args: string[]) {
  return Bun.spawnSync({
    cmd: [controlScript, ...args],
    env: harness.env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

function claim(harness: Harness, owner: string): Claim {
  const result = runControl(harness, [
    "claim",
    "--owner", owner,
    "--requester", `thread-${owner}`,
    "--label", `case-${owner}`,
    "--worktree", repository,
  ]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const claimed = JSON.parse(result.stdout.toString()) as Claim;
  harness.claims.push(claimed);
  return claimed;
}

function release(harness: Harness, claimed: Claim) {
  const result = runControl(harness, [
    "release",
    "--lane", String(claimed.lane),
    "--run-id", claimed.run_id,
    "--timeout", "15",
  ]);
  if (result.exitCode === 0) {
    harness.claims = harness.claims.filter((candidate) => candidate.run_id !== claimed.run_id);
  }
  return result;
}

function processIsRunning(pid: number) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[0];
    return state !== "Z";
  } catch {
    return false;
  }
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    for (const claimed of [...harness.claims]) release(harness, claimed);
    rmSync(harness.root, { recursive: true, force: true });
  }
});

describe("sandbox lane control", () => {
  test("reload adopts one private capability socket and retains it with the same claim", () => {
    const harness = createHarness();
    harness.env.CONCIERGE_SESSION_CAPABILITY_SOCKET = '/unowned/inherited.sock';
    const claimed = claim(harness, 'capability-owner');
    const peerRoot = join(harness.root, 'peer');
    mkdirSync(peerRoot, { mode: 0o700 });
    const socket = join(peerRoot, 'capabilities.sock');
    const peer = Bun.serve({ unix: socket, fetch: () => Response.json({}) });
    chmodSync(socket, 0o600);
    try {
      const originalEnv = readFileSync(`/proc/${claimed.candidate.pid}/environ`, 'utf8');
      expect(originalEnv).not.toContain('CONCIERGE_SESSION_CAPABILITY_SOCKET=');
      for (const extra of [['--capability-socket', socket, '--slack', 'disabled'], []]) {
        const result = runControl(harness, ['reload', '--lane', String(claimed.lane), '--run-id', claimed.run_id, ...extra]);
        expect(result.exitCode, result.stderr.toString() || result.stdout.toString()).toBe(0);
        const current = JSON.parse(result.stdout.toString()) as Claim;
        expect(current.capability_socket).toBe(socket);
        expect(current.slack_enabled).toBe(false);
        expect(current.run_id).toBe(claimed.run_id);
        expect(current.supervisor).toEqual(claimed.supervisor);
        expect(current.paths.state).toBe(claimed.paths.state);
        expect(readFileSync(`/proc/${current.candidate.pid}/environ`, 'utf8')).toContain(`CONCIERGE_SESSION_CAPABILITY_SOCKET=${socket}\0`);
      }
    } finally { peer.stop(true); }
  }, 30_000);

  test("invalid or stale capability adoption leaves the owned candidate and request untouched", () => {
    const harness = createHarness();
    const claimed = claim(harness, 'capability-refusal');
    const peerRoot = join(harness.root, 'peer');
    mkdirSync(peerRoot, { mode: 0o700 });
    const socket = join(peerRoot, 'capabilities.sock');
    const peer = Bun.serve({ unix: socket, fetch: () => Response.json({}) });
    chmodSync(socket, 0o600);
    const regular = join(peerRoot, 'regular'); writeFileSync(regular, '', { mode: 0o600 });
    const alias = join(peerRoot, 'alias.sock'); symlinkSync(socket, alias);
    const requestPath = join(harness.root, 'lanes', `lane-${claimed.lane}`, 'runs', claimed.run_id, 'request.json');
    const original = readFileSync(requestPath, 'utf8');
    const refuse = (path: string, runId = claimed.run_id) => {
      const result = runControl(harness, ['reload', '--lane', String(claimed.lane), '--run-id', runId, '--slack', 'disabled', '--capability-socket', path]);
      expect(result.exitCode).not.toBe(0);
      expect(readFileSync(requestPath, 'utf8')).toBe(original);
      expect(processIsRunning(claimed.candidate.pid)).toBe(true);
    };
    try {
      for (const path of ['relative.sock', regular, alias, join(peerRoot, 'missing')]) refuse(path);
      chmodSync(socket, 0o660); refuse(socket); chmodSync(socket, 0o600);
      chmodSync(peerRoot, 0o755); refuse(socket); chmodSync(peerRoot, 0o700);
      refuse(socket, 'stale-run');
    } finally { peer.stop(true); }
  });

  test("controller reload removes and restores Slack under the same supervisor and run", () => {
    const harness = createHarness();
    const claimed = claim(harness, 'native-removal');
    expect(claimed.slack_enabled).toBe(true);
    writeFileSync(join(claimed.paths.state, 'continuity-evidence'), 'retained');
    const reload = (extra: string[]) => {
      const result = runControl(harness, ['reload', '--lane', String(claimed.lane), '--run-id', claimed.run_id, ...extra]);
      expect(result.exitCode, result.stderr.toString() || result.stdout.toString()).toBe(0);
      const current = JSON.parse(result.stdout.toString()) as Claim;
      expect(current.run_id).toBe(claimed.run_id);
      expect(current.supervisor).toEqual(claimed.supervisor);
      expect(current.paths.state).toBe(claimed.paths.state);
      expect(readFileSync(join(current.paths.state, 'continuity-evidence'), 'utf8')).toBe('retained');
      return current;
    };
    const disabled = reload(['--slack', 'disabled']);
    expect(disabled.slack_enabled).toBe(false);
    expect(disabled.generation).toBe(claimed.generation + 1);
    expect(processIsRunning(claimed.candidate.pid)).toBe(false);
    const ready = JSON.parse(readFileSync(join(disabled.paths.state, 'ready.json'), 'utf8'));
    expect(ready).toMatchObject({ pid: disabled.candidate.pid, slack_enabled: false,
      owner_socket: join(disabled.paths.state, 'requests.sock') });
    expect(ready.team_id).toBeUndefined();
    const unchanged = reload([]);
    expect(unchanged.slack_enabled).toBe(false);
    expect(unchanged.generation).toBe(disabled.generation + 1);
    expect(processIsRunning(disabled.candidate.pid)).toBe(false);
    const restored = reload(['--slack', 'enabled']);
    expect(restored.slack_enabled).toBe(true);
    expect(processIsRunning(unchanged.candidate.pid)).toBe(false);
    const occupied = runControl(harness, ['status']);
    expect(JSON.parse(occupied.stdout.toString()).lanes.find((entry: any) => entry.lane === claimed.lane).owner.run_id).toBe(claimed.run_id);
  }, 30_000);

  test.each(['wrong-socket', 'copied-slack'])("native readiness refuses %s without claiming a successful reload", mode => {
    const harness = createHarness();
    harness.env.FAKE_NATIVE_READY_MODE = mode;
    harness.env.CONCIERGE_SANDBOX_START_TIMEOUT_SECONDS = '2';
    const claimed = claim(harness, `native-${mode}`);
    const result = runControl(harness, ['reload', '--lane', String(claimed.lane), '--run-id', claimed.run_id, '--slack', 'disabled']);
    expect(result.exitCode).not.toBe(0);
    const runRoot = join(harness.env.CONCIERGE_SANDBOX_LANE_ROOT!, `lane-${claimed.lane}`, 'runs', claimed.run_id);
    expect(JSON.parse(readFileSync(join(runRoot, 'run.json'), 'utf8')).status).not.toBe('running');
  });

  test("invalid Slack mode and stale run cannot change the controller's mode", () => {
    const harness = createHarness();
    const claimed = claim(harness, 'native-mode-refusal');
    const invalid = runControl(harness, ['reload', '--lane', String(claimed.lane), '--run-id', claimed.run_id, '--slack', 'maybe']);
    expect(invalid.exitCode).toBe(2);
    const stale = runControl(harness, ['reload', '--lane', String(claimed.lane), '--run-id', 'stale', '--slack', 'disabled']);
    expect(stale.exitCode).not.toBe(0);
    const current = JSON.parse(readFileSync(join(harness.env.CONCIERGE_SANDBOX_CONTROL_ROOT!, `lane-${claimed.lane}.owner.json`), 'utf8'));
    expect(current.generation).toBe(claimed.generation);
    expect(current.slack_enabled).toBe(true);
    expect(current.candidate.pid).toBe(claimed.candidate.pid);
  });

  test("the fifth owner reports the occupied pool, waits, and starts on the first released lane", async () => {
    const harness = createHarness();
    const processes = Array.from({ length: 4 }, (_, index) => Bun.spawn({
      cmd: [
        controlScript,
        "claim",
        "--owner", `agent-${index + 1}`,
        "--requester", `thread-agent-${index + 1}`,
        "--worktree", repository,
      ],
      env: harness.env,
      stdout: "pipe",
      stderr: "pipe",
    }));
    const results = await Promise.all(processes.map(async (process) => ({
      exitCode: await process.exited,
      stdout: await new Response(process.stdout).text(),
      stderr: await new Response(process.stderr).text(),
    })));
    const successful = results.filter((result) => result.exitCode === 0)
      .map((result) => JSON.parse(result.stdout) as Claim);
    harness.claims.push(...successful);

    expect(successful, JSON.stringify(results.filter(result => result.exitCode !== 0))).toHaveLength(4);
    expect(new Set(successful.map((result) => result.lane))).toEqual(new Set([1, 2, 3, 4]));

    for (const claimed of successful) {
      expect(readFileSync(claimed.paths.capture_config, "utf8")).toContain(`sink = "${singleClickJournalSink(join(repository, "config/capture-routes.toml"))}"`);
      expect(claimed.paths.state).toContain(`/lane-${claimed.lane}/runs/${claimed.run_id}/state`);
      expect(claimed.paths.capture_state).toContain(`/lane-${claimed.lane}/runs/${claimed.run_id}/capture-state`);
      expect(claimed.paths.workspace).toContain(`/lane-${claimed.lane}/runs/${claimed.run_id}/workspace`);
      expect(claimed.paths.browser_profile).toBe(join(harness.root, "browser", `lane-${claimed.lane}`));
      expect(claimed.reserved_capture).toEqual({
        ingress_url: `http://127.0.0.1:${Number(harness.env.CONCIERGE_SANDBOX_CAPTURE_PORT_BASE) + claimed.lane}`,
        ingress_port: Number(harness.env.CONCIERGE_SANDBOX_CAPTURE_PORT_BASE) + claimed.lane,
        queue_url: `http://127.0.0.1:${Number(harness.env.CONCIERGE_SANDBOX_CAPTURE_QUEUE_PORT_BASE) + claimed.lane}`,
        queue_port: Number(harness.env.CONCIERGE_SANDBOX_CAPTURE_QUEUE_PORT_BASE) + claimed.lane,
        queue_token_file: join(claimed.paths.capture_credentials, "capture_queue"),
        pebble_token_file: join(claimed.paths.capture_credentials, "pebble_index"),
        journal_root: claimed.paths.capture_journal,
        process: expect.objectContaining({ pid: expect.any(Number), start_ticks: expect.any(String) }),
        active: true,
      });
      expect(processIsRunning(claimed.reserved_capture.process.pid)).toBeTrue();
      expect(statSync(claimed.reserved_capture.queue_token_file).mode & 0o777).toBe(0o400);
      expect(statSync(claimed.reserved_capture.pebble_token_file).mode & 0o777).toBe(0o400);
      expect(statSync(claimed.paths.capture_credentials).mode & 0o777).toBe(0o500);
      const starts = readFileSync(join(claimed.paths.evidence, "candidate-starts.tsv"), "utf8").trim().split("\t");
      expect(starts.slice(1, 4)).toEqual([String(claimed.lane), claimed.run_id, claimed.paths.state]);
      expect(starts.slice(4)).toEqual([
        claimed.reserved_capture.queue_url,
        claimed.reserved_capture.queue_token_file,
        claimed.paths.capture_journal,
        "1", "0", claimed.paths.workspace,
        claimed.source.git_sha, claimed.source.dirty_digest ?? "clean",
      ]);
    }

    const waitingProcess = Bun.spawn({
      cmd: [controlScript, "claim", "--owner", "agent-5", "--requester", "thread-agent-5", "--worktree", repository],
      env: harness.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const waitingOutput = new Response(waitingProcess.stdout).text();
    const earlyExit = await Promise.race([
      waitingProcess.exited.then((exitCode) => ({ kind: "exit" as const, exitCode })),
      Bun.sleep(250).then(() => ({ kind: "waiting" as const })),
    ]);
    expect(earlyExit.kind).toBe("waiting");

    const noWait = runControl(harness, ["claim", "--owner", "no-wait", "--worktree", repository, "--no-wait"]);
    expect(noWait.exitCode).toBe(10);
    const noWaitPayload = JSON.parse(noWait.stdout.toString());
    expect(noWaitPayload.lanes.every((lane: any) => lane.status === "occupied" && lane.owner?.owner)).toBeTrue();

    const released = successful.find((claim) => claim.lane === 3)!;
    expect(release(harness, released).exitCode).toBe(0);
    expect(await waitingProcess.exited).toBe(0);
    const waitingLines = (await waitingOutput).trim().split("\n").map((line) => JSON.parse(line));
    expect(waitingLines).toHaveLength(2);
    expect(waitingLines[0].status).toBe("waiting");
    expect(new Set(waitingLines[0].lanes.map((lane: any) => lane.owner.owner)))
      .toEqual(new Set(successful.map((claim) => claim.owner)));
    const resumed = waitingLines[1] as Claim;
    expect(resumed.lane).toBe(3);
    expect(resumed.owner).toBe("agent-5");
    harness.claims.push(resumed);
  }, 30_000);

  test("reload preserves the run, refreshes source identity, and rejects stale control tokens", () => {
    const harness = createHarness();
    const claimed = claim(harness, "reload-owner");
    const wrongReload = runControl(harness, ["reload", "--lane", "1", "--run-id", "wrong-run"]);
    const wrongRelease = runControl(harness, ["release", "--lane", "1", "--run-id", "wrong-run"]);
    expect(wrongReload.exitCode).toBe(11);
    expect(wrongRelease.exitCode).toBe(11);
    expect(JSON.parse(wrongReload.stdout.toString()).error).toContain("different run");
    expect(JSON.parse(wrongRelease.stdout.toString()).error).toContain("different run");

    const marker = join(repository, `sandbox-source-marker-${process.pid}`);
    writeFileSync(marker, "changed source identity\n");
    try {
      const reloaded = runControl(harness, ["reload", "--lane", "1", "--run-id", claimed.run_id]);
      expect(reloaded.exitCode, reloaded.stderr.toString()).toBe(0);
      const after = JSON.parse(reloaded.stdout.toString()) as Claim;
      expect(after.run_id).toBe(claimed.run_id);
      expect(after.generation).toBe(2);
      expect(after.candidate.pid).not.toBe(claimed.candidate.pid);
      expect(after.reserved_capture.process.pid).not.toBe(claimed.reserved_capture.process.pid);
      expect(processIsRunning(claimed.reserved_capture.process.pid)).toBeFalse();
      expect(processIsRunning(after.reserved_capture.process.pid)).toBeTrue();
      expect(after.paths.state).toBe(claimed.paths.state);
      expect(after.paths.workspace).toBe(claimed.paths.workspace);
      expect(after.source.git_sha).toBe(claimed.source.git_sha);
      expect(after.source.dirty_digest).not.toBe(claimed.source.dirty_digest);
      const starts = readFileSync(join(after.paths.evidence, "candidate-starts.tsv"), "utf8").trim().split("\n");
      expect(starts).toHaveLength(2);
      expect(starts[1]!.split("\t").slice(-2)).toEqual([after.source.git_sha, after.source.dirty_digest]);
    } finally {
      rmSync(marker, { force: true });
    }

    const released = release(harness, claimed);
    expect(released.exitCode, released.stderr.toString()).toBe(0);
    expect(JSON.parse(released.stdout.toString()).status).toBe("released");
    const status = runControl(harness, ["status"]);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout.toString()).lanes[0].status).toBe("free");

    const reused = claim(harness, "next-owner");
    expect(reused.lane).toBe(1);
    expect(reused.run_id).not.toBe(claimed.run_id);
    expect(reused.paths.state).not.toBe(claimed.paths.state);
    expect(reused.paths.workspace).not.toBe(claimed.paths.workspace);
  }, 30_000);

  test("reload cannot acknowledge readiness before the run metadata is published", () => {
    const harness = createHarness();
    const commands = join(harness.root, "commands");
    mkdirSync(commands);
    const move = join(commands, "mv");
    writeFileSync(move, [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "if [[ ${2-} == */run.json ]] && jq -e '.status == \"running\" and .generation == 2' \"$1\" >/dev/null; then sleep 1; fi",
      "exec /usr/bin/mv \"$@\"",
    ].join("\n"));
    chmodSync(move, 0o755);
    harness.env.PATH = `${commands}:${harness.env.PATH}`;
    const claimed = claim(harness, "publication-order");
    const reloaded = runControl(harness, ["reload", "--lane", "1", "--run-id", claimed.run_id]);
    expect(reloaded.exitCode, reloaded.stderr.toString()).toBe(0);
    const receipt = JSON.parse(reloaded.stdout.toString());
    const published = JSON.parse(readFileSync(join(harness.root, "lanes", "lane-1", "runs", claimed.run_id, "run.json"), "utf8"));
    expect(published.status).toBe("running");
    expect(published.generation).toBe(receipt.generation);
    expect(published.candidate).toEqual(receipt.candidate);
    expect(published.source).toEqual(receipt.source);
  });

  test("an invalid readiness receipt retains diagnostics and frees the lane", async () => {
    const harness = createHarness();
    harness.env.FAKE_READY_MODE = "wrong";
    harness.env.CONCIERGE_SANDBOX_START_TIMEOUT_SECONDS = "1";
    const failed = runControl(harness, [
      "claim",
      "--owner", "not-ready",
      "--worktree", repository,
    ]);
    expect(failed.exitCode).toBe(1);
    expect(JSON.parse(failed.stdout.toString()).error).toMatch(/before the candidate became ready|supervisor did not settle/);

    const runIds = readdirSync(join(harness.root, "lanes", "lane-1", "runs"));
    expect(runIds).toHaveLength(1);
    const runRoot = join(harness.root, "lanes", "lane-1", "runs", runIds[0]!);
    const deadline = Date.now() + 5_000;
    let finalRun = JSON.parse(readFileSync(join(runRoot, "run.json"), "utf8"));
    while (!["failed_start", "released"].includes(finalRun.status) && Date.now() < deadline) {
      await Bun.sleep(25);
      finalRun = JSON.parse(readFileSync(join(runRoot, "run.json"), "utf8"));
    }
    expect(["failed_start", "released"]).toContain(finalRun.status);
    expect(finalRun.reserved_capture.active).toBeFalse();
    expect(finalRun.reserved_capture.process).toBeNull();
    expect(readFileSync(join(runRoot, "candidate.log"), "utf8")).toBe("");

    const status = runControl(harness, ["status"]);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout.toString()).lanes[0].status).toBe("free");
  });

  test("claim fails closed on insecure credentials or mismatched provisioned identity", () => {
    const harness = createHarness();
    const missingWorktree = runControl(harness, ["claim", "--owner", "missing-worktree", "--worktree", join(harness.root, "missing")]);
    expect(missingWorktree.exitCode).toBe(2);
    expect(JSON.parse(missingWorktree.stdout.toString()).error).toContain("worktree does not exist");
    const laneConfig = join(harness.env.CONCIERGE_SANDBOX_CONFIG_ROOT, "lane-1");
    const slackConfig = join(laneConfig, "slack.toml");
    chmodSync(slackConfig, 0o640);
    const insecure = runControl(harness, ["claim", "--owner", "secure-owner", "--worktree", repository]);
    expect(insecure.exitCode).toBe(2);
    expect(JSON.parse(insecure.stdout.toString()).error).toContain("must not be group- or world-accessible");

    chmodSync(slackConfig, 0o600);
    const identityPath = join(laneConfig, "identity.json");
    const identity = JSON.parse(readFileSync(identityPath, "utf8"));
    writeFileSync(identityPath, JSON.stringify({ ...identity, lane_id: "lane-4" }));
    const mismatched = runControl(harness, ["claim", "--owner", "identity-owner", "--worktree", repository]);
    expect(mismatched.exitCode).toBe(2);
    expect(JSON.parse(mismatched.stdout.toString()).error).toContain("identity metadata is missing or invalid");

    writeFileSync(identityPath, JSON.stringify(identity));
    const fixturesPath = join(laneConfig, "fixtures.json");
    const fixtures = JSON.parse(readFileSync(fixturesPath, "utf8"));
    writeFileSync(fixturesPath, JSON.stringify({
      ...fixtures,
      browser: { ...fixtures.browser, client_workspace_id: identity.team_id },
    }));
    const workspaceTeamAsClient = runControl(harness, ["claim", "--owner", "browser-identity-owner", "--worktree", repository]);
    expect(workspaceTeamAsClient.exitCode).toBe(2);
    expect(JSON.parse(workspaceTeamAsClient.stdout.toString()).error).toContain("fixture metadata is missing or invalid");

    writeFileSync(fixturesPath, JSON.stringify(fixtures));
    const actualSlackConfig = join(laneConfig, "actual-slack.toml");
    renameSync(slackConfig, actualSlackConfig);
    symlinkSync(actualSlackConfig, slackConfig);
    const symlinked = runControl(harness, ["claim", "--owner", "symlink-owner", "--worktree", repository]);
    expect(symlinked.exitCode).toBe(2);
    expect(JSON.parse(symlinked.stdout.toString()).error).toContain("not symlinks");

    const status = runControl(harness, ["status"]);
    expect(JSON.parse(status.stdout.toString()).lanes.every((lane: any) => lane.status === "free")).toBeTrue();
  });

  test("a killed supervisor releases its candidate through the parent-death signal", async () => {
    const harness = createHarness();
    const claimed = claim(harness, "parent-death-owner");
    const capturePid = claimed.reserved_capture.process.pid;
    process.kill(claimed.supervisor.pid, "SIGKILL");
    const deadline = Date.now() + 3_000;
    while ((processIsRunning(claimed.candidate.pid) || processIsRunning(capturePid)) && Date.now() < deadline) {
      await Bun.sleep(25);
    }
    expect(processIsRunning(claimed.candidate.pid)).toBeFalse();
    expect(processIsRunning(capturePid)).toBeFalse();
    harness.claims = harness.claims.filter((candidate) => candidate.run_id !== claimed.run_id);

    let laneStatus = JSON.parse(runControl(harness, ["status"]).stdout.toString()).lanes[0].status;
    while (laneStatus !== "free" && Date.now() < deadline) {
      await Bun.sleep(25);
      laneStatus = JSON.parse(runControl(harness, ["status"]).stdout.toString()).lanes[0].status;
    }
    expect(laneStatus).toBe("free");
    const reused = claim(harness, "after-parent-death");
    expect(reused.lane).toBe(1);
  });

  test("a dead capture sibling stops the candidate and frees the lane", async () => {
    const harness = createHarness();
    const claimed = claim(harness, "capture-death-owner");
    process.kill(claimed.reserved_capture.process.pid, "SIGKILL");
    const deadline = Date.now() + 3_000;
    while (processIsRunning(claimed.candidate.pid) && Date.now() < deadline) await Bun.sleep(25);
    expect(processIsRunning(claimed.candidate.pid)).toBeFalse();
    const runPath = join(
      harness.root,
      "lanes",
      `lane-${claimed.lane}`,
      "runs",
      claimed.run_id,
      "run.json",
    );
    let finalRun = JSON.parse(readFileSync(runPath, "utf8"));
    while (finalRun.status !== "capture_exited" && Date.now() < deadline) {
      await Bun.sleep(25);
      finalRun = JSON.parse(readFileSync(runPath, "utf8"));
    }
    expect(finalRun).toMatchObject({ status: "capture_exited", reserved_capture: { active: false, process: null } });
    expect(JSON.parse(runControl(harness, ["status"]).stdout.toString()).lanes[0].status).toBe("free");
    harness.claims = harness.claims.filter((candidate) => candidate.run_id !== claimed.run_id);
  });

  test("terminating a waiting claim cancels it without disturbing occupied lanes", async () => {
    const harness = createHarness();
    for (let lane = 1; lane <= 4; lane += 1) claim(harness, `occupied-${lane}`);
    const waitingProcess = Bun.spawn({
      cmd: [controlScript, "claim", "--owner", "cancelled-waiter", "--worktree", repository],
      env: harness.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = waitingProcess.stdout.getReader();
    let output = '';
    try {
      while (!output.includes('\n')) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('Claim exited before reporting its waiting state');
        output += new TextDecoder().decode(chunk.value);
      }
      expect(JSON.parse(output.trim()).status).toBe('waiting');
      process.kill(waitingProcess.pid, 'SIGTERM');
      expect(await waitingProcess.exited).toBe(130);
    } finally {
      reader.releaseLock();
      if (waitingProcess.exitCode === null) waitingProcess.kill();
      await waitingProcess.exited;
    }
    const status = JSON.parse(runControl(harness, ["status"]).stdout.toString());
    expect(status.lanes.every((lane: any) => lane.status === "occupied")).toBeTrue();
  }, 20_000);

  test("overlapping ingress and queue port ranges fail closed", () => {
    const harness = createHarness();
    harness.env.CONCIERGE_SANDBOX_CAPTURE_QUEUE_PORT_BASE = String(Number(harness.env.CONCIERGE_SANDBOX_CAPTURE_PORT_BASE) + 2);
    const failed = runControl(harness, ["status"]);
    expect(failed.exitCode).toBe(2);
    expect(JSON.parse(failed.stdout.toString()).error).toContain("must not overlap");
  });
});
