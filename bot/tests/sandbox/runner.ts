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
  const laneId = requestedLaneId || "lane-1";
  const runId = requestedRunId || `unassigned-${Date.now()}`;
  const projectRoot = resolve(import.meta.dir, "../../..");
  const topology = loadSandboxTopology(join(projectRoot, "config/sandbox-lanes.json"));
  const lane = topology.lanes.find((candidate) => candidate.id === laneId);
  if (!lane || caseId !== "typed-turn") throw new Error("usage: runner.ts <plan|execute> typed-turn --lane lane-N --run-id <id>");
  const configRoot = process.env.CONCIERGE_SANDBOX_CONFIG_ROOT || DEFAULT_SANDBOX_CONFIG_ROOT;
  const stateRoot = process.env.CONCIERGE_SANDBOX_STATE_ROOT || DEFAULT_SANDBOX_STATE_ROOT;
  const browserRoot = process.env.CONCIERGE_SANDBOX_BROWSER_ROOT || DEFAULT_SANDBOX_BROWSER_ROOT;
  const paths = sandboxProvisioningPaths(configRoot, stateRoot, browserRoot);
  const fixturePath = paths.laneFixtures(lane.id);
  if (command === "plan") {
    console.log(JSON.stringify({
      case_id: "typed-turn",
      lane_id: lane.id,
      run_id: runId,
      fixtures_path: fixturePath,
      evidence_root: join(paths.laneRunRoot(lane.id, runId), "evidence"),
      required_boundaries: [
        "lane runtime already owns only this app's Socket Mode connection",
        "typed-turn adapter proves api_app_id plus exact durable input/turn/session/delivery identities",
        "lane browser profile is authenticated and captures exact-permalink screenshot/accessibility/geometry evidence",
      ],
      executable: true,
      requires_apply: true,
      reason: "execute requires --apply, an explicit lane/run ID, provisioned fixtures, and an exact running controller claim",
    }, null, 2));
    return;
  }
  if (command !== "execute") throw new SandboxAcceptanceRunnerError("usage", "unknown sandbox runner command");
  if (!process.argv.includes("--apply")) {
    throw new SandboxAcceptanceRunnerError("apply_required", "live typed-turn execution requires --apply");
  }
  if (!requestedLaneId || !requestedRunId) {
    throw new SandboxAcceptanceRunnerError(
      "usage",
      "live typed-turn execution requires explicit --lane lane-N and --run-id <controller-run-id>",
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
  evidence.writeJson("acceptance-run.json", {
    schema_version: 1,
    case_id: "typed-turn",
    lane_id: lane.id,
    run_id: runId,
    workspace_domain: topology.workspace_domain,
    source_head: process.env.CONCIERGE_SANDBOX_SOURCE_HEAD || "unverified",
    source_diff_digest: process.env.CONCIERGE_SANDBOX_SOURCE_DIFF_DIGEST || "unverified",
  });
  await runTypedTurnCase({
    lane: fixtures,
    workspaceDomain: topology.workspace_domain,
    runId,
    expectedProvider: "codex",
    adapter: surfaces.adapter,
    browser: surfaces.browser,
    evidence,
  });
}

if (import.meta.main) {
  main().catch((error) => {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "sandbox_case_failed";
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ ok: false, code, message }));
    process.exit(1);
  });
}
