import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaneFixtureIdentities } from "../../scripts/sandbox-provision";
import {
  runProgressCardCase,
  type ProgressCardAdapter,
  type ProgressCardObservation,
} from "./cases/progress-card.case";
import type { TypedTurnPostReceipt, TypedTurnRunningObservation } from "./cases/typed-turn.case";
import { assertBrowserRequestMatchesLane, type BrowserCaptureRequest, type SandboxBrowser } from "./support/browser";
import { SandboxEvidenceWriter, type ScreenshotEvidence } from "./support/evidence";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "sandbox-progress-card-"));
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

class FakeAdapter implements ProgressCardAdapter {
  marker = "";
  commentaryCount = 26;
  progressRows = 1 as number;

  async postUserMessage(input: {
    channel_id: string;
    text: string;
    client_message_id: string;
  }): Promise<TypedTurnPostReceipt> {
    this.marker = input.text.match(/SANDBOX_PROGRESS_CARD_[A-Z0-9]+/)?.[0] || "";
    if (!input.text.includes("exactly 26 cycles") || !input.text.includes("Step 4/4")) {
      throw new Error("case omitted the capacity and plan acceptance instructions");
    }
    return {
      channel_id: input.channel_id,
      message_ts: "1788000000.000001",
      thread_ts: "1788000000.000001",
      permalink: `https://sandbox-workspace.slack.com/archives/${input.channel_id}/p1788000000000001`,
      client_message_id: input.client_message_id,
      delivery: "confirmed",
    };
  }

  async waitForRunning(): Promise<TypedTurnRunningObservation> {
    return {
      api_app_id: fixtures.app_id,
      turn_id: 41,
      provider_id: "codex",
      provider_session_uuid: "11111111-1111-4111-8111-111111111111",
      provider_turn_id: "22222222-2222-4222-8222-222222222222",
      agent_session_status: "processing",
      agent_session_projection_status: "delivered",
      agent_session_desired_revision: 1,
      agent_session_projected_revision: 1,
      agent_session_title: "Progress test",
      progress_message_ts: "1788000000.000002",
      progress_permalink: `https://sandbox-workspace.slack.com/archives/${fixtures.channels.core.id}/p1788000000000002?thread_ts=1788000000.000001&cid=${fixtures.channels.core.id}`,
      activity_task_id: "activity-1",
      activity_title: "Working · 1s elapsed",
    };
  }

  async waitForProgressCard(): Promise<ProgressCardObservation> {
    return {
      api_app_id: fixtures.app_id,
      turn_id: 41,
      provider_id: "codex",
      turn_status: "done",
      delivery_status: "delivered",
      progress_row_count: this.progressRows as 1,
      progress_page_number: 0,
      progress_message_ts: "1788000000.000002",
      stored_commentary_count: this.commentaryCount,
      stored_activity_count: 1,
      slack_progress_reply_count: 1,
      slack_bot_reply_count: 2,
      work_complete_title: "Work complete · 1m 2s",
      plan_title: "4/4 steps complete",
      earlier_progress_title: "Earlier progress",
      continued_below_count: 0,
      response_message_ts: "1788000000.000003",
      marker_count: 1,
    };
  }

  async waitForRunSettled(): Promise<void> {}
}

class FakeBrowser implements SandboxBrowser {
  constructor(private readonly runRoot: string) {}

  async capture(request: BrowserCaptureRequest): Promise<ScreenshotEvidence> {
    assertBrowserRequestMatchesLane(request, fixtures);
    expect(request.required_text).toEqual(expect.arrayContaining(["4/4 steps complete", "Earlier progress"]));
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

describe("progress-card sandbox case", () => {
  test("proves one durable and Slack-visible progress identity past the former local limit", async () => {
    const evidence = new SandboxEvidenceWriter("lane-1", "run-1", scratch());
    const result = await runProgressCardCase({
      lane: fixtures,
      workspaceDomain: "concierge--sandbox.enterprise.slack.com",
      runId: "run-1",
      adapter: new FakeAdapter(),
      browser: new FakeBrowser(evidence.runRoot),
      evidence,
    });

    expect(result.status).toBe("passed");
    expect(result.observation).toMatchObject({
      progress_row_count: 1,
      progress_page_number: 0,
      slack_progress_reply_count: 1,
      plan_title: "4/4 steps complete",
      continued_below_count: 0,
    });
    expect(JSON.parse(readFileSync(join(evidence.runRoot, "progress-card.json"), "utf8"))).toMatchObject({
      case_id: "progress-card",
      status: "passed",
    });
  });

  test("rejects a second durable progress row", async () => {
    const evidence = new SandboxEvidenceWriter("lane-1", "two-rows", scratch());
    const adapter = new FakeAdapter();
    adapter.progressRows = 2;
    await expect(runProgressCardCase({
      lane: fixtures,
      workspaceDomain: "concierge--sandbox.enterprise.slack.com",
      runId: "two-rows",
      adapter,
      browser: new FakeBrowser(evidence.runRoot),
      evidence,
    })).rejects.toThrow("exact durable and Slack-visible assertions");
  });

  test("rejects fewer than 26 retained commentary updates", async () => {
    const evidence = new SandboxEvidenceWriter("lane-1", "short-history", scratch());
    const adapter = new FakeAdapter();
    adapter.commentaryCount = 25;
    await expect(runProgressCardCase({
      lane: fixtures,
      workspaceDomain: "concierge--sandbox.enterprise.slack.com",
      runId: "short-history",
      adapter,
      browser: new FakeBrowser(evidence.runRoot),
      evidence,
    })).rejects.toThrow("exact durable and Slack-visible assertions");
  });
});
