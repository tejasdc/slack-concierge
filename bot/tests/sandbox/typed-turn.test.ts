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
  },
};

class FakeAdapter implements TypedTurnAdapter {
  receipt?: TypedTurnPostReceipt;
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

  async waitForTurn(input: { marker: string }): Promise<TypedTurnObservation> {
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
      response_message_ts: "1788000001.000001",
      response_thread_ts: this.receipt!.thread_ts,
      response_permalink: "https://concierge--sandbox.enterprise.slack.com/archives/CCORE1/p1788000001000001",
      agent_text: `TL;DR: ${input.marker}`,
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
    const screenshot = join(directory, "terminal.png");
    const accessibility = join(directory, "terminal-accessibility.json");
    const geometry = join(directory, "terminal-geometry.json");
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
    expect(result.browser.screenshot_sha256).toHaveLength(64);
    expect(JSON.parse(readFileSync(join(evidence.runRoot, "typed-turn.json"), "utf8"))).toMatchObject({ status: "passed" });
  });

  test("fails before visual proof when the event came from another lane app", async () => {
    const stateRoot = scratch();
    const evidence = new SandboxEvidenceWriter("lane-1", "run-2", stateRoot);
    const adapter = new FakeAdapter();
    const original = adapter.waitForTurn.bind(adapter);
    adapter.waitForTurn = async (input) => ({ ...await original(input), api_app_id: "AOTHER" });
    await expect(runTypedTurnCase({
      lane: fixtures,
      workspaceDomain: "concierge--sandbox.enterprise.slack.com",
      runId: "run-2",
      expectedProvider: "codex",
      adapter,
      browser: new FakeBrowser(evidence.runRoot),
      evidence,
    })).rejects.toThrow("exact identity/content assertions");
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
