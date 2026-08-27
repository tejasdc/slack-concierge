import type { LaneFixtureIdentities } from "../../../scripts/sandbox-provision";
import type { SandboxEvidenceWriter, ScreenshotEvidence } from "./evidence";

export type BrowserCaptureRequest = {
  lane_id: string;
  workspace_domain: string;
  browser_namespace: string;
  browser_profile_path: string;
  phase: "input" | "running" | "terminal";
  permalink: string;
  channel_id: string;
  message_ts: string;
  assertions: string[];
};

export interface SandboxBrowser {
  capture(request: BrowserCaptureRequest, evidence: SandboxEvidenceWriter): Promise<ScreenshotEvidence>;
}

export class SandboxBrowserBoundaryUnavailable extends Error {
  readonly code = "browser_boundary_unverified";

  constructor(laneId: string, profilePath: string) {
    super(
      `Slack web automation is not authenticated/implemented for ${laneId} at ${profilePath}; `
      + "do not claim visual verification. Complete the one-time sandbox-only browser profile setup, "
      + "then supply a driver that navigates the exact permalink and writes screenshot, accessibility, and geometry evidence.",
    );
  }
}

export class UnverifiedSandboxBrowser implements SandboxBrowser {
  constructor(private readonly fixtures: LaneFixtureIdentities) {}

  async capture(): Promise<ScreenshotEvidence> {
    throw new SandboxBrowserBoundaryUnavailable(this.fixtures.lane_id, this.fixtures.browser.profile_path);
  }
}

export function assertBrowserRequestMatchesLane(
  request: BrowserCaptureRequest,
  fixtures: LaneFixtureIdentities,
): void {
  if (request.lane_id !== fixtures.lane_id
      || request.browser_namespace !== fixtures.browser.namespace
      || request.browser_profile_path !== fixtures.browser.profile_path) {
    throw new Error("Browser request does not belong to the selected sandbox lane");
  }
  const knownChannels = new Set([
    fixtures.dm_channel_id,
    fixtures.channels.core.id,
    fixtures.channels.project.id,
    fixtures.channels.capture.id,
  ]);
  if (!knownChannels.has(request.channel_id)) throw new Error("Browser request targets a channel outside the selected lane");
  const encodedTs = request.message_ts.replace(".", "");
  if (!request.permalink.includes(`/archives/${request.channel_id}/p${encodedTs}`)) {
    throw new Error("Browser permalink does not identify the expected lane message");
  }
}
