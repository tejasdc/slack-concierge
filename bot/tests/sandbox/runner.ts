#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DEFAULT_SANDBOX_CONFIG_ROOT,
  DEFAULT_SANDBOX_BROWSER_ROOT,
  DEFAULT_SANDBOX_STATE_ROOT,
  loadLaneFixtureIdentities,
  loadSandboxTopology,
  sandboxProvisioningPaths,
} from "../../scripts/sandbox-provision";
import { AgentBrowserSlackDriver } from "./support/browser";
import { SandboxEvidenceWriter } from "./support/evidence";
import { runTypedTurnCase, UnverifiedTypedTurnAdapter } from "./cases/typed-turn.case";

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const command = process.argv[2] || "plan";
  const caseId = process.argv[3] || "typed-turn";
  const laneId = argumentValue("--lane") || "lane-1";
  const runId = argumentValue("--run-id") || `unassigned-${Date.now()}`;
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
      executable: false,
      reason: "live adapters remain deliberately unverified until exercised in the real sandbox",
    }, null, 2));
    return;
  }
  if (command !== "execute") throw new Error("unknown sandbox runner command");
  if (!existsSync(fixturePath)) throw new Error(`lane fixtures are not provisioned: ${fixturePath}`);
  const fixtures = loadLaneFixtureIdentities(paths.laneIdentity(lane.id), fixturePath);
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
    adapter: new UnverifiedTypedTurnAdapter(),
    browser: new AgentBrowserSlackDriver(fixtures),
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
