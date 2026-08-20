#!/usr/bin/env bun

import {
  claimDeploymentRun,
  completeDeploymentRun,
  failDeploymentRun,
  getDeploymentRun,
  recordDeploymentRunPhase,
  requestDeployment,
} from "../src/deployment-state";
import { isAncestorProcess, processIdentity } from "../src/runtime-identity";

function finish(code: number, payload: Record<string, unknown>): never {
  console.log(JSON.stringify(payload));
  process.exit(code);
}

function option(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || null : null;
}

function requiredOption(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function jsonOption(name: string): Record<string, unknown> {
  const value = option(name);
  if (!value) return {};
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object.`);
  }
  return parsed;
}

try {
  const command = process.argv[2];
  if (command === "request") {
    const sourceTurnId = Number(process.env.CONCIERGE_TURN_ID || "");
    const ownerInstanceId = process.env.CONCIERGE_OWNER_INSTANCE_ID || "";
    if (!Number.isSafeInteger(sourceTurnId) || sourceTurnId <= 0 || !ownerInstanceId) {
      throw new Error("An agent deploy request requires CONCIERGE_TURN_ID and CONCIERGE_OWNER_INSTANCE_ID.");
    }
    const result = requestDeployment({
      sourceTurnId,
      ownerInstanceId,
      expectedCommit: requiredOption("--expected-commit"),
    });
    finish(0, {
      status: "requested",
      run_id: result.run.id,
      request_id: result.request.id,
      unit_name: result.run.unit_name,
      launch_required: result.launchRequired,
      run_status: result.run.status,
    });
  }

  if (command === "claim") {
    const runId = requiredOption("--run-id");
    const ownerPid = Number(requiredOption("--owner-pid"));
    if (!Number.isSafeInteger(ownerPid) || ownerPid <= 1 || !isAncestorProcess(ownerPid)) {
      throw new Error("--owner-pid must identify a live ancestor deployment runner.");
    }
    const identity = processIdentity(ownerPid);
    const run = claimDeploymentRun({
      runId,
      pid: identity.pid,
      bootId: identity.bootId,
      startTicks: identity.startTicks,
    });
    finish(0, { status: run.status, run_id: run.id, unit_name: run.unit_name });
  }

  if (command === "phase") {
    const runId = requiredOption("--run-id");
    const phase = requiredOption("--phase");
    if (!["updating", "restarting", "verifying", "releasing"].includes(phase)) {
      throw new Error(`Unsupported deployment phase ${phase}.`);
    }
    const run = recordDeploymentRunPhase(
      runId,
      phase as "updating" | "restarting" | "verifying" | "releasing",
      jsonOption("--detail"),
    );
    finish(0, { status: run.status, run_id: run.id });
  }

  if (command === "succeed") {
    const run = completeDeploymentRun({
      runId: requiredOption("--run-id"),
      repo: requiredOption("--repo"),
      deployedCommit: requiredOption("--deployed-commit"),
      serviceInvocationId: requiredOption("--service-invocation-id"),
      evidence: jsonOption("--evidence"),
    });
    finish(0, { status: run.status, run_id: run.id, deployed_commit: run.deployed_commit });
  }

  if (command === "fail") {
    const outcome = option("--outcome") === "ambiguous" ? "ambiguous" : "failed";
    const run = failDeploymentRun(
      requiredOption("--run-id"),
      requiredOption("--error"),
      outcome,
    );
    finish(run ? 0 : 1, run
      ? { status: run.status, run_id: run.id }
      : { status: "error", error: "deployment run not found" });
  }

  if (command === "show") {
    const run = getDeploymentRun(requiredOption("--run-id"));
    finish(run ? 0 : 1, run || { status: "error", error: "deployment run not found" });
  }

  throw new Error("usage: deploy-state.ts <request|claim|phase|succeed|fail|show> [options]");
} catch (error) {
  finish(1, { status: "error", error: error instanceof Error ? error.message : String(error) });
}
