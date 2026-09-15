import { afterEach, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerOwnerEnvironment } from "../src/provider-owner-environment";
import { runClaudeCodeTurn, SubprocessClaudeCodeTransport } from "../src/claude-code";
import { runCodexTurn } from "../src/codex";
import type { SteeringSender } from "../src/steering";

const botDirectory = realpathSync(join(import.meta.dir, ".."));
const cleanups: Array<() => unknown> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "concierge-provider-owner-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, "state");
  mkdirSync(state);
  const alias = join(root, "state-alias");
  symlinkSync(state, alias);
  const environment = {
    CONCIERGE_STATE_DIR: alias,
    CONCIERGE_RUNTIME_PROFILE: "sandbox",
    CONCIERGE_TEST_MODE: "1",
    CONCIERGE_CONFIG_PATH: join(root, "slack.toml"),
    CONCIERGE_SANDBOX_READY_FILE: join(state, "ready.json"),
    CONCIERGE_WORKSPACE_ROOT: join(root, "workspace"),
    CONCIERGE_SANDBOX_RUN_ID: "run-owned",
    CONCIERGE_SANDBOX_LANE: "1",
    CONCIERGE_SANDBOX_EXPECTED_TEAM_ID: "T12345",
    CONCIERGE_SANDBOX_EXPECTED_APP_ID: "A12345",
    CONCIERGE_SANDBOX_EXPECTED_BOT_USER_ID: "U12345",
    CONCIERGE_SANDBOX_EXPECTED_BOT_ID: "B12345",
  };
  // Runtime validates the declared root before the provider canonicalizes it.
  environment.CONCIERGE_SANDBOX_READY_FILE = join(alias, "ready.json");
  return { root, state, alias, environment };
}

test("service paths override stale caller and inherited helper paths without changing exact input identity", () => {
  const { state, environment } = fixture();
  const result = providerOwnerEnvironment({
    CONCIERGE_STATE_DIR: "/wrong/state", CONCIERGE_STATE_DB: "/wrong/state.db",
    CONCIERGE_ROUTER_BOT_DIR: "/wrong/bot", CONCIERGE_SLACK_CONFIG: "/wrong/slack.toml",
    CONCIERGE_SOURCE_INPUT_ID: "input-exact", CONCIERGE_SOURCE_RUN_ID: "run-exact",
    CONCIERGE_COMMIT_PROVENANCE: "turn-token", CUSTOM_CONTEXT: "preserved",
  }, { ...environment, CONCIERGE_ROUTER_BOT_DIR: "/inherited/production/bot" });
  expect(result).toEqual({
    CONCIERGE_STATE_DIR: state, CONCIERGE_STATE_DB: join(state, "state.db"),
    CONCIERGE_ROUTER_BOT_DIR: botDirectory, CONCIERGE_SLACK_CONFIG: environment.CONCIERGE_CONFIG_PATH,
    CONCIERGE_RUNTIME_PROFILE: "sandbox", CONCIERGE_SLACK_ENABLED: "1",
    CONCIERGE_SOURCE_INPUT_ID: "input-exact", CONCIERGE_SOURCE_RUN_ID: "run-exact",
    CONCIERGE_COMMIT_PROVENANCE: "turn-token", CUSTOM_CONTEXT: "preserved",
  });
});

test("headless helpers cannot inherit a production Slack credential path", () => {
  const { environment } = fixture();
  const result = providerOwnerEnvironment({ CONCIERGE_SLACK_CONFIG: "/wrong/production.toml" }, {
    ...environment, CONCIERGE_SLACK_ENABLED: "0",
  });
  expect(result.CONCIERGE_SLACK_ENABLED).toBe("0");
  expect(result.CONCIERGE_SLACK_CONFIG).toBe("/dev/null");
  expect(readFileSync(result.CONCIERGE_SLACK_CONFIG!, "utf8")).toBe("");
});

test("provider execution refuses absent state or unbound bundle helpers", () => {
  const { root, environment } = fixture();
  expect(() => providerOwnerEnvironment({}, {})).toThrow("requires CONCIERGE_STATE_DIR");
  expect(() => providerOwnerEnvironment({}, { ...environment, CONCIERGE_STATE_DIR: join(root, "absent") }))
    .toThrow();
  expect(() => providerOwnerEnvironment({}, environment, join(root, "bundle/src")))
    .toThrow("owning router helper directory");
  expect(() => providerOwnerEnvironment({}, { ...environment, CONCIERGE_RELEASE_MANIFEST: "/inherited/manifest.json" }, join(root, "bundle/src")))
    .toThrow("owning router helper directory");
  expect(() => providerOwnerEnvironment({}, { ...environment, CONCIERGE_RUNTIME_PROFILE: "production",
    CONCIERGE_SLACK_ENABLED: "0", CONCIERGE_RELEASE_MANIFEST: "/inherited/manifest.json" }, join(root, "bundle/src")))
    .toThrow("owning router helper directory");
});

test("immutable release bundles retain the installed checkout backing, and explicit bundle paths stay exact", () => {
  const { root, environment } = fixture();
  const bundleSource = join(root, "release/bot/src");
  const result = providerOwnerEnvironment({}, { ...environment, CONCIERGE_RUNTIME_PROFILE: "production",
    CONCIERGE_RELEASE_MANIFEST: join(root, "release/manifest.json"),
    CONCIERGE_REPOSITORY_ROOT: join(botDirectory, ".."),
  }, bundleSource);
  expect(result.CONCIERGE_ROUTER_BOT_DIR).toBe(botDirectory);
  expect(providerOwnerEnvironment({}, { ...environment, CONCIERGE_ROUTER_BOT_DIR: botDirectory }, bundleSource)
    .CONCIERGE_ROUTER_BOT_DIR).toBe(botDirectory);
});

async function collect(child: ReturnType<typeof Bun.spawn>) {
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout as ReadableStream).text(), new Response(child.stderr as ReadableStream).text(), child.exited,
  ]);
  return { stdout, stderr, code };
}

test.each(["direct", "installed-wrapper"])("STATE_DIR-only %s session client reaches its exact socket", async mode => {
  const { root, state, alias } = fixture();
  const requests: any[] = [];
  const server = Bun.serve({ unix: join(state, "requests.sock"), async fetch(request) {
    requests.push({ path: new URL(request.url).pathname, body: await request.json() });
    return Response.json({ request_id: "exact-owned-request", status: "recorded", evidence: "all-fields-retained" }, { status: 202 });
  } });
  cleanups.push(() => server.stop(true));
  const installed = join(root, "router-actions.sh");
  copyFileSync(join(botDirectory, "../systemd/router-actions.sh"), installed);
  const args = ["get", "exact-owned-request", "--source-input", "input-owned", "--source-run", "run-owned"];
  const env = { ...process.env, CONCIERGE_STATE_DIR: alias, CONCIERGE_ROUTER_BOT_DIR: botDirectory };
  delete env.CONCIERGE_STATE_DB;
  delete env.BUN_OPTIONS;
  const child = Bun.spawn(mode === "direct"
    ? [process.execPath, join(botDirectory, "scripts/router-sessions.ts"), ...args]
    : ["bash", installed, "sessions", ...args], { env, stdout: "pipe", stderr: "pipe" });
  const result = await collect(child);
  expect(result).toMatchObject({ code: 0, stderr: "" });
  expect(JSON.parse(result.stdout)).toEqual({ request_id: "exact-owned-request", status: "recorded", evidence: "all-fields-retained" });
  expect(requests).toEqual([{ path: "/session-communication/get", body: {
    request_id: "exact-owned-request", source: { input_id: "input-owned", run_id: "run-owned" },
  } }]);
  server.stop(true);
  const failed = await collect(Bun.spawn([process.execPath, join(botDirectory, "scripts/router-sessions.ts"), ...args], {
    env, stdout: "pipe", stderr: "pipe",
  }));
  expect(failed.code).toBe(1);
  expect(failed.stdout).toBe("");
  expect(JSON.parse(failed.stderr)).toMatchObject({ error: "session_communication_unavailable",
    request_id: "exact-owned-request", source: { input_id: "input-owned", run_id: "run-owned" } });
  expect(requests).toHaveLength(1);
});

test.each([null, "existing-session"])("actual Claude initial and steered shells use the owner helper and socket, resume=%s", async sessionUUID => {
  const { root } = fixture();
  const requests: any[] = [];
  const server = Bun.serve({ unix: join(process.env.CONCIERGE_STATE_DIR!, "requests.sock"), async fetch(request) {
    requests.push(await request.json());
    return Response.json({ request_id: "owned-request", status: "recorded" }, { status: 202 });
  } });
  cleanups.push(() => server.stop(true));
  const wrapper = join(root, "router-actions.sh");
  copyFileSync(join(botDirectory, "../systemd/router-actions.sh"), wrapper);
  chmodSync(wrapper, 0o755);
  const executable = join(root, "claude-fixture");
  writeFileSync(executable, `#!/usr/bin/env bun
import { createInterface } from 'node:readline';
const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
for await (const line of createInterface({ input: process.stdin })) {
  const event = JSON.parse(line);
  if (event.type === 'control_request') {
    emit({ type: 'control_response', response: { subtype: 'success', request_id: event.request_id } });
    continue;
  }
  if (event.type !== 'user') continue;
  const text = event.message.content[0].text;
  const child = Bun.spawn(['router-actions.sh', 'sessions', 'search', '--source-input', text, '--source-run', 'run-owned', '--', 'owned concept'], { stdout: 'pipe', stderr: 'pipe' });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  if (await child.exited !== 0) throw new Error(stderr);
  if (JSON.parse(stdout).request_id !== 'owned-request') throw new Error('wrong owner receipt');
  emit(event);
  if (text === 'steered-input') emit({ type: 'result', session_id: 'owned-session', result: 'TL;DR: exact owner reached twice', is_error: false });
}
`);
  chmodSync(executable, 0o755);
  let sender!: SteeringSender;
  let ready!: () => void;
  const registered = new Promise<void>(resolve => { ready = resolve; });
  const running = runClaudeCodeTurn({ prompt: "initial-input", cwd: root, additionalDirs: [], sessionUUID,
    environment: { PATH: `${root}:${process.env.PATH}`, CONCIERGE_STATE_DB: "/wrong/state.db",
      CONCIERGE_ROUTER_BOT_DIR: "/wrong/bot", CONCIERGE_SOURCE_INPUT_ID: "initial-input", CONCIERGE_SOURCE_RUN_ID: "run-owned" },
    transport: new SubprocessClaudeCodeTransport(executable),
    onSteeringReady: value => { sender = value; ready(); },
  });
  await Promise.race([registered, running.then(() => { throw new Error("Provider ended before steering was ready"); })]);
  await sender({ text: "steered-input", clientMessageId: "steered-exact" });
  expect((await running).text).toBe("TL;DR: exact owner reached twice");
  expect(requests).toEqual(["initial-input", "steered-input"].map(input_id => ({
    source: { input_id, run_id: "run-owned" }, concepts: ["owned concept"],
  })));
});

test.each([null, "existing-thread"])("actual Codex stdio initial and steered shells preserve owner paths, resume=%s", async sessionUUID => {
  const { root } = fixture();
  const requests: any[] = [];
  const server = Bun.serve({ unix: join(process.env.CONCIERGE_STATE_DIR!, "requests.sock"), async fetch(request) {
    requests.push(await request.json());
    return Response.json({ request_id: "owned-request", status: "recorded" }, { status: 202 });
  } });
  cleanups.push(() => server.stop(true));
  const wrapper = join(root, "router-actions.sh");
  copyFileSync(join(botDirectory, "../systemd/router-actions.sh"), wrapper);
  chmodSync(wrapper, 0o755);
  const executable = join(root, "codex-fixture");
  writeFileSync(executable, `#!/usr/bin/env bun
import { createInterface } from 'node:readline';
const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
for await (const line of createInterface({ input: process.stdin })) {
  const event = JSON.parse(line);
  const reply = result => emit({ id: event.id, result });
  if (event.method === 'initialize') reply({ userAgent: 'fixture' });
  else if (event.method === 'thread/start' || event.method === 'thread/resume') {
    const environment = event.params.config.shell_environment_policy.set;
    for (const key of ['CONCIERGE_STATE_DIR', 'CONCIERGE_STATE_DB', 'CONCIERGE_ROUTER_BOT_DIR']) {
      if (environment[key] !== process.env[key]) throw new Error('thread environment differs from subprocess: ' + key);
    }
    if (environment.CONCIERGE_COMMIT_PROVENANCE) throw new Error('turn token persisted on thread');
    if (process.env.CONCIERGE_COMMIT_PROVENANCE !== 'turn-only') throw new Error('direct shell lost turn token');
    reply({ thread: { id: 'owned-thread' } });
  } else if (event.method === 'turn/start' || event.method === 'turn/steer') {
    const text = event.params.input[0].text;
    const child = Bun.spawn(['router-actions.sh', 'sessions', 'search', '--source-input', text, '--source-run', 'run-owned', '--', 'owned concept'], { stdout: 'pipe', stderr: 'pipe' });
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    if (await child.exited !== 0) throw new Error(stderr);
    if (JSON.parse(stdout).request_id !== 'owned-request') throw new Error('wrong owner receipt');
    if (event.method === 'turn/start') {
      reply({ turn: { id: 'owned-turn' } });
      emit({ method: 'turn/started', params: { threadId: 'owned-thread', turn: { id: 'owned-turn', status: 'inProgress' } } });
    } else {
      reply({ turnId: 'owned-turn' });
      emit({ method: 'item/started', params: { threadId: 'owned-thread', turnId: 'owned-turn', item: { id: 'steered-native-message', type: 'userMessage', clientId: event.params.clientUserMessageId, content: [] } } });
      emit({ method: 'turn/completed', params: { threadId: 'owned-thread', turn: { id: 'owned-turn', status: 'completed' } } });
    }
  }
}
`);
  chmodSync(executable, 0o755);
  let sender!: SteeringSender;
  let ready!: () => void;
  const registered = new Promise<void>(resolve => { ready = resolve; });
  const running = runCodexTurn({ prompt: "initial-input", cwd: root, additionalDirs: [], sessionUUID, executable,
    environment: { PATH: `${root}:${process.env.PATH}`, CONCIERGE_STATE_DB: "/wrong/state.db",
      CONCIERGE_ROUTER_BOT_DIR: "/wrong/bot", CONCIERGE_COMMIT_PROVENANCE: "turn-only" },
    onSteeringReady: value => { sender = value; ready(); }, requestTimeoutMs: 1_000, inactivityTimeoutMs: 1_000,
  });
  await Promise.race([registered, running.then(() => { throw new Error("Provider ended before steering was ready"); })]);
  await sender({ text: "steered-input", clientMessageId: "steered-exact" });
  expect(await running).toMatchObject({ sessionUUID: "owned-thread", providerTurnId: "owned-turn" });
  expect(requests).toEqual(["initial-input", "steered-input"].map(input_id => ({
    source: { input_id, run_id: "run-owned" }, concepts: ["owned concept"],
  })));
});
