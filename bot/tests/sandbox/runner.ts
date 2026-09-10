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
import { runClaudeSteeringAckCase } from "./cases/claude-steering-ack.case";
import { runProgressCardCase } from "./cases/progress-card.case";
import { runTodoCaptureCase } from "./cases/todo-capture.case";
import { runTypedTurnCase } from "./cases/typed-turn.case";
import { runClaudeDefaultModelCase } from "./cases/claude-default-model.case";
import { runPebbleTriggerRoutingCase } from "./cases/pebble-trigger-routing.case";
import { runThinkeringCaptureCase } from "./cases/thinkering-capture.case";
import { runRouterSearchCase } from "./cases/router-search.case";
import { runHintCommandCase } from "./cases/hint-command.case";
import { runRouterReplyCase } from "./cases/router-reply.case";
import { runQueuedRequestsCase } from "./cases/queued-requests.case";
import { runDeploymentRepairCase } from "./cases/deployment-repair.case";

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
  const requestedRootShape = argumentValue("--root-shape") || "standard";
  const caseSurface = caseId === "todo-capture" ? "capture" : ["pebble-trigger-routing", "router-reply"].includes(caseId) ? "dm" : requestedSurface;
  const laneId = requestedLaneId || "lane-1";
  const runId = requestedRunId || `unassigned-${Date.now()}`;
  const projectRoot = resolve(import.meta.dir, "../../..");
  const topology = loadSandboxTopology(join(projectRoot, "config/sandbox-lanes.json"));
  const lane = topology.lanes.find((candidate) => candidate.id === laneId);
  const supportedCase = caseId === "deployment-repair" || caseId === "typed-turn" || caseId === "todo-capture" || caseId === "claude-default-model"
    || caseId === "parked-resume" || caseId === "claude-steering-ack" || caseId === "progress-card" || caseId === "progress-details"
    || caseId === "pebble-trigger-routing" || caseId === "thinkering-capture" || caseId === "router-search" || caseId === "router-reply" || caseId === "hint-command" || caseId === 'queued-requests';
  if (!lane || !supportedCase || (caseId === "typed-turn" && (!["core", "dm"].includes(requestedSurface)
      || !["standard", "summary-limit"].includes(requestedRootShape)))) {
    throw new Error("usage: runner.ts <plan|execute> <typed-turn|hint-command|claude-default-model|router-search|router-reply|queued-requests|todo-capture|pebble-trigger-routing|thinkering-capture|parked-resume|claude-steering-ack|progress-card|progress-details> --lane lane-N --run-id <id> [--surface core|dm] [--root-shape standard|summary-limit] [--broken-marker <path>]");
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
      required_boundaries: caseId === "queued-requests" ? [
        "claim with CONCIERGE_CLAUDE_CODE_EXECUTABLE pointing at tests/sandbox/support/queued-request-provider.sh",
        "a user-authored file-backed request waits quietly for exact work in two channels and runs once while later source-session work continues",
        "explicit empty/completed deferred resumes queue behind active destination work; an ordinary API resume still steers",
        "exact request, input, dependency, Slack API, browser and provider evidence plus zero unsettled work",
      ] : caseId === "router-reply" ? [
        "claim with CONCIERGE_SANDBOX_ROUTER_REPLY_MODE=1 to select only the lane DM",
        "one actual routed capture replaces its progress message with the final receipt; the destination retains separate replies",
        "a follow-up retains the earlier receipt; exact input/state/API/browser evidence proves one bot message per DM turn and zero unsettled work",
      ] : caseId === "claude-default-model" ? [
        "bare @cc starts a real Claude turn with Concierge's default model",
        "exact input, durable model selection, provider-reported footer, Slack delivery, and zero unsettled work",
      ] : caseId === "hint-command" ? [
        "claim with CONCIERGE_CLAUDE_CODE_EXECUTABLE pointing at tests/sandbox/support/claude-steering-ack-stub.sh",
        "unregistered channel and DM hints create no channel; registered active and silent threads show current settings",
        "exact input claims, Slack replies, lane browser and terminal provider evidence prove help never becomes steering, capture or a turn",
      ] : caseId === "router-search" ? [
        "real historical core root predates a cold DM router session and a more recent unrelated root",
        "the owned helper drives one exact historical resume; empty, failed, and ambiguous retrieval only clarify",
        "read-only ledger/API evidence and lane browser prove exact destinations and zero unsettled work",
      ] : caseId === "thinkering-capture" ? [
        "only single-click-hold and its exact retry traverse the owned native ingress",
        "the configured thinkering-inbox sink produces one immutable journal and zero Slack messages, inputs or turns",
        "all Slack calls in this case are auth.test and conversations.history reads; no browser or provider starts",
      ] : caseId === "typed-turn" ? [
        "lane runtime already owns only this app's Socket Mode connection",
        "typed-turn adapter proves exact input/provider identities plus a visible running activity and terminal delivery",
        "lane browser profile captures running and terminal thread evidence including Work complete, final TL;DR, and cumulative root TL;DR",
      ] : caseId === "pebble-trigger-routing" ? [
        "the claimed controller run owns one readiness-proven run-local ingress, private queue, credential root, capture database, and journal directory",
        "source-pinned single, double, test, legacy, and unknown-trigger requests traverse the actual ingress",
        "capture state, journal bytes, Slack inputs, provider turns, terminal responses, and zero-unsettled state prove each exact event identity",
      ] : caseId === "parked-resume" ? [
        "lane candidate was claimed with CONCIERGE_CLAUDE_CODE_EXECUTABLE pointing at tests/sandbox/support/claude-auth-stub.sh and CONCIERGE_SANDBOX_CLAUDE_BROKEN_MARKER at the --broken-marker path",
        "parked-resume adapter proves the exact park with remediation notice, one auto-resume per boundary while broken, and FIFO drain after healing",
        "lane browser proves the remediation notice and every delivered marker response in the exact thread",
      ] : caseId === "claude-steering-ack" ? [
        "lane candidate was claimed with CONCIERGE_CLAUDE_CODE_EXECUTABLE pointing at tests/sandbox/support/claude-steering-ack-stub.sh",
        "the stub echoes the exact steering user event without optional isReplay metadata",
        "durable state, Slack API, and the lane browser prove replay eligibility, one arrow-right-hook reaction, the steering-dependent final, and no ambiguity notice",
      ] : caseId === "progress-details" ? [
        "the exact Codex turn emits three commentary updates followed by native web search and page-open activity",
        "one progress message retains Earlier progress as task-card details and web query/page metadata in the activity details",
        "the lane browser captures the exact progress and final response thread",
      ] : caseId === "progress-card" ? [
        "the exact Codex turn emits enough distinct commentary/activity intervals to exceed the former local 50-block rollover guard",
        "durable state and Slack API prove one page-zero progress row, one Agent task progress reply, the completed four-step plan, and no continued-below title",
        "the lane browser captures the sole terminal progress card and final marker in the exact thread",
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
    root_shape: caseId === "typed-turn" ? requestedRootShape : undefined,
    workspace_domain: topology.workspace_domain,
    ...source,
  });
  if (caseId === "deployment-repair") {
    await runDeploymentRepairCase({ lane: fixtures, workspaceDomain: topology.workspace_domain, runId,
      configPath: paths.laneSlackConfig(lane.id), adapter: surfaces.adapter, browser: surfaces.browser, evidence });
  } else if (caseId === "router-reply") {
    await runRouterReplyCase({ lane: fixtures, workspaceDomain: topology.workspace_domain, runId, adapter: surfaces.adapter, browser: surfaces.browser, evidence });
  } else if (caseId === 'queued-requests') {
    await runQueuedRequestsCase({ lane: fixtures, workspaceDomain: topology.workspace_domain, runId, adapter: surfaces.adapter, browser: surfaces.browser, evidence });
  } else if (caseId === "claude-default-model") {
    await runClaudeDefaultModelCase({ lane: fixtures, workspaceDomain: topology.workspace_domain, runId, adapter: surfaces.adapter, browser: surfaces.browser, evidence });
  } else if (caseId === "hint-command") {
    await runHintCommandCase({ lane: fixtures, workspaceDomain: topology.workspace_domain, runId, adapter: surfaces.adapter, browser: surfaces.browser, evidence });
  } else if (caseId === "router-search") {
    await runRouterSearchCase({ lane: fixtures, workspaceDomain: topology.workspace_domain, runId, adapter: surfaces.adapter, browser: surfaces.browser, evidence });
  } else if (caseId === "thinkering-capture") {
    await runThinkeringCaptureCase({ lane: fixtures, runId, adapter: surfaces.adapter, evidence });
  } else if (caseId === "todo-capture") {
    await runTodoCaptureCase({
      lane: fixtures,
      workspaceDomain: topology.workspace_domain,
      runId,
      adapter: surfaces.adapter,
      browser: surfaces.browser,
      evidence,
    });
  } else if (caseId === "pebble-trigger-routing") {
    await runPebbleTriggerRoutingCase({
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
  } else if (caseId === "claude-steering-ack") {
    await runClaudeSteeringAckCase({
      lane: fixtures,
      workspaceDomain: topology.workspace_domain,
      runId,
      adapter: surfaces.adapter,
      browser: surfaces.browser,
      evidence,
    });
  } else if (caseId === "progress-card" || caseId === "progress-details") {
    await runProgressCardCase({
      lane: fixtures,
      workspaceDomain: topology.workspace_domain,
      runId,
      adapter: surfaces.adapter,
      browser: surfaces.browser,
      evidence,
      ...(caseId === "progress-details" ? { variant: "progress-details" as const } : {}),
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
      rootShape: requestedRootShape as "standard" | "summary-limit",
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
