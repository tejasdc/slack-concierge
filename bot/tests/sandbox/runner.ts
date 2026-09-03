#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { LaneFixtureIdentities } from "../../scripts/sandbox-provision";
import {
  DEFAULT_SANDBOX_CONFIG_ROOT,
  DEFAULT_SANDBOX_BROWSER_ROOT,
  DEFAULT_SANDBOX_STATE_ROOT,
  loadLaneFixtureIdentities,
  loadSandboxTopology,
  sandboxProvisioningPaths,
} from "../../scripts/sandbox-provision";
import { LiveTypedTurnAdapter } from "./adapters/live-typed-turn";
import { AgentBrowserSlackDriver } from "./support/browser";
import { SandboxEvidenceWriter } from "./support/evidence";
import { runParkedResumeCase } from "./cases/parked-resume.case";
import { runTodoCaptureCase } from "./cases/todo-capture.case";
import { runTypedTurnCase } from "./cases/typed-turn.case";

export class SandboxAcceptanceRunnerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export function createLiveTypedTurnSurfaces(options: {
  lane: LaneFixtureIdentities;
  workspaceDomain: string;
  runId: string;
  stateRoot: string;
  configPath: string;
}) {
  return {
    adapter: new LiveTypedTurnAdapter(options),
    browser: new AgentBrowserSlackDriver(options.lane),
  };
}

async function main(): Promise<void> {
  const command = process.argv[2] || "plan";
  const caseId = process.argv[3] || "typed-turn";
  const requestedLaneId = argumentValue("--lane");
  const requestedRunId = argumentValue("--run-id");
  const requestedSurface = argumentValue("--surface") || "core";
  const caseSurface = caseId === "todo-capture" ? "capture" : requestedSurface;
  const laneId = requestedLaneId || "lane-1";
  const runId = requestedRunId || `unassigned-${Date.now()}`;
  const projectRoot = resolve(import.meta.dir, "../../..");
  const topology = loadSandboxTopology(join(projectRoot, "config/sandbox-lanes.json"));
  const lane = topology.lanes.find((candidate) => candidate.id === laneId);
  const supportedCase = caseId === "typed-turn" || caseId === "todo-capture" || caseId === "parked-resume";
  if (!lane || !supportedCase || (caseId === "typed-turn" && !["core", "dm"].includes(requestedSurface))) {
    throw new Error("usage: runner.ts <plan|execute> <typed-turn|todo-capture|parked-resume> --lane lane-N --run-id <id> [--surface core|dm] [--broken-marker <path>]");
  }
  const configRoot = process.env.CONCIERGE_SANDBOX_CONFIG_ROOT || DEFAULT_SANDBOX_CONFIG_ROOT;
  const stateRoot = process.env.CONCIERGE_SANDBOX_STATE_ROOT || DEFAULT_SANDBOX_STATE_ROOT;
  const browserRoot = process.env.CONCIERGE_SANDBOX_BROWSER_ROOT || DEFAULT_SANDBOX_BROWSER_ROOT;
  const paths = sandboxProvisioningPaths(configRoot, stateRoot, browserRoot);
  const fixturePath = paths.laneFixtures(lane.id);
  if (command === "plan") {
    console.log(JSON.stringify({
      case_id: caseId,
      lane_id: lane.id,
      run_id: runId,
      surface: caseSurface,
      fixtures_path: fixturePath,
      evidence_root: join(paths.laneRunRoot(lane.id, runId), "evidence"),
      required_boundaries: caseId === "typed-turn" ? [
        "lane runtime already owns only this app's Socket Mode connection",
        "typed-turn adapter proves exact input/provider identities plus a visible running activity and terminal delivery",
        "lane browser profile captures running and terminal thread evidence including Work complete, final TL;DR, and cumulative root TL;DR",
      ] : caseId === "parked-resume" ? [
        "lane candidate was claimed with CONCIERGE_CLAUDE_CODE_EXECUTABLE pointing at tests/sandbox/support/claude-auth-stub.sh and CONCIERGE_SANDBOX_CLAUDE_BROKEN_MARKER at the --broken-marker path",
        "parked-resume adapter proves the exact park with remediation notice, one auto-resume per boundary while broken, and FIFO drain after healing",
        "lane browser proves the remediation notice and every delivered marker response in the exact thread",
      ] : [
        "lane runtime already owns only this app's Socket Mode connection",
        "todo-capture adapter proves the exact input became one settled durable capture and no provider turn",
        "Slack API and the lane browser prove one white-check-mark reaction and zero thread replies",
      ],
      executable: true,
      requires_apply: true,
      reason: "execute requires --apply, an explicit lane/run ID, provisioned fixtures, and an exact running controller claim",
    }, null, 2));
    return;
  }
  if (command !== "execute") throw new SandboxAcceptanceRunnerError("usage", "unknown sandbox runner command");
  if (!process.argv.includes("--apply")) {
    throw new SandboxAcceptanceRunnerError("apply_required", `live ${caseId} execution requires --apply`);
  }
  if (!requestedLaneId || !requestedRunId) {
    throw new SandboxAcceptanceRunnerError(
      "usage",
      `live ${caseId} execution requires explicit --lane lane-N and --run-id <controller-run-id>`,
    );
  }
  const identityPath = paths.laneIdentity(lane.id);
  if (!existsSync(identityPath) || !existsSync(fixturePath)) {
    throw new SandboxAcceptanceRunnerError("lane_not_provisioned", `lane identity/fixtures are not provisioned for ${lane.id}`);
  }
  const fixtures = loadLaneFixtureIdentities(paths.laneIdentity(lane.id), fixturePath);
  const surfaces = createLiveTypedTurnSurfaces({
    lane: fixtures,
    workspaceDomain: topology.workspace_domain,
    runId,
    stateRoot,
    configPath: paths.laneSlackConfig(lane.id),
  });
  const evidence = new SandboxEvidenceWriter(
    lane.id,
    runId,
    stateRoot,
    process.env.CONCIERGE_SANDBOX_EVIDENCE_DIR,
  );
  const source = surfaces.adapter.runSourceEvidence();
  evidence.writeJson("acceptance-run.json", {
    schema_version: 1,
    case_id: caseId,
    lane_id: lane.id,
    run_id: runId,
    surface: caseSurface,
    workspace_domain: topology.workspace_domain,
    ...source,
  });
  if (caseId === "todo-capture") {
    await runTodoCaptureCase({
      lane: fixtures,
      workspaceDomain: topology.workspace_domain,
      runId,
      adapter: surfaces.adapter,
      browser: surfaces.browser,
      evidence,
    });
  } else if (caseId === "parked-resume") {
    const brokenMarkerPath = argumentValue("--broken-marker");
    if (!brokenMarkerPath) {
      throw new SandboxAcceptanceRunnerError("usage", "parked-resume requires --broken-marker <path>");
    }
    await runParkedResumeCase({
      lane: fixtures,
      workspaceDomain: topology.workspace_domain,
      runId,
      brokenMarkerPath,
      adapter: surfaces.adapter,
      browser: surfaces.browser,
      evidence,
    });
  } else {
    await runTypedTurnCase({
      lane: fixtures,
      workspaceDomain: topology.workspace_domain,
      runId,
      expectedProvider: "codex",
      adapter: surfaces.adapter,
      browser: surfaces.browser,
      evidence,
      surface: requestedSurface as "core" | "dm",
    });
  }
}

if (import.meta.main) {
  main().catch((error) => {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "sandbox_case_failed";
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ ok: false, code, message }));
    process.exit(1);
  });
}
