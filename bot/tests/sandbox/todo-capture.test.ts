import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaneFixtureIdentities } from "../../scripts/sandbox-provision";
import {
  runTodoCaptureCase,
  type TodoCaptureAdapter,
  type TodoCaptureObservation,
} from "./cases/todo-capture.case";
import type { TypedTurnPostReceipt } from "./cases/typed-turn.case";
import { assertBrowserRequestMatchesLane, type BrowserCaptureRequest, type SandboxBrowser } from "./support/browser";
import { SandboxEvidenceWriter, type ScreenshotEvidence } from "./support/evidence";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "sandbox-todo-capture-"));
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

class FakeAdapter implements TodoCaptureAdapter {
  receipt?: TypedTurnPostReceipt;
  text = "";

  async postUserMessage(input: {
    channel_id: string;
    text: string;
    client_message_id: string;
  }): Promise<TypedTurnPostReceipt> {
    this.text = input.text;
    this.receipt = {
      channel_id: input.channel_id,
      message_ts: "1788000000.000001",
      thread_ts: "1788000000.000001",
      permalink: `https://sandbox-workspace.slack.com/archives/${input.channel_id}/p1788000000000001`,
      client_message_id: input.client_message_id,
      delivery: "confirmed",
    };
    return this.receipt;
  }

  async waitForTodoCapture(): Promise<TodoCaptureObservation> {
    return {
      api_app_id: fixtures.app_id,
      input_channel_id: this.receipt!.channel_id,
      input_message_ts: this.receipt!.message_ts,
      input_kind: "capture",
      input_user_id: fixtures.installer_user_id,
      input_text: this.text,
      capture_vault_status: "done",
      capture_list_status: "skipped",
      capture_confirmation_status: "delivered",
      capture_confirmation_attempts: 1,
      reaction_name: "white_check_mark",
      reaction_count: 1,
      reaction_user_ids: [fixtures.bot_user_id],
      thread_reply_count: 0,
    };
  }

  async drainTodoCapture() {
    return { run_owned_unsettled: 0, input_claims: 1, turns: 0, delivered_confirmations: 1 };
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

describe("todo-capture sandbox case", () => {
  test("proves one exact durable capture, one check-mark reaction, zero replies, and zero provider turns", async () => {
    const evidence = new SandboxEvidenceWriter("lane-1", "run-1", scratch());
    const result = await runTodoCaptureCase({
      lane: fixtures,
      workspaceDomain: "concierge--sandbox.enterprise.slack.com",
      runId: "run-1",
      adapter: new FakeAdapter(),
      browser: new FakeBrowser(evidence.runRoot),
      evidence,
    });

    expect(result.status).toBe("passed");
    expect(result.observation).toMatchObject({
      reaction_name: "white_check_mark",
      reaction_count: 1,
      thread_reply_count: 0,
    });
    expect(result.drain).toMatchObject({ turns: 0, run_owned_unsettled: 0 });
    expect(result.browser.screenshot_sha256).toHaveLength(64);
    expect(JSON.parse(readFileSync(join(evidence.runRoot, "todo-capture.json"), "utf8"))).toMatchObject({
      case_id: "todo-capture",
      status: "passed",
    });
  });

  test("fails when Slack exposes a thread reply", async () => {
    const evidence = new SandboxEvidenceWriter("lane-1", "run-with-reply", scratch());
    const adapter = new FakeAdapter();
    adapter.waitForTodoCapture = async () => ({
      ...await new FakeAdapterWithPostedInput(adapter).observation(),
      thread_reply_count: 1,
    });

    await expect(runTodoCaptureCase({
      lane: fixtures,
      workspaceDomain: "concierge--sandbox.enterprise.slack.com",
      runId: "run-with-reply",
      adapter,
      browser: new FakeBrowser(evidence.runRoot),
      evidence,
    })).rejects.toThrow("exact durable and Slack-visible assertions");
  });
});

class FakeAdapterWithPostedInput {
  constructor(private readonly adapter: FakeAdapter) {}

  async observation(): Promise<TodoCaptureObservation> {
    return {
      api_app_id: fixtures.app_id,
      input_channel_id: this.adapter.receipt!.channel_id,
      input_message_ts: this.adapter.receipt!.message_ts,
      input_kind: "capture",
      input_user_id: fixtures.installer_user_id,
      input_text: this.adapter.text,
      capture_vault_status: "done",
      capture_list_status: "skipped",
      capture_confirmation_status: "delivered",
      capture_confirmation_attempts: 1,
      reaction_name: "white_check_mark",
      reaction_count: 1,
      reaction_user_ids: [fixtures.bot_user_id],
      thread_reply_count: 0,
    };
  }
}
