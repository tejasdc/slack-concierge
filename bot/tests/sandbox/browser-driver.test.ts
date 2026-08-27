import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaneFixtureIdentities } from "../../scripts/sandbox-provision";
import {
  APPROVED_SANDBOX_WORKSPACE_DOMAIN,
  AgentBrowserSlackDriver,
  SandboxBrowserBoundaryUnavailable,
  SandboxBrowserDriverError,
  type AgentBrowserCommandResult,
  type AgentBrowserCommandRunner,
  type BrowserCaptureRequest,
} from "./support/browser";
import { SandboxEvidenceWriter } from "./support/evidence";

const roots: string[] = [];
const messageTs = "1788000000.000001";
const permalinkPath = "/archives/CCORE1/p1788000000000001";
const marker = "SANDBOX_TYPED_TURN_MARKER";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lMZzWQAAAABJRU5ErkJggg==",
  "base64",
);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "sandbox-browser-driver-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function fixtures(profilePath: string): LaneFixtureIdentities {
  return {
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
    browser: { namespace: "concierge-sandbox-lane-1", profile_path: profilePath },
  };
}

function request(profilePath: string): BrowserCaptureRequest {
  return {
    lane_id: "lane-1",
    workspace_domain: APPROVED_SANDBOX_WORKSPACE_DOMAIN,
    browser_namespace: "concierge-sandbox-lane-1",
    browser_profile_path: profilePath,
    phase: "terminal",
    permalink: `https://${APPROVED_SANDBOX_WORKSPACE_DOMAIN}${permalinkPath}`,
    channel_id: "CCORE1",
    message_ts: messageTs,
    assertions: ["target is rendered"],
    required_text: [marker],
  };
}

function commandName(arguments_: string[]): string {
  return arguments_.find((value) => ["open", "wait", "get", "snapshot", "eval", "screenshot"].includes(value)) || "";
}

class FakeAgentBrowserRunner implements AgentBrowserCommandRunner {
  readonly calls: string[][] = [];
  observedUrl = "https://app.slack.com/client/TSANDBOX1/CCORE1/thread/CCORE1-1788000000.000001";
  snapshot = `heading concierge-lane-1-core\nlink ${permalinkPath}\ntext ${marker}`;
  geometry: Record<string, unknown> = {
    ok: true,
    target: {
      permalink_path: permalinkPath,
      message_ts: messageTs,
      visible: true,
      x: 50,
      y: 100,
      width: 800,
      height: 180,
    },
    channel_header: {
      name: "concierge-lane-1-core",
      visible: true,
      x: 0,
      y: 0,
      width: 900,
      height: 50,
    },
    required_text: [{ text: marker, count: 1 }],
    viewport: { width: 1280, height: 900, device_pixel_ratio: 1 },
  };
  failOperation: string | null = null;

  async run(arguments_: string[]): Promise<AgentBrowserCommandResult> {
    this.calls.push(arguments_);
    const command = commandName(arguments_);
    if (command === this.failOperation) {
      return { exitCode: 9, stdout: "", stderr: "xoxb-must-not-leak" };
    }
    if (command === "get") {
      const getIndex = arguments_.indexOf("get");
      const field = arguments_[getIndex + 1];
      return field === "url"
        ? this.success({ url: this.observedUrl })
        : this.success({ title: "Concierge Sandbox | Slack" });
    }
    if (command === "snapshot") return this.success({ snapshot: this.snapshot });
    if (command === "eval") return this.success({ result: this.geometry });
    if (command === "screenshot") {
      writeFileSync(arguments_.at(-1)!, png);
      return this.success({ path: arguments_.at(-1) });
    }
    return this.success({});
  }

  private success(data: unknown): AgentBrowserCommandResult {
    return { exitCode: 0, stdout: JSON.stringify({ success: true, data }), stderr: "" };
  }
}

function setup() {
  const root = scratch();
  const profilePath = join(root, "browser", "lane-1");
  mkdirSync(profilePath, { recursive: true, mode: 0o700 });
  chmodSync(join(root, "browser"), 0o700);
  chmodSync(profilePath, 0o700);
  return {
    root,
    profilePath,
    lane: fixtures(profilePath),
    evidence: new SandboxEvidenceWriter("lane-1", "run-1", join(root, "state")),
  };
}

describe("agent-browser Slack visual driver", () => {
  test("captures exact lane-owned PNG, accessibility, and geometry evidence", async () => {
    const context = setup();
    const runner = new FakeAgentBrowserRunner();
    const driver = new AgentBrowserSlackDriver(context.lane, runner);
    const captured = await driver.capture(request(context.profilePath), context.evidence);
    const verified = context.evidence.verifyScreenshot(captured);

    expect(verified.screenshot_sha256).toHaveLength(64);
    expect(verified.screenshot_path).toBe(join(context.evidence.runRoot, "browser", "terminal.png"));
    expect(runner.calls.map(commandName)).toEqual(["open", "wait", "get", "get", "snapshot", "eval", "screenshot"]);
    for (const call of runner.calls) {
      expect(call).toContain("--session");
      expect(call).toContain("concierge-sandbox-lane-1");
      expect(call).toContain("--profile");
      expect(call).toContain(context.profilePath);
      expect(call).toContain(`${APPROVED_SANDBOX_WORKSPACE_DOMAIN},app.slack.com`);
      expect(call).not.toContain("Default");
    }
    expect(runner.calls[0]!.at(-1)).toBe(`https://${APPROVED_SANDBOX_WORKSPACE_DOMAIN}${permalinkPath}`);
    const accessibility = JSON.parse(readFileSync(verified.accessibility_path, "utf8"));
    expect(accessibility).toMatchObject({
      lane_id: "lane-1",
      browser_namespace: "concierge-sandbox-lane-1",
      browser_profile_path: context.profilePath,
      team_id: "TSANDBOX1",
      channel_id: "CCORE1",
    });
    const geometry = JSON.parse(readFileSync(verified.geometry_path, "utf8"));
    expect(geometry.geometry.target).toMatchObject({ visible: true, message_ts: messageTs });
    await expect(driver.capture(request(context.profilePath), context.evidence))
      .rejects.toMatchObject({ code: "browser_evidence_exists" });
    expect(runner.calls).toHaveLength(7);
  });

  test("refuses production or non-exact permalinks before invoking the browser", async () => {
    const context = setup();
    const runner = new FakeAgentBrowserRunner();
    const bad = {
      ...request(context.profilePath),
      workspace_domain: "tejas.slack.com",
      permalink: `https://tejas.slack.com${permalinkPath}`,
    };
    await expect(new AgentBrowserSlackDriver(context.lane, runner).capture(bad, context.evidence))
      .rejects.toMatchObject({ code: "invalid_browser_permalink" });
    expect(runner.calls).toHaveLength(0);
  });

  test("fails closed on an unauthenticated or wrong-workspace redirect before screenshot", async () => {
    const context = setup();
    const runner = new FakeAgentBrowserRunner();
    runner.observedUrl = "https://app.slack.com/workspace-signin";
    await expect(new AgentBrowserSlackDriver(context.lane, runner).capture(request(context.profilePath), context.evidence))
      .rejects.toMatchObject({ code: "browser_identity_mismatch" });
    expect(runner.calls.map(commandName)).not.toContain("screenshot");
  });

  test("fails closed when accessibility or visible target geometry does not prove the case", async () => {
    const context = setup();
    const missingText = new FakeAgentBrowserRunner();
    missingText.geometry = { ...missingText.geometry, required_text: [{ text: marker, count: 0 }] };
    await expect(new AgentBrowserSlackDriver(context.lane, missingText).capture(request(context.profilePath), context.evidence))
      .rejects.toMatchObject({ code: "browser_render_mismatch" });

    const second = setup();
    const hiddenTarget = new FakeAgentBrowserRunner();
    hiddenTarget.geometry = {
      ...hiddenTarget.geometry,
      target: { ...(hiddenTarget.geometry.target as object), visible: false },
    };
    await expect(new AgentBrowserSlackDriver(second.lane, hiddenTarget).capture(request(second.profilePath), second.evidence))
      .rejects.toMatchObject({ code: "browser_render_mismatch" });
  });

  test("opens only the explicit headed sandbox login boundary without claiming authentication", async () => {
    const context = setup();
    const runner = new FakeAgentBrowserRunner();
    const result = await new AgentBrowserSlackDriver(context.lane, runner).openLoginBoundary();
    expect(result).toMatchObject({ lane_id: "lane-1", authentication_verified: false });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toContain("--headed");
    expect(runner.calls[0]!.at(-1)).toBe(`https://${APPROVED_SANDBOX_WORKSPACE_DOMAIN}/`);
  });

  test("requires an existing owner-only lane profile and redacts command failure output", async () => {
    const root = scratch();
    expect(() => new SandboxEvidenceWriter("lane-1", "run-2", join(root, "state"), join(root, "wrong-evidence")))
      .toThrow("does not belong to the selected sandbox claim");
    const missingProfile = join(root, "browser", "lane-1");
    const missingLane = fixtures(missingProfile);
    const runner = new FakeAgentBrowserRunner();
    await expect(new AgentBrowserSlackDriver(missingLane, runner).capture(
      request(missingProfile),
      new SandboxEvidenceWriter("lane-1", "run-2", join(root, "state")),
    )).rejects.toBeInstanceOf(SandboxBrowserBoundaryUnavailable);
    expect(runner.calls).toHaveLength(0);

    const context = setup();
    const failed = new FakeAgentBrowserRunner();
    failed.failOperation = "open";
    let error: unknown;
    try {
      await new AgentBrowserSlackDriver(context.lane, failed).capture(request(context.profilePath), context.evidence);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SandboxBrowserDriverError);
    expect(String(error)).not.toContain("xoxb-must-not-leak");
  });
});
