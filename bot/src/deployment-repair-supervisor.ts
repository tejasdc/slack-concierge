import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  bindDeploymentRepairSession,
  assertDeploymentRepairOwner,
  claimDeploymentRepair,
  completeDeploymentRepairAgentRun,
  completeDeploymentRepairIncident,
  getDeploymentRepairIncident,
  getDeploymentRepairBudget,
  getDeploymentRun,
  latestDeploymentRepairAgentRun,
  parkDeploymentRepair,
  parkDeploymentRepairAgentRun,
  prepareDeploymentRepairAgentLaunch,
  prepareDeploymentRetry,
  recoverDeadDeploymentRuns,
  recordDeploymentRepairChild,
  recordDeploymentRepairCommit,
  recordDeploymentRepairWorkspace,
  type DeploymentRepairAgentRunRow,
  type DeploymentRepairIncidentRow,
} from "./deployment-state";
import { currentProcessIdentity, isProcessIdentityAlive, processIdentity } from "./runtime-identity";
import { getTurnCommitProvenance } from "./state";
import { notifyDeploymentWorker } from "./deployment-worker-wake";
import { runRepairAgent, parseRepairAgentResult, RepairAttemptIntegrityError, RepairAttemptStoppedError } from "./deployment-repair-agent";

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface DeploymentRepairServices {
  command(command: string[], options?: { cwd?: string; env?: Record<string, string> }): CommandResult;
  runAgent(input: {
    kind: "repair";
    cwd: string;
    prompt: string;
    sessionUuid?: string | null;
    outputPath: string;
    finalMessagePath: string;
    deadlineMs: number;
    onSpawn(pid: number): void;
    onSession(sessionUuid: string): void;
  }): Promise<number>;
  isAlive(identity: { pid: number; bootId: string; startTicks: string }): boolean;
  notifyWorker?(): void;
  priorUnitQuiescent?(): boolean;
}

function commandText(result: CommandResult) {
  return (result.stderr || result.stdout).trim().slice(0, 4000);
}

function defaultServices(repositoryRoot: string): DeploymentRepairServices {
  return {
    command(command, options = {}) {
      const result = Bun.spawnSync({
        cmd: command,
        cwd: options.cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, HOME: "/root", ...options.env },
      });
      return {
        exitCode: result.exitCode,
        stdout: Buffer.from(result.stdout).toString("utf8"),
        stderr: Buffer.from(result.stderr).toString("utf8"),
      };
    },
    runAgent: (input) => runRepairAgent(input, repositoryRoot),
    isAlive: isProcessIdentityAlive,
    notifyWorker: () => { notifyDeploymentWorker(); },
  };
}

export class DeploymentRepairSupervisor {
  private readonly supervisorIdentity = currentProcessIdentity();
  private readonly incidentRoot: string;

  constructor(
    readonly incidentId: string,
    readonly repositoryRoot = process.env.CONCIERGE_REPO || "/var/lib/slack-concierge-deployment/source",
    readonly services: DeploymentRepairServices = defaultServices(repositoryRoot),
  ) {
    this.incidentRoot = join(
      process.env.CONCIERGE_DEPLOYMENT_RELEASE_ROOT || "/var/lib/slack-concierge-deployment",
      "incidents",
      incidentId,
    );
  }

  async run() {
    let incident = getDeploymentRepairIncident(this.incidentId);
    if (!incident) throw new Error(`Unknown deployment repair incident ${this.incidentId}.`);
    if (incident.status === "parked" || incident.status === "completed") return this.recordOutcome(incident);
    incident = this.claim();
    if (incident.status === "parked") return this.recordOutcome(incident);
    try {
      return this.recordOutcome(await this.runOwned(incident));
    } catch (error) {
      incident = getDeploymentRepairIncident(this.incidentId)!;
      if (["parked", "completed"].includes(incident.status)) return this.recordOutcome(incident);
      this.assertOwner();
      if (error instanceof RepairAttemptIntegrityError || error instanceof RepairAttemptStoppedError || incident.recovery_attempts >= 3) {
        return this.recordOutcome(parkDeploymentRepair(this.incidentId, String(error), {
          noticeReason: `Autonomous repair stopped: ${String(error)}`,
          diagnostics: { supervisor_attempts: incident.recovery_attempts },
        }));
      }
      throw error;
    }
  }

  private recordOutcome(incident: DeploymentRepairIncidentRow) {
    const agent = latestDeploymentRepairAgentRun(incident.id, "repair");
    const run = getDeploymentRun(incident.run_id);
    const deployed = incident.status === "completed" && run?.status === "succeeded";
    const outcome = {
      incident_id: incident.id, run_id: incident.run_id,
      outcome: deployed ? "deployed" : "operator_required",
      incident_status: incident.status, deployment_status: run?.status || "missing",
      repair_commit: incident.repair_commit, deployed_commit: run?.deployed_commit || null,
      restored_commit: incident.restored_commit, error: incident.error,
      provider: "codex", session_uuid: agent?.session_uuid || agent?.requested_session_uuid || null,
      agent_log: agent?.output_path || null, agent_final: agent?.final_message_path || null,
      next_action: deployed ? "No repair action remains."
        : "Operator: inspect this incident's retained final message and logs, resolve the recorded blocker from a standalone CLI, and push through normal Git delivery. Do not replay this parked incident or restart managed providers.",
    };
    // Escalation survives Concierge being down; notification delivery is a separate fact.
    console[deployed ? "log" : "error"](JSON.stringify(outcome));
    try {
      mkdirSync(this.incidentRoot, { recursive: true, mode: 0o700 });
      const path = join(this.incidentRoot, "outcome.json");
      writeFileSync(`${path}.tmp`, `${JSON.stringify(outcome, null, 2)}\n`, { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
    } catch (error) {
      console.error(`Repair outcome file could not be written; durable incident and journal remain authoritative: ${String(error)}`);
    }
    return incident;
  }

  private async runOwned(incident: DeploymentRepairIncidentRow) {
    mkdirSync(this.incidentRoot, { recursive: true, mode: 0o700 });
    const deployCommand = process.env.CONCIERGE_DEPLOY_COMMAND
      || "/usr/local/lib/slack-concierge-deployment/control";
    if (existsSync(deployCommand)) {
      const recovered = this.services.command([deployCommand, "recover"], {
        cwd: this.repositoryRoot,
        env: { CONCIERGE_STATE_DIR: process.env.CONCIERGE_STATE_DIR || "/root/.local/state/concierge" },
      });
      if (recovered.exitCode !== 0) {
        throw new Error(`Interrupted deployment recovery failed: ${commandText(recovered)}`);
      }
      incident = getDeploymentRepairIncident(this.incidentId)!;
    }
    recoverDeadDeploymentRuns(this.services.isAlive);
    while (true) {
      const run = getDeploymentRun(incident.run_id);
      if (!run) throw new Error(`Deployment run ${incident.run_id} disappeared during repair.`);
      if (run.status === "prepared" && run.repair_state === "retrying") {
        const terminal = this.retryDeployment(incident, run);
        if (terminal) return terminal;
        incident = getDeploymentRepairIncident(this.incidentId)!;
        continue;
      }
      if (run.status !== "releasing") {
        throw new Error(`Repair cannot continue while deployment run ${run.id} is ${run.status}/${run.repair_state || "none"}.`);
      }
      incident = this.claim();
      if (incident.status === "parked") return incident;
      if (incident.review_verdict) {
        throw new RepairAttemptStoppedError("This incident retains a historical review. Operator resolution is required; no review, correction loop or reinterpretation of its verdict was attempted.");
      }
      incident = this.ensureWorktree(incident);

      if (!incident.repair_commit) {
        const committed = this.discoverCommittedRepair(incident);
        if (committed) {
          recordDeploymentRepairCommit(this.incidentId, committed);
          incident = getDeploymentRepairIncident(this.incidentId)!;
          continue;
        }
        const result = await this.runRepair(incident, this.initialRepairPrompt(incident));
        incident = getDeploymentRepairIncident(this.incidentId)!;
        recordDeploymentRepairCommit(this.incidentId, this.cleanRepairCommit(incident, result.commit!));
        continue;
      }

      const integration = this.integrateRepair(incident);
      if (integration === "origin_moved") {
        const newBase = this.git(["rev-parse", "origin/main"], this.repositoryRoot);
        incident = recordDeploymentRepairWorkspace(
          this.incidentId,
          incident.worktree_path!,
          incident.branch_name!,
          newBase,
        );
        const result = await this.runRepair(
          incident,
          "[GOALS-ONLY] origin/main moved. Rebase the existing repair onto the new origin/main, preserve the deployment fix, and commit the reconciled repair. Do not run tests, reviews or other agents, or bypass disabled entrypoints. Do not deploy or push. If origin/main already contains the repair, report its exact clean HEAD as repair_committed. If blocked, report blocked with the concrete reason and next executable action; do not manufacture a commit to appear successful.",
        );
        incident = getDeploymentRepairIncident(this.incidentId)!;
        recordDeploymentRepairCommit(this.incidentId, this.cleanRepairCommit(incident, result.commit!, true));
        continue;
      }

      const retry = prepareDeploymentRetry(this.incidentId);
      this.services.notifyWorker?.();
      const terminal = this.retryDeployment(incident, retry);
      if (terminal) return terminal;
      incident = getDeploymentRepairIncident(this.incidentId)!;
    }
  }

  private retryDeployment(incident: DeploymentRepairIncidentRow, retry: ReturnType<typeof getDeploymentRun>) {
    if (!retry) throw new Error("Deployment retry state disappeared before launch.");
    const deployCommand = process.env.CONCIERGE_DEPLOY_COMMAND
      || "/usr/local/lib/slack-concierge-deployment/control";
    const command = existsSync(deployCommand)
      ? [deployCommand, "deploy"]
      : [join(this.repositoryRoot, "bot/scripts/deploy.sh")];
    const deployed = this.services.command(command, {
      cwd: this.repositoryRoot,
      env: {
        CONCIERGE_DEPLOY_DETACHED: "1",
        CONCIERGE_DEPLOY_RUN_ID: retry.id,
        CONCIERGE_STATE_DIR: process.env.CONCIERGE_STATE_DIR || "/root/.local/state/concierge",
      },
    });
    let run = getDeploymentRun(retry.id);
    if (run?.repair_state === "retrying" && run.activation_state && existsSync(deployCommand)) {
      const recovered = this.services.command([deployCommand, "recover"], {
        cwd: this.repositoryRoot,
        env: { CONCIERGE_STATE_DIR: process.env.CONCIERGE_STATE_DIR || "/root/.local/state/concierge" },
      });
      if (recovered.exitCode !== 0) {
        throw new Error(`Interrupted retry recovery failed: ${commandText(recovered)}`);
      }
      run = getDeploymentRun(retry.id);
    }
    if (run?.repair_state === "retrying" && !run.activation_state) {
      recoverDeadDeploymentRuns(this.services.isAlive);
      run = getDeploymentRun(retry.id);
    }
    if (run?.status === "succeeded") return completeDeploymentRepairIncident(this.incidentId);
    if (run?.status === "releasing" && run.repair_state === "restored") return null;
    if (run?.status === "prepared" && run.repair_state === "retrying") {
      throw new Error(`Deployment retry stopped before activation: ${commandText(deployed)}`);
    }
    return parkDeploymentRepair(
      incident.id,
      `Deployment retry exited ${deployed.exitCode} in ${run?.status || "missing"}/${run?.repair_state || "no repair state"}: ${commandText(deployed)}`,
      {
        noticeReason: "The deployment retry ended before it reached a safe terminal state.",
        diagnostics: {
          stage: "repair-retry",
          exit_status: deployed.exitCode,
          command_output: commandText(deployed),
          run_status: run?.status || "missing",
          repair_state: run?.repair_state || "none",
        },
      },
    );
  }

  private claim() {
    return claimDeploymentRepair({
      incidentId: this.incidentId,
      pid: this.supervisorIdentity.pid,
      bootId: this.supervisorIdentity.bootId,
      startTicks: this.supervisorIdentity.startTicks,
    }, this.services.isAlive);
  }

  private assertOwner() {
    return assertDeploymentRepairOwner(this.incidentId, this.supervisorIdentity);
  }

  private ensureWorktree(incident: DeploymentRepairIncidentRow) {
    const worktreePath = incident.worktree_path || join(this.incidentRoot, "worktree");
    const branchName = incident.branch_name || `repair-deployment-${incident.id}`;
    if (!existsSync(join(worktreePath, ".git"))) {
      mkdirSync(this.incidentRoot, { recursive: true, mode: 0o700 });
      const branchExists = this.services.command(
        ["git", "show-ref", "--verify", `refs/heads/${branchName}`],
        { cwd: this.repositoryRoot },
      ).exitCode === 0;
      const added = this.services.command(
        branchExists
          ? ["git", "worktree", "add", worktreePath, branchName]
          : ["git", "worktree", "add", "-b", branchName, worktreePath, incident.base_commit],
        { cwd: this.repositoryRoot },
      );
      if (added.exitCode !== 0) throw new Error(`Repair worktree creation failed: ${commandText(added)}`);
    }
    return recordDeploymentRepairWorkspace(incident.id, worktreePath, branchName, incident.base_commit);
  }

  private initialRepairPrompt(incident: DeploymentRepairIncidentRow) {
    const provenance = this.commitProvenanceEvidence(incident);
    return [
      "[GOALS-ONLY] Repair the observed Concierge deployment failure as a standalone CLI outside managed sessions.",
      `The failed candidate was ${incident.failed_commit}; the healthy runtime remained at or was restored to ${incident.restored_commit}.`,
      `Failure evidence: ${incident.error || "no error text was recorded"}`,
      `Commit provenance evidence (authorship only; it does not establish causality): ${JSON.stringify(provenance)}`,
      "Operating profile: one operator on one personal server. Inspect retained source, journald and systemd evidence read-only; keep credentials and private dialogue out of output.",
      "Diagnose causality from the failure evidence and code. Use the originating task mappings only as context; deployment machinery has not selected or accused a culprit.",
      "Find the actual cause from retained evidence, make the smallest complete correction in this incident worktree, update current docs, fetch/rebase and commit the repair. Tejas forbids tests and reviews: do not run either, invoke other agents, bypass disabled entrypoints or replace their configuration. Production database inspection must be explicitly read-only; do not supply writable production state configuration to any child. Do not enroll a managed session, borrow an identity, deploy, push, reset state, restart services or managed providers, or modify unrelated projects. The external supervisor owns integration and the normal detached controller owns restart and health proof.",
      "The supervisor allows at most three CLI launches and thirty minutes from the first launch for this incident, across resumes and revisions. Return the required JSON outcome: repair_committed only for a concrete correction committed at the exact reported full SHA; otherwise blocked with the evidence, concrete blocker and next executable action. Do not make documentation-only or empty commits to disguise a blocked runtime correction. Do not claim activation from a commit. An immutable control/authority gap requires a blocked outcome, not repeated candidate retries.",
    ].join("\n\n");
  }

  private commitProvenanceEvidence(incident: DeploymentRepairIncidentRow) {
    const commits = this.services.command(
      ["git", "rev-list", "--reverse", `${incident.restored_commit}..${incident.failed_commit}`],
      { cwd: this.repositoryRoot },
    );
    if (commits.exitCode !== 0) {
      return [{ error: `Could not enumerate failed commit range: ${commandText(commits)}` }];
    }
    return commits.stdout.split("\n").map((commit) => commit.trim()).filter(Boolean).map((commit) => {
      const trailers = this.services.command(
        ["git", "show", "-s", "--format=%(trailers:key=Concierge-Provenance,valueonly)", commit],
        { cwd: this.repositoryRoot },
      );
      const tokens = trailers.exitCode === 0
        ? [...trailers.stdout.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)]
          .map((match) => match[0].toLowerCase())
        : [];
      return {
        commit,
        sources: [...new Set(tokens)].map((token) => getTurnCommitProvenance(token) || { token, mapping: "missing" }),
      };
    });
  }

  private async runRepair(incident: DeploymentRepairIncidentRow, prompt: string) {
    const prior = latestDeploymentRepairAgentRun(incident.id, "repair");
    const resumeSession = this.resumableSession(prior);
    return await this.runPersistedAgent(incident, prompt, resumeSession);
  }

  private resumableSession(prior: DeploymentRepairAgentRunRow | null) {
    if (!prior || prior.launch_state === "completed" || prior.launch_state === "parked") {
      return prior?.session_uuid || prior?.requested_session_uuid || null;
    }
    const childAlive = prior.child_pid != null && this.services.isAlive({
      pid: prior.child_pid,
      bootId: prior.child_boot_id || "",
      startTicks: prior.child_start_ticks || "",
    });
    if (childAlive) throw new Error(`Prior ${prior.kind} child ${prior.child_pid} is still alive; refusing a duplicate.`);
    if (prior.child_pid == null && !this.priorUnitQuiescent()) {
      throw new RepairAttemptIntegrityError(`Prior ${prior.kind} launch has no child identity and its unit is not proven empty.`);
    }
    if (!prior.session_uuid && !prior.requested_session_uuid) {
      parkDeploymentRepairAgentRun(prior.id, "Launch was intended but no Codex session UUID was durably bound.");
      parkDeploymentRepair(
        this.incidentId,
        `Ambiguous unbound ${prior.kind} launch; no second session was started.`,
        { noticeReason: `The ${prior.kind} agent launch was ambiguous, so no second session was started.` },
      );
      throw new Error(`Ambiguous unbound ${prior.kind} launch.`);
    }
    return prior.session_uuid || prior.requested_session_uuid;
  }

  private priorUnitQuiescent() {
    if (this.services.priorUnitQuiescent) return this.services.priorUnitQuiescent();
    const unit = `concierge-deployment-repair@${this.incidentId}.service`;
    const result = this.services.command(["systemctl", "show", unit, "--property=MainPID", "--property=ControlGroup"]);
    if (result.exitCode !== 0) return false;
    const properties = Object.fromEntries(result.stdout.trim().split("\n").map(line => line.split("=")));
    if (Number(properties.MainPID) !== this.supervisorIdentity.pid || !properties.ControlGroup?.startsWith("/")) return false;
    const root = join("/sys/fs/cgroup", properties.ControlGroup);
    const visit = (directory: string): number[] => {
      const pids = readFileSync(join(directory, "cgroup.procs"), "utf8").trim().split(/\s+/).filter(Boolean).map(Number);
      for (const child of readdirSync(directory, { withFileTypes: true })) {
        if (child.isDirectory()) pids.push(...visit(join(directory, child.name)));
      }
      return pids;
    };
    try { return visit(root).every(pid => pid === this.supervisorIdentity.pid); } catch { return false; }
  }

  private async runPersistedAgent(
    incident: DeploymentRepairIncidentRow,
    prompt: string,
    sessionUuid: string | null,
  ) {
    this.assertOwner();
    const budget = getDeploymentRepairBudget(incident.id);
    if (budget.attempts >= budget.maximumAttempts || !Number.isFinite(budget.deadlineMs) || budget.deadlineMs <= Date.now()) {
      throw new RepairAttemptStoppedError("Autonomous repair exhausted its three-launch or thirty-minute incident budget; operator help is required.");
    }
    const kind = "repair";
    const stamp = `${kind}-${randomUUID()}`;
    const outputPath = join(this.incidentRoot, `${stamp}.jsonl`);
    const finalMessagePath = join(this.incidentRoot, `${stamp}.final.json`);
    const agentRun = prepareDeploymentRepairAgentLaunch({
      incidentId: incident.id,
      kind,
      supervisorPid: this.supervisorIdentity.pid,
      supervisorBootId: this.supervisorIdentity.bootId,
      supervisorStartTicks: this.supervisorIdentity.startTicks,
      outputPath,
      requestedSessionUuid: sessionUuid,
      finalMessagePath,
    });
    let boundSession = sessionUuid;
    let exitCode: number;
    try { exitCode = await this.services.runAgent({
      kind,
      cwd: incident.worktree_path!,
      prompt,
      sessionUuid,
      outputPath,
      finalMessagePath,
      deadlineMs: budget.deadlineMs,
      onSpawn: (pid) => {
        this.assertOwner();
        recordDeploymentRepairChild(agentRun.id, processIdentity(pid));
      },
      onSession: (uuid) => {
        this.assertOwner();
        if (boundSession && boundSession !== uuid) throw new RepairAttemptIntegrityError("Codex resumed a different repair session UUID.");
        boundSession = uuid;
        bindDeploymentRepairSession(agentRun.id, uuid);
      },
    }); } catch (error) {
      if (error instanceof RepairAttemptIntegrityError || error instanceof RepairAttemptStoppedError) {
        parkDeploymentRepairAgentRun(agentRun.id, String(error));
      }
      throw error;
    }
    this.assertOwner();
    if (!boundSession) {
      parkDeploymentRepairAgentRun(agentRun.id, `${kind} exited without binding a Codex session UUID.`);
      parkDeploymentRepair(
        this.incidentId,
        `Ambiguous unbound ${kind} launch; no second session will be started.`,
        { noticeReason: `The ${kind} agent launch was ambiguous, so no second session will be started.` },
      );
      throw new Error(`${kind} did not bind a Codex session UUID.`);
    }
    if (exitCode !== 0) throw new Error(`${kind} Codex session ${boundSession} exited ${exitCode}; systemd will resume it.`);
    let result;
    try {
      if (!existsSync(finalMessagePath)) throw new RepairAttemptStoppedError("Repair exited without a final outcome; operator inspection is required.");
      result = parseRepairAgentResult(readFileSync(finalMessagePath, "utf8"));
    } catch (error) {
      parkDeploymentRepairAgentRun(agentRun.id, String(error));
      throw error;
    }
    completeDeploymentRepairAgentRun(agentRun.id, {
      session_uuid: boundSession, final_message_path: finalMessagePath, ...result,
    });
    if (result.status === "blocked") {
      throw new RepairAttemptStoppedError(`${result.summary} Blocker: ${result.blocker} Next action: ${result.next_action}`);
    }
    return result;
  }

  private cleanRepairCommit(incident: DeploymentRepairIncidentRow, reportedCommit: string, allowIntegratedBase = false) {
    this.assertOwner();
    const status = this.git(["status", "--porcelain", "--untracked-files=normal"], incident.worktree_path!);
    if (status) throw new RepairAttemptStoppedError("Repair reported a commit but left uncommitted work; operator inspection is required.");
    const head = this.git(["rev-parse", "HEAD"], incident.worktree_path!);
    if (head !== reportedCommit) throw new RepairAttemptStoppedError("Repair outcome does not match the worktree HEAD.");
    if (!allowIntegratedBase && head === incident.base_commit) throw new RepairAttemptStoppedError("Repair agent did not create a repair commit.");
    const ancestor = this.services.command(
      ["git", "merge-base", "--is-ancestor", incident.base_commit, head],
      { cwd: incident.worktree_path! },
    );
    if (ancestor.exitCode !== 0) throw new RepairAttemptStoppedError("Repair commit is not descended from its recorded base.");
    return head;
  }

  private discoverCommittedRepair(incident: DeploymentRepairIncidentRow) {
    const prior = latestDeploymentRepairAgentRun(incident.id, "repair");
    if (prior?.launch_state !== "completed" || !prior.result_json) return null;
    const result = parseRepairAgentResult(prior.result_json);
    if (result.status === "blocked") {
      throw new RepairAttemptStoppedError(`${result.summary} Blocker: ${result.blocker} Next action: ${result.next_action}`);
    }
    // A failed deployment already consumed this result; diagnosis must use the new failure.
    if (result.commit === incident.failed_commit) return null;
    return this.cleanRepairCommit(incident, result.commit!);
  }

  private integrateRepair(incident: DeploymentRepairIncidentRow): "pushed" | "origin_moved" {
    this.assertOwner();
    const fetched = this.services.command(["git", "fetch", "origin", "main"], { cwd: this.repositoryRoot });
    if (fetched.exitCode !== 0) throw new Error(`Could not refresh origin/main: ${commandText(fetched)}`);
    const originMain = this.git(["rev-parse", "origin/main"], this.repositoryRoot);
    const head = this.git(["rev-parse", "HEAD"], incident.worktree_path!);
    if (head !== incident.repair_commit) throw new RepairAttemptStoppedError("Committed repair tree changed before integration.");
    if (originMain === head) return "pushed";
    if (originMain !== incident.base_commit) return "origin_moved";
    const pushed = this.services.command(
      ["git", "push", "origin", `${head}:refs/heads/main`],
      { cwd: incident.worktree_path! },
    );
    if (pushed.exitCode !== 0) throw new Error(`Non-force repair integration failed: ${commandText(pushed)}`);
    return "pushed";
  }

  private git(args: string[], cwd: string) {
    const result = this.services.command(["git", ...args], { cwd });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${commandText(result)}`);
    return result.stdout.trim();
  }
}
