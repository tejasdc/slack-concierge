#!/usr/bin/env bun

import { readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ledgerAccess } from "../src/ledger-access-policy";
import { notifyDeploymentWorker } from "../src/deployment-worker-wake";
import { isAncestorProcess, processIdentity } from "../src/runtime-identity";

// A served claim or phase needs only the private socket. Opening even a read-only SQLite
// connection in this short-lived helper can acquire WAL writer/checkpoint locks on close.
const stateDir = process.env.CONCIERGE_STATE_DIR;
const ownerServedDeploymentCommand = stateDir
  ? ledgerAccess(realpathSync(stateDir), Bun.main, false).ownerServedDeploymentCommand
  : false;
const state = ownerServedDeploymentCommand
  ? {} as typeof import("../src/deployment-state")
  : await import("../src/deployment-state");
const {
  beginDeploymentRepair,
  claimDeploymentRun,
  claimDeploymentRepair,
  completeDeploymentRun,
  failDeploymentRun,
  getDeploymentRun,
  getDeploymentRepairIncident,
  deploymentContinuationForAgent,
  recordDeploymentRunPhase,
  recordPreservedCheckout,
  requestDeployment,
  requestOperatorDeployment,
} = state;

async function ownerDeploymentMutation(operation: "claim" | "phase" | "show" | "desired" | "succeed" | "fail" | "preserved-checkout", input: Record<string, unknown>): Promise<any> {
  const stateDir = process.env.CONCIERGE_STATE_DIR;
  if (!stateDir) throw new Error("CONCIERGE_STATE_DIR is required for deployment state.");
  let response: Response;
  try {
    response = await fetch("http://localhost/internal/deployment-run", {
      unix: join(stateDir, "request-owner.sock"), method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ operation, ...input }),
    } as RequestInit);
  } catch (cause) {
    throw Object.assign(new Error(`Serving owner is unreachable for ${operation}.`, {cause}),
      {ownerTransportUnavailable:true});
  }
  const result = await response.json();
  if (!response.ok) throw new Error(`Serving owner refused ${operation}: ${JSON.stringify(result)}`);
  return result;
}

function coordinatorFullyStopped(): boolean {
  const result = spawnSync('systemctl', ['show', process.env.CONCIERGE_SERVICE || 'concierge-bot.service',
    '-p', 'MainPID', '-p', 'ControlPID', '-p', 'ActiveState'], {encoding:'utf8'});
  const fields = Object.fromEntries(result.stdout.trim().split('\n').map(line => line.split('=')));
  return result.status === 0 && fields.MainPID === '0' && fields.ControlPID === '0'
    && ['inactive','failed'].includes(fields.ActiveState);
}

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

function integerOption(name: string): number | undefined {
  const value = option(name);
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be an integer.`);
  return parsed;
}

try {
  const command = process.argv[2];
  if (command === "request") {
    const sourceTurnId = Number(process.env.CONCIERGE_TURN_ID || "");
    const ownerInstanceId = process.env.CONCIERGE_OWNER_INSTANCE_ID || "";
    const continuation = deploymentContinuationForAgent({
      sourceTurnId,
      ownerInstanceId,
      sourceSessionId: Number(process.env.CONCIERGE_SESSION_ID || ""),
      slackChannelId: process.env.CONCIERGE_SLACK_CHANNEL_ID || "",
      slackThreadTs: process.env.CONCIERGE_SLACK_THREAD_TS || "",
    });
    const result = requestDeployment({
      sourceTurnId: continuation.sourceTurnId,
      ownerInstanceId: continuation.ownerInstanceId,
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
    let run: ReturnType<typeof claimDeploymentRun>;
    try {
      const claim = {
        runId,
        pid: identity.pid,
        bootId: identity.bootId,
        startTicks: identity.startTicks,
      };
      if (ownerServedDeploymentCommand) {
        const result = await ownerDeploymentMutation("claim", claim);
        if (result?.terminal && result?.run) finish(0, {
          status: "terminal", run_status: result.run.status,
          run_id: result.run.id, unit_name: result.run.unit_name,
        });
        run = result;
      } else run = claimDeploymentRun(claim);
    } catch (error) {
      if (ownerServedDeploymentCommand) throw error;
      const terminalRun = getDeploymentRun(runId);
      if (terminalRun && ["succeeded", "failed", "ambiguous"].includes(terminalRun.status)) {
        finish(0, {
          status: "terminal",
          run_status: terminalRun.status,
          run_id: terminalRun.id,
          unit_name: terminalRun.unit_name,
        });
      }
      throw error;
    }
    finish(0, { status: run.status, run_id: run.id, unit_name: run.unit_name,
      desired_commit: run.desired_commit });
  }

  if (command === "desired") {
    const runId = requiredOption("--run-id");
    if (ownerServedDeploymentCommand) {
      const answer = await ownerDeploymentMutation("desired", { runId });
      finish(0, answer);
    }
    const run = getDeploymentRun(runId);
    // A read: repair retries and resumed runs read it too, so it never refuses a run that has
    // already been activated; only an unactivated run is ever moved to a newer commit.
    // An operator-requested run starts without one and installs fetched main instead.
    if (!run) throw new Error("The deployment run does not exist.");
    finish(0, { desired_commit: run.desired_commit ?? null, activated: run.activation_state !== null });
  }

  if (command === "operator-request") {
    const result = requestOperatorDeployment();
    finish(0, {
      status: "requested",
      run_id: result.run.id,
      unit_name: result.run.unit_name,
      launch_required: result.launchRequired,
      run_status: result.run.status,
    });
  }

  if (command === "phase") {
    const runId = requiredOption("--run-id");
    const phase = requiredOption("--phase");
    if (!["updating", "restarting", "verifying", "releasing"].includes(phase)) {
      throw new Error(`Unsupported deployment phase ${phase}.`);
    }
    const detail = jsonOption("--detail");
    const run = ownerServedDeploymentCommand
      ? await ownerDeploymentMutation("phase", { runId, phase, detail })
      : recordDeploymentRunPhase(runId,
        phase as "updating" | "restarting" | "verifying" | "releasing", detail);
    finish(0, { status: run.status, run_id: run.id });
  }

  if (command === "preserved-checkout") {
    const input = {
      runId: requiredOption("--run-id"), branch: requiredOption("--branch"),
      worktree: requiredOption("--worktree"), commit: requiredOption("--commit"),
      files: readFileSync(requiredOption("--files-path"), "utf8"),
    };
    const run = ownerServedDeploymentCommand
      ? await ownerDeploymentMutation("preserved-checkout", input)
      : recordPreservedCheckout(input);
    notifyDeploymentWorker();
    finish(0, { status: "preserved", run_id: run.id });
  }

  if (command === "succeed") {
    const input = {
      runId: requiredOption("--run-id"),
      repo: requiredOption("--repo"),
      deployedCommit: requiredOption("--deployed-commit"),
      serviceInvocationId: requiredOption("--service-invocation-id"),
      evidence: jsonOption("--evidence"),
    };
    const run = ownerServedDeploymentCommand
      ? await ownerDeploymentMutation("succeed", input)
      : completeDeploymentRun(input);
    notifyDeploymentWorker();
    finish(0, { status: run.status, run_id: run.id, deployed_commit: run.deployed_commit });
  }

  if (command === "fail") {
    const outcome = option("--outcome") === "ambiguous" ? "ambiguous" : "failed";
    const diagnostics = {
      stage: option("--stage") || undefined,
      failed_command: option("--failed-command") || undefined,
      failure_line: integerOption("--failure-line"),
      exit_status: integerOption("--exit-status"),
    };
    const runId = requiredOption("--run-id");
    const error = requiredOption("--error");
    const options = {
      diagnostics,
      noticeReason: option("--notice-reason") || undefined,
    };
    let run;
    if (!ownerServedDeploymentCommand) run = failDeploymentRun(runId,error,outcome,options);
    else try { run = await ownerDeploymentMutation("fail", {runId,error,outcome,options}); }
    catch (failure) {
      if (!(failure as {ownerTransportUnavailable?:boolean}).ownerTransportUnavailable
        || !coordinatorFullyStopped()) throw failure;
      // Failure recovery may run after the service has stopped. The fully stopped
      // boundary is the only time this controller may become the ledger writer.
      process.env.CONCIERGE_RELEASE_OFFLINE = '1';
      run = (await import('../src/deployment-state')).failDeploymentRun(runId,error,outcome,options);
    }
    if (run) notifyDeploymentWorker();
    finish(run ? 0 : 1, run
      ? { status: run.status, run_id: run.id }
      : { status: "error", error: "deployment run not found" });
  }

  if (command === "show") {
    const runId = requiredOption("--run-id");
    const run = ownerServedDeploymentCommand
      ? await ownerDeploymentMutation("show", { runId })
      : getDeploymentRun(runId);
    finish(run ? 0 : 1, run || { status: "error", error: "deployment run not found" });
  }

  if (command === "repair-begin") {
    const incident = beginDeploymentRepair({
      runId: requiredOption("--run-id"),
      failedCommit: requiredOption("--failed-commit").toLowerCase(),
      restoredCommit: requiredOption("--restored-commit").toLowerCase(),
      failureFingerprint: requiredOption("--failure-fingerprint"),
      error: requiredOption("--error"),
    });
    notifyDeploymentWorker();
    finish(incident.status === "parked" ? 2 : 0, {
      status: incident.status,
      incident_id: incident.id,
      run_id: incident.run_id,
      same_failure_count: incident.same_failure_count,
      unit_name: `concierge-deployment-repair@${incident.id}.service`,
    });
  }

  if (command === "repair-claim") {
    const ownerPid = Number(requiredOption("--owner-pid"));
    if (!Number.isSafeInteger(ownerPid) || ownerPid <= 1 || !isAncestorProcess(ownerPid)) {
      throw new Error("--owner-pid must identify a live ancestor repair supervisor.");
    }
    const identity = processIdentity(ownerPid);
    const incident = claimDeploymentRepair({
      incidentId: requiredOption("--incident-id"),
      pid: identity.pid,
      bootId: identity.bootId,
      startTicks: identity.startTicks,
    });
    finish(0, { status: incident.status, incident_id: incident.id, run_id: incident.run_id });
  }

  if (command === "repair-show") {
    const incident = getDeploymentRepairIncident(requiredOption("--incident-id"));
    finish(incident ? 0 : 1, incident || { status: "error", error: "deployment repair incident not found" });
  }

  throw new Error("usage: deploy-state.ts <request|operator-request|claim|desired|phase|succeed|fail|show|repair-begin|repair-claim|repair-show> [options]");
} catch (error) {
  finish(1, { status: "error", error: error instanceof Error ? error.message : String(error) });
}
