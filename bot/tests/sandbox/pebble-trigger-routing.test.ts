import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaneFixtureIdentities } from "../../scripts/sandbox-provision";
import {
  runPebbleTriggerRoutingCase,
  type PebbleCaptureReceipt,
  type PebbleCaptureRequest,
  type PebbleTriggerRoutingAdapter,
  type PebbleTriggerRoutingObservation,
} from "./cases/pebble-trigger-routing.case";
import { assertBrowserRequestMatchesLane, type BrowserCaptureRequest, type SandboxBrowser } from "./support/browser";
import { SandboxEvidenceWriter, type ScreenshotEvidence } from "./support/evidence";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "sandbox-pebble-routing-"));
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

function eventId(input: PebbleCaptureRequest): string {
  const hash = createHash("sha256");
  for (const part of ["pebble-index:v1", "pebble-index", String(input.recorded_at_ms), input.client, input.transcription]) {
    hash.update(part);
    hash.update("\0");
  }
  return hash.digest("hex");
}

class FakeAdapter implements PebbleTriggerRoutingAdapter {
  private readonly accepted = new Set<string>();
  forceSingleSlack = false;

  async submitPebbleCapture(input: PebbleCaptureRequest): Promise<PebbleCaptureReceipt> {
    if (input.trigger === "future-unknown-trigger") {
      return {
        ...input,
        http_status: 422,
        event_id: null,
        duplicate: null,
        status: null,
        source_trigger: null,
        source_webhook_version: null,
        destination_kind: null,
        terminal_receipt: null,
        error: "unknown Pebble trigger: future-unknown-trigger",
      };
    }
    const id = eventId(input);
    const duplicate = this.accepted.has(id);
    this.accepted.add(id);
    return {
      ...input,
      http_status: duplicate ? 200 : 202,
      event_id: id,
      duplicate,
      status: "queued",
      source_trigger: input.trigger || null,
      source_webhook_version: input.webhook_version || null,
      destination_kind: input.trigger === "single-click-hold" ? "journal" : "slack",
      terminal_receipt: null,
      error: null,
    };
  }

  async waitForPebbleTriggerRouting(input: {
    single: PebbleCaptureReceipt;
    double: PebbleCaptureReceipt;
    test: PebbleCaptureReceipt;
    legacy: PebbleCaptureReceipt;
    unknown_event_id: string;
  }): Promise<PebbleTriggerRoutingObservation> {
    const effect = (receipt: PebbleCaptureReceipt, kind: "slack" | "journal") => ({
      event_id: receipt.event_id!,
      capture_status: "delivered" as const,
      source_trigger: receipt.source_trigger,
      source_webhook_version: receipt.source_webhook_version,
      destination_kind: kind,
      slack_message_count: kind === "slack" || this.forceSingleSlack ? 1 : 0,
      slack_message_ts: kind === "slack" ? "1788000000.000001" : null,
      input_claims: kind === "slack" ? 1 : 0,
      turns: kind === "slack" ? 1 : 0,
      delivered_responses: kind === "slack" ? 1 : 0,
      journal_file_name: kind === "journal" ? `pebble-${receipt.event_id}.md` : null,
      journal_sha256: kind === "journal" ? "a".repeat(64) : null,
      permalink: kind === "slack"
        ? "https://sandbox-workspace.slack.com/archives/DDM1/p1788000000000001"
        : null,
    });
    return {
      api_app_id: fixtures.app_id,
      ingress_active: true,
      capture_process_pid: 123,
      single: effect(input.single, "journal"),
      double: effect(input.double, "slack"),
      test: effect(input.test, "slack"),
      legacy: effect(input.legacy, "slack"),
      unknown: {
        event_id: input.unknown_event_id,
        capture_rows: 0,
        slack_message_count: 0,
        input_claims: 0,
        turns: 0,
        journal_file_count: 0,
      },
      run_owned_unsettled: 0,
    };
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

describe("Pebble trigger routing sandbox case", () => {
  test("proves single, double, test, legacy, duplicate, and unknown effects through one ingress", async () => {
    const evidence = new SandboxEvidenceWriter("lane-1", "run-1", scratch());
    const result = await runPebbleTriggerRoutingCase({
      lane: fixtures,
      workspaceDomain: "concierge--sandbox.enterprise.slack.com",
      runId: "run-1",
      adapter: new FakeAdapter(),
      browser: new FakeBrowser(evidence.runRoot),
      evidence,
    });
    expect(result.status).toBe("passed");
    expect(result.receipts.single_duplicate).toMatchObject({ duplicate: true, http_status: 200 });
    expect(result.observation.single).toMatchObject({ slack_message_count: 0, input_claims: 0, turns: 0 });
    expect(result.observation.double).toMatchObject({ slack_message_count: 1, input_claims: 1, turns: 1 });
    expect(result.observation.unknown).toMatchObject({ capture_rows: 0, slack_message_count: 0, turns: 0 });
    expect(result.browser.screenshot_sha256).toHaveLength(64);
    expect(JSON.parse(readFileSync(join(evidence.runRoot, "pebble-trigger-routing.json"), "utf8"))).toMatchObject({
      case_id: "pebble-trigger-routing",
      status: "passed",
    });
  });

  test("fails if the journal-only single click appears in Slack", async () => {
    const evidence = new SandboxEvidenceWriter("lane-1", "run-failure", scratch());
    const adapter = new FakeAdapter();
    adapter.forceSingleSlack = true;
    await expect(runPebbleTriggerRoutingCase({
      lane: fixtures,
      workspaceDomain: "concierge--sandbox.enterprise.slack.com",
      runId: "run-failure",
      adapter,
      browser: new FakeBrowser(evidence.runRoot),
      evidence,
    })).rejects.toThrow("durable, filesystem, Slack, and provider effects");
  });
});
