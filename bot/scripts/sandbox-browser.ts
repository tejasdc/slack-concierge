#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DEFAULT_SANDBOX_BROWSER_ROOT,
  DEFAULT_SANDBOX_CONFIG_ROOT,
  DEFAULT_SANDBOX_STATE_ROOT,
  loadLaneFixtureIdentities,
  loadSandboxTopology,
  sandboxProvisioningPaths,
} from "./sandbox-provision";
import {
  APPROVED_SANDBOX_WORKSPACE_DOMAIN,
  AgentBrowserSlackDriver,
  SandboxBrowserDriverError,
  type BrowserCaptureRequest,
} from "../tests/sandbox/support/browser";
import { SandboxEvidenceWriter } from "../tests/sandbox/support/evidence";

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requireArgument(name: string): string {
  const value = argumentValue(name);
  if (!value) throw new SandboxBrowserDriverError("usage", `${name} is required`);
  return value;
}

function requireApply(command: string): void {
  if (!process.argv.includes("--apply")) {
    throw new SandboxBrowserDriverError("apply_required", `${command} requires --apply`);
  }
}

function phaseArgument(): BrowserCaptureRequest["phase"] {
  const phase = argumentValue("--phase") || "terminal";
  if (!(["input", "running", "terminal"] as const).includes(phase as BrowserCaptureRequest["phase"])) {
    throw new SandboxBrowserDriverError("usage", "--phase must be input, running, or terminal");
  }
  return phase as BrowserCaptureRequest["phase"];
}

async function main(): Promise<void> {
  const command = process.argv[2] || "plan";
  const laneId = argumentValue("--lane") || "lane-1";
  const projectRoot = resolve(import.meta.dir, "../..");
  const topology = loadSandboxTopology(join(projectRoot, "config/sandbox-lanes.json"));
  if (topology.workspace_domain !== APPROVED_SANDBOX_WORKSPACE_DOMAIN) {
    throw new SandboxBrowserDriverError("browser_identity_mismatch", "Topology is not the approved sandbox workspace");
  }
  const lane = topology.lanes.find((candidate) => candidate.id === laneId);
  if (!lane) throw new SandboxBrowserDriverError("usage", "--lane must be lane-1 through lane-4");
  const configRoot = process.env.CONCIERGE_SANDBOX_CONFIG_ROOT || DEFAULT_SANDBOX_CONFIG_ROOT;
  const stateRoot = process.env.CONCIERGE_SANDBOX_STATE_ROOT || DEFAULT_SANDBOX_STATE_ROOT;
  const browserRoot = process.env.CONCIERGE_SANDBOX_BROWSER_ROOT || DEFAULT_SANDBOX_BROWSER_ROOT;
  const paths = sandboxProvisioningPaths(configRoot, stateRoot, browserRoot);
  const identityPath = paths.laneIdentity(lane.id);
  const fixturePath = paths.laneFixtures(lane.id);
  const provisioned = existsSync(identityPath) && existsSync(fixturePath);

  if (command === "plan") {
    const persisted = provisioned ? loadLaneFixtureIdentities(identityPath, fixturePath) : null;
    console.log(JSON.stringify({
      schema_version: 1,
      lane_id: lane.id,
      workspace_domain: topology.workspace_domain,
      browser_namespace: persisted?.browser.namespace || lane.browser_namespace,
      browser_profile_path: persisted?.browser.profile_path || paths.laneBrowserProfile(lane.id),
      identity_path: identityPath,
      fixtures_path: fixturePath,
      login: {
        explicit_one_time_boundary: true,
        command: `bun run scripts/sandbox-browser.ts login --lane ${lane.id} --apply`,
        automation_scope: "open the approved sandbox workspace in the exact headed lane profile; never enter credentials",
      },
      probe: {
        mutates_slack: false,
        requires_apply: true,
        required_arguments: ["--run-id", "--permalink", "--channel-id", "--message-ts"],
        evidence_root_pattern: join(paths.laneRunRoot(lane.id, "<run-id>"), "evidence"),
      },
      ready_for_login_or_probe: provisioned,
    }, null, 2));
    return;
  }

  if (!provisioned) {
    throw new SandboxBrowserDriverError("browser_boundary_unverified", `Lane identity/fixtures are not provisioned for ${lane.id}`);
  }
  const fixtures = loadLaneFixtureIdentities(identityPath, fixturePath);
  const driver = new AgentBrowserSlackDriver(fixtures);

  if (command === "login") {
    requireApply("sandbox browser login boundary");
    console.log(JSON.stringify(await driver.openLoginBoundary(topology.workspace_domain), null, 2));
    return;
  }
  if (command !== "probe") {
    throw new SandboxBrowserDriverError("usage", "command must be plan, login, or probe");
  }

  requireApply("sandbox browser live probe");
  const runId = requireArgument("--run-id");
  const evidence = new SandboxEvidenceWriter(
    lane.id,
    runId,
    stateRoot,
    process.env.CONCIERGE_SANDBOX_EVIDENCE_DIR,
  );
  const request: BrowserCaptureRequest = {
    lane_id: lane.id,
    workspace_domain: topology.workspace_domain,
    browser_namespace: fixtures.browser.namespace,
    browser_profile_path: fixtures.browser.profile_path,
    phase: phaseArgument(),
    permalink: requireArgument("--permalink"),
    channel_id: requireArgument("--channel-id"),
    message_ts: requireArgument("--message-ts"),
    assertions: ["exact sandbox workspace, lane profile, channel, permalink, visible target, and channel header"],
    ...(argumentValue("--required-text") ? { required_text: [argumentValue("--required-text")!] } : {}),
  };
  const captured = await driver.capture(request, evidence);
  const verified = evidence.verifyScreenshot(captured);
  evidence.writeJson("browser-probe.json", {
    schema_version: 1,
    lane_id: lane.id,
    run_id: runId,
    browser_namespace: fixtures.browser.namespace,
    browser_profile_path: fixtures.browser.profile_path,
    app_id: fixtures.app_id,
    team_id: fixtures.team_id,
    evidence: verified,
    status: "passed",
  });
  console.log(JSON.stringify({ ok: true, lane_id: lane.id, run_id: runId, evidence: verified }, null, 2));
}

if (import.meta.main) {
  main().catch((error) => {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "sandbox_browser_failed";
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ ok: false, code, message }));
    process.exit(1);
  });
}
