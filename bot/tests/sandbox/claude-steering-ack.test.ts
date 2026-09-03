import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaneFixtureIdentities } from "../../scripts/sandbox-provision";
import type { TurnDispatchStateRow } from "./adapters/live-typed-turn";
import {
  runClaudeSteeringAckCase,
  type ClaudeSteeringAckAdapter,
  type ClaudeSteeringAcknowledgementObservation,
} from "./cases/claude-steering-ack.case";
import type { TypedTurnPostReceipt } from "./cases/typed-turn.case";
import { assertBrowserRequestMatchesLane, type BrowserCaptureRequest, type SandboxBrowser } from "./support/browser";
import { SandboxEvidenceWriter, type ScreenshotEvidence } from "./support/evidence";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "sandbox-claude-steering-ack-"));
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

function turnRow(status: "running" | "done", marker = ""): TurnDispatchStateRow {
  return {
    turn_id: 41,
    turn_status: status,
    dispatch_attempt: 1,
    dispatch_failure_class: null,
    delivery_status: status === "done" ? "delivered" : "pending",
    status_projection_status: status === "done" ? "delivered" : "pending",
    outbound_text: status === "done" ? `TL;DR: ${marker} steering accepted.` : null,
    session_id: 9,
    provider_id: "claude-code",
  };
}

class FakeAdapter implements ClaudeSteeringAckAdapter {
  receipts: TypedTurnPostReceipt[] = [];
  steeringText = "";
  marker = "";
  reactionCount = 1;
  failureNoticeCount = 0;

  async postUserMessage(input: {
    channel_id: string;
    text: string;
    client_message_id: string;
    thread_ts?: string;
  }): Promise<TypedTurnPostReceipt> {
    this.marker ||= input.text.match(/SANDBOX_CLAUDE_STEERING_ACK_[A-Z0-9]+/)?.[0] || "";
    if (input.thread_ts) this.steeringText = input.text;
    const index = this.receipts.length + 1;
    const threadTs = input.thread_ts || `1788000000.00000${index}`;
    const threadQuery = input.thread_ts ? `?thread_ts=${threadTs}&cid=${input.channel_id}` : "";
    const receipt = {
      channel_id: input.channel_id,
      message_ts: `1788000000.00000${index}`,
      thread_ts: threadTs,
      permalink: `https://sandbox-workspace.slack.com/archives/${input.channel_id}/p178800000000000${index}${threadQuery}`,
      client_message_id: input.client_message_id,
      delivery: "confirmed" as const,
    };
    this.receipts.push(receipt);
    return receipt;
  }

  async waitForTurnDispatchState(input: { statuses: string[] }): Promise<TurnDispatchStateRow> {
    return turnRow(input.statuses.includes("done") ? "done" : "running", this.marker);
  }

  async waitForSteeringAcknowledgement(): Promise<ClaudeSteeringAcknowledgementObservation> {
    return {
      api_app_id: fixtures.app_id,
      turn_id: 41,
      provider_id: "claude-code",
      input_channel_id: this.receipts[1]!.channel_id,
      input_message_ts: this.receipts[1]!.message_ts,
      input_kind: "steering",
      input_user_id: fixtures.installer_user_id,
      input_text: this.steeringText,
      root_thread_ts: this.receipts[0]!.thread_ts,
      steering_status: "sent",
      steering_notice_status: "delivered",
      steering_notice_attempts: 1,
      replay_text: this.steeringText,
      replay_ready: 1,
      unreplayable_attachment_count: 0,
      reaction_name: "arrow_right_hook",
      reaction_count: this.reactionCount,
      reaction_user_ids: [fixtures.bot_user_id],
      failure_notice_count: this.failureNoticeCount,
    };
  }

  async fetchBotThreadTexts(): Promise<string[]> {
    return [`TL;DR: ${this.marker} steering accepted.`];
  }

  async waitForRunSettled(): Promise<void> {}
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

describe("Claude steering acknowledgement sandbox case", () => {
  test("proves exact replay eligibility, visible reaction, and steering-dependent completion", async () => {
    const evidence = new SandboxEvidenceWriter("lane-1", "run-1", scratch());
    const result = await runClaudeSteeringAckCase({
      lane: fixtures,
      workspaceDomain: "concierge--sandbox.enterprise.slack.com",
      runId: "run-1",
      adapter: new FakeAdapter(),
      browser: new FakeBrowser(evidence.runRoot),
      evidence,
    });

    expect(result.status).toBe("passed");
    expect(result.observation).toMatchObject({
      steering_status: "sent",
      steering_notice_status: "delivered",
      replay_ready: 1,
      reaction_count: 1,
      failure_notice_count: 0,
    });
    expect(JSON.parse(readFileSync(join(evidence.runRoot, "claude-steering-ack.json"), "utf8"))).toMatchObject({
      case_id: "claude-steering-ack",
      status: "passed",
    });
  });

  test("fails when the visible steering reaction is absent", async () => {
    const evidence = new SandboxEvidenceWriter("lane-1", "missing-reaction", scratch());
    const adapter = new FakeAdapter();
    adapter.reactionCount = 0;
    await expect(runClaudeSteeringAckCase({
      lane: fixtures,
      workspaceDomain: "concierge--sandbox.enterprise.slack.com",
      runId: "missing-reaction",
      adapter,
      browser: new FakeBrowser(evidence.runRoot),
      evidence,
    })).rejects.toThrow("exact durable, replay, and Slack-visible assertions");
  });

  test("fails when the current ambiguity warning is visible", async () => {
    const evidence = new SandboxEvidenceWriter("lane-1", "false-warning", scratch());
    const adapter = new FakeAdapter();
    adapter.failureNoticeCount = 1;
    await expect(runClaudeSteeringAckCase({
      lane: fixtures,
      workspaceDomain: "concierge--sandbox.enterprise.slack.com",
      runId: "false-warning",
      adapter,
      browser: new FakeBrowser(evidence.runRoot),
      evidence,
    })).rejects.toThrow("exact durable, replay, and Slack-visible assertions");
  });
});
