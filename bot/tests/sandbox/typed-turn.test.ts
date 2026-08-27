import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaneFixtureIdentities } from "../../scripts/sandbox-provision";
import {
  runTypedTurnCase,
  TypedTurnBoundaryUnavailable,
  UnverifiedTypedTurnAdapter,
  type TypedTurnAdapter,
  type TypedTurnObservation,
  type TypedTurnPostReceipt,
  type TypedTurnRunningObservation,
} from "./cases/typed-turn.case";
import { assertBrowserRequestMatchesLane, type BrowserCaptureRequest, type SandboxBrowser } from "./support/browser";
import { SandboxEvidenceError, SandboxEvidenceWriter, type ScreenshotEvidence } from "./support/evidence";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "sandbox-typed-turn-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

const fixtures: LaneFixtureIdentities = {
  schema_version: 1,
  lane_id: "lane-1",
  app_id: "AAPP1",
  team_id: "TSANDBOX1",
  bot_user_id: "UBOT1",
  bot_id: "BBOT1",
  manifest_digest: "a".repeat(64),
  installer_user_id: "UINSTALLER1",
  dm_channel_id: "DDM1",
  channels: {
    core: { id: "CCORE1", name: "concierge-lane-1-core" },
    project: { id: "CPROJECT1", name: "concierge-lane-1-project" },
    capture: { id: "CCAPTURE1", name: "concierge-lane-1-capture" },
  },
  browser: {
    namespace: "concierge-sandbox-lane-1",
    profile_path: "/root/.local/state/concierge-sandbox/browser/lane-1",
      client_workspace_id: "EENTERPRISE1",
      canonical_workspace_domain: "sandbox-workspace.slack.com",
  },
};

class FakeAdapter implements TypedTurnAdapter {
  receipt?: TypedTurnPostReceipt;
  running?: TypedTurnRunningObservation;
  observation?: TypedTurnObservation;

  async postUserMessage(input: { text: string; client_message_id: string }): Promise<TypedTurnPostReceipt> {
    const messageTs = "1788000000.000001";
    this.receipt = {
      channel_id: fixtures.channels.core.id,
      message_ts: messageTs,
      thread_ts: messageTs,
      permalink: `https://concierge--sandbox.enterprise.slack.com/archives/CCORE1/p1788000000000001`,
      client_message_id: input.client_message_id,
      delivery: "confirmed",
    };
    return this.receipt;
  }

  async waitForRunning(): Promise<TypedTurnRunningObservation> {
    this.running = {
      api_app_id: fixtures.app_id,
      turn_id: 42,
      provider_id: "codex",
      provider_session_uuid: "session-42",
      provider_turn_id: "provider-turn-42",
      agent_session_status: "processing",
      agent_session_projection_status: "delivered",
      agent_session_desired_revision: 1,
      agent_session_projected_revision: 1,
      progress_message_ts: "1788000000.500001",
      progress_permalink: "https://sandbox-workspace.slack.com/archives/CCORE1/p1788000000500001?thread_ts=1788000000.000001&cid=CCORE1",
      activity_task_id: "activity-42",
      activity_title: "Thinking · 2s elapsed",
    };
    return this.running;
  }

  async waitForTurn(input: { marker: string; running: TypedTurnRunningObservation }): Promise<TypedTurnObservation> {
    const responseTldr = `${input.marker} provider lifecycle accepted.`;
    this.observation = {
      api_app_id: fixtures.app_id,
      input_channel_id: fixtures.channels.core.id,
      input_message_ts: this.receipt!.message_ts,
      input_kind: "turn",
      input_user_id: fixtures.installer_user_id,
      turn_id: 42,
      provider_id: "codex",
      provider_session_uuid: "session-42",
      provider_turn_id: "provider-turn-42",
      turn_status: "done",
      delivery_status: "delivered",
      progress_message_ts: input.running.progress_message_ts,
      work_complete_title: "Work complete · 4s",
      provider_duration_ms: 4_000,
      response_message_ts: "1788000001.000001",
      response_thread_ts: this.receipt!.thread_ts,
      response_permalink: "https://sandbox-workspace.slack.com/archives/CCORE1/p1788000001000001?thread_ts=1788000000.000001&cid=CCORE1",
      response_tldr: responseTldr,
      root_text: `request\n\n*Concierge TL;DR*\n${responseTldr}`,
      agent_text: `TL;DR: ${responseTldr}`,
    };
    return this.observation;
  }

  async drain() {
    return { run_owned_unsettled: 0, input_claims: 1, turns: 1, delivered_responses: 1 };
  }
}

class FakeBrowser implements SandboxBrowser {
  constructor(private readonly runRoot: string) {}
  async capture(request: BrowserCaptureRequest): Promise<ScreenshotEvidence> {
    assertBrowserRequestMatchesLane(request, fixtures);
    const directory = join(this.runRoot, "browser");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const screenshot = join(directory, `${request.phase}.png`);
    const accessibility = join(directory, `${request.phase}-accessibility.json`);
    const geometry = join(directory, `${request.phase}-geometry.json`);
    writeFileSync(screenshot, Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lMZzWQAAAABJRU5ErkJggg==",
      "base64",
    ));
    writeFileSync(accessibility, "{}");
    writeFileSync(geometry, "{}");
    return {
      phase: request.phase,
      permalink: request.permalink,
      client_workspace_id: fixtures.browser.client_workspace_id,
      canonical_workspace_domain: fixtures.browser.canonical_workspace_domain,
      channel_id: request.channel_id,
      message_ts: request.message_ts,
      screenshot_path: screenshot,
      screenshot_sha256: "",
      accessibility_path: accessibility,
      geometry_path: geometry,
    };
  }
}

describe("typed-turn sandbox case", () => {
  test("accepts the controller's timestamped run ID as a safe evidence identity", () => {
    const writer = new SandboxEvidenceWriter("lane-1", "20260827T050111Z-998262-12351", scratch());
    expect(writer.runRoot).toEndWith("/lanes/lane-1/runs/20260827T050111Z-998262-12351/evidence");
  });

  test("joins one exact lane input to app, user, provider, response, browser, and drain evidence", async () => {
    const stateRoot = scratch();
    const evidence = new SandboxEvidenceWriter("lane-1", "run-1", stateRoot);
    const adapter = new FakeAdapter();
    const result = await runTypedTurnCase({
      lane: fixtures,
      workspaceDomain: "concierge--sandbox.enterprise.slack.com",
      runId: "run-1",
      expectedProvider: "codex",
      adapter,
      browser: new FakeBrowser(evidence.runRoot),
      evidence,
    });
    expect(result.status).toBe("passed");
    expect(result.observation).toMatchObject({ api_app_id: "AAPP1", marker_count: 1, turn_id: 42 });
    expect(result.observation).not.toHaveProperty("agent_text");
    expect(result.browser.running.screenshot_sha256).toHaveLength(64);
    expect(JSON.parse(readFileSync(join(evidence.runRoot, "typed-turn.json"), "utf8"))).toMatchObject({ status: "passed" });
  });

  test("fails before visual proof when the event came from another lane app", async () => {
    const stateRoot = scratch();
    const evidence = new SandboxEvidenceWriter("lane-1", "run-2", stateRoot);
    const adapter = new FakeAdapter();
    const original = adapter.waitForRunning.bind(adapter);
    adapter.waitForRunning = async () => ({ ...await original(), api_app_id: "AOTHER" });
    await expect(runTypedTurnCase({
      lane: fixtures,
      workspaceDomain: "concierge--sandbox.enterprise.slack.com",
      runId: "run-2",
      expectedProvider: "codex",
      adapter,
      browser: new FakeBrowser(evidence.runRoot),
      evidence,
    })).rejects.toThrow("running activity was not observably bound");
  });

  test("fails when the running Thinking/activity surface is absent", async () => {
    const evidence = new SandboxEvidenceWriter("lane-1", "run-no-running", scratch());
    const adapter = new FakeAdapter();
    const original = adapter.waitForRunning.bind(adapter);
    adapter.waitForRunning = async () => ({ ...await original(), activity_title: "Starting agent · 2s elapsed" });
    await expect(runTypedTurnCase({
      lane: fixtures, workspaceDomain: "concierge--sandbox.enterprise.slack.com", runId: "run-no-running",
      expectedProvider: "codex", adapter, browser: new FakeBrowser(evidence.runRoot), evidence,
    })).rejects.toThrow("running activity was not observably bound");
  });

  test("fails when the processing Agent session was not durably delivered", async () => {
    const evidence = new SandboxEvidenceWriter("lane-1", "run-no-agent-session", scratch());
    const adapter = new FakeAdapter();
    const original = adapter.waitForRunning.bind(adapter);
    adapter.waitForRunning = async () => ({
      ...await original(),
      agent_session_projection_status: "pending" as "delivered",
    });
    await expect(runTypedTurnCase({
      lane: fixtures, workspaceDomain: "concierge--sandbox.enterprise.slack.com", runId: "run-no-agent-session",
      expectedProvider: "codex", adapter, browser: new FakeBrowser(evidence.runRoot), evidence,
    })).rejects.toThrow("running activity was not observably bound");
  });

  test.each([
    ["Work complete elapsed state", (value: TypedTurnObservation) => ({ ...value, work_complete_title: "Work complete" })],
    ["final TL;DR", (value: TypedTurnObservation) => ({ ...value, agent_text: "Finished." })],
    ["cumulative root TL;DR", (value: TypedTurnObservation) => ({ ...value, root_text: "request" })],
  ])("fails when %s is absent", async (name, mutate) => {
    const runId = `run-no-${String(name).replace(/[^A-Za-z0-9.-]+/g, "-").toLowerCase()}`;
    const evidence = new SandboxEvidenceWriter("lane-1", runId, scratch());
    const adapter = new FakeAdapter();
    const original = adapter.waitForTurn.bind(adapter);
    adapter.waitForTurn = async (input) => mutate(await original(input));
    await expect(runTypedTurnCase({
      lane: fixtures, workspaceDomain: "concierge--sandbox.enterprise.slack.com", runId,
      expectedProvider: "codex", adapter, browser: new FakeBrowser(evidence.runRoot), evidence,
    })).rejects.toThrow("durable observation failed exact identity/content assertions");
  });

  test("unverified live adapters fail clearly without calling Slack", async () => {
    await expect(new UnverifiedTypedTurnAdapter().postUserMessage({
      lane: fixtures, text: "do not send", client_message_id: "id",
    })).rejects.toBeInstanceOf(TypedTurnBoundaryUnavailable);
  });

  test("evidence rejects credential-shaped fields and values", () => {
    const writer = new SandboxEvidenceWriter("lane-1", "run-3", scratch());
    expect(() => writer.writeJson("bad.json", { bot_token: "redacted" })).toThrow(SandboxEvidenceError);
    expect(() => writer.writeJson("bad-value.json", { value: "xoxb-should-never-appear" })).toThrow("Slack credential");
  });
});
