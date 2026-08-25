import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import {
  bindDeploymentRepairSession,
  claimDeploymentRepair,
  completeDeploymentRepairAgentRun,
  completeDeploymentRepairIncident,
  getDeploymentRepairIncident,
  getDeploymentRun,
  latestDeploymentRepairAgentRun,
  parkDeploymentRepair,
  parkDeploymentRepairAgentRun,
  prepareDeploymentRepairAgentLaunch,
  prepareDeploymentRetry,
  recordDeploymentRepairChild,
  recordDeploymentRepairCommit,
  recordDeploymentRepairReview,
  recordDeploymentRepairWorkspace,
  type DeploymentRepairAgentRunRow,
  type DeploymentRepairIncidentRow,
} from "./deployment-state";
import { currentProcessIdentity, isProcessIdentityAlive, processIdentity } from "./runtime-identity";

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface DeploymentRepairServices {
  command(command: string[], options?: { cwd?: string; env?: Record<string, string> }): CommandResult;
  runAgent(input: {
    kind: "repair" | "review";
    cwd: string;
    prompt: string;
    sessionUuid?: string | null;
    outputPath: string;
    finalMessagePath: string;
    onSpawn(pid: number): void;
    onSession(sessionUuid: string): void;
  }): Promise<number>;
  isAlive(identity: { pid: number; bootId: string; startTicks: string }): boolean;
}

function commandText(result: CommandResult) {
  return (result.stderr || result.stdout).trim().slice(0, 4000);
}

function sessionUuidFromEvent(line: string) {
  try {
    const event = JSON.parse(line);
    const direct = event.thread_id || event.threadId || event.session_id || event.sessionId || event.thread?.id;
    if (typeof direct === "string" && /^[0-9a-f-]{30,50}$/i.test(direct)) return direct;
    if (["thread.started", "thread_started", "session.started"].includes(String(event.type || ""))) {
      const match = JSON.stringify(event).match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i);
      return match?.[0] || null;
    }
  } catch {}
  return null;
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
    async runAgent(input) {
      const codex = process.env.CONCIERGE_CODEX_BIN || "/root/.codex/packages/standalone/current/codex";
      const reviewSchema = join(repositoryRoot, "bot/scripts/deployment-repair-review.schema.json");
      const args = input.sessionUuid
        ? [
            "exec", "resume", "--dangerously-bypass-approvals-and-sandbox",
            "--dangerously-bypass-hook-trust", "--json", "-o", input.finalMessagePath,
            input.sessionUuid, input.prompt,
          ]
        : input.kind === "review"
          ? [
              "exec", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust",
              "--json", "-C", input.cwd, "--output-schema", reviewSchema,
              "-o", input.finalMessagePath, input.prompt,
            ]
          : [
              "exec", "--dangerously-bypass-approvals-and-sandbox",
              "--dangerously-bypass-hook-trust", "--json", "-C", input.cwd,
              "-o", input.finalMessagePath, input.prompt,
            ];
      const child = spawn(codex, args, {
        cwd: input.cwd,
        env: { ...process.env, HOME: "/root" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (!child.pid) throw new Error("Codex repair child did not expose a PID.");
      input.onSpawn(child.pid);
      const output = createWriteStream(input.outputPath, { flags: "a", mode: 0o600 });
      const stdout = createInterface({ input: child.stdout });
      stdout.on("line", (line) => {
        output.write(`${line}\n`);
        const sessionUuid = sessionUuidFromEvent(line);
        if (sessionUuid) input.onSession(sessionUuid);
      });
      child.stderr.on("data", (chunk) => output.write(chunk));
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
      });
      stdout.close();
      await new Promise<void>((resolve) => output.end(resolve));
      return exitCode;
    },
    isAlive: isProcessIdentityAlive,
  };
}

export class DeploymentRepairSupervisor {
  private readonly supervisorIdentity = currentProcessIdentity();
  private readonly incidentRoot: string;

  constructor(
    readonly incidentId: string,
    readonly repositoryRoot = process.env.CONCIERGE_REPO || "/root/workspace/slack-concierge",
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
    if (incident.status === "parked" || incident.status === "completed") return incident;
    mkdirSync(this.incidentRoot, { recursive: true, mode: 0o700 });
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
      incident = this.ensureWorktree(incident);

      if (!incident.repair_commit || incident.review_verdict === "NO_SHIP") {
        if (incident.review_verdict === "NO_SHIP" && incident.review_attempts >= 4) {
          const prior = incident.review_json ? JSON.parse(incident.review_json) : null;
          return parkDeploymentRepair(
            this.incidentId,
            `Fresh review still rejected the repair after four revisions: ${(prior?.blockers || []).join("; ")}`,
          );
        }
        if (!incident.repair_commit) {
          const committed = this.discoverCommittedRepair(incident);
          if (committed) {
            recordDeploymentRepairCommit(this.incidentId, committed);
            incident = getDeploymentRepairIncident(this.incidentId)!;
            continue;
          }
        }
        await this.runRepair(
          incident,
          incident.review_verdict === "NO_SHIP" ? this.correctionPrompt(incident) : this.initialRepairPrompt(incident),
        );
        incident = getDeploymentRepairIncident(this.incidentId)!;
        recordDeploymentRepairCommit(this.incidentId, this.cleanRepairCommit(incident));
        continue;
      }

      if (!incident.review_verdict) {
        const review = await this.runReview(incident);
        incident = recordDeploymentRepairReview(this.incidentId, review.verdict, review);
        if (review.verdict === "NO_SHIP" && incident.review_attempts >= 4) {
          return parkDeploymentRepair(
            this.incidentId,
            `Fresh review still rejected the repair after four revisions: ${review.blockers.join("; ")}`,
          );
        }
        continue;
      }

      const integration = this.integrateReviewedRepair(incident);
      if (integration === "origin_moved") {
        const newBase = this.git(["rev-parse", "origin/main"], this.repositoryRoot);
        incident = recordDeploymentRepairWorkspace(
          this.incidentId,
          incident.worktree_path!,
          incident.branch_name!,
          newBase,
        );
        await this.runRepair(
          incident,
          "[GOALS-ONLY] origin/main moved after review. Rebase the existing repair onto the new origin/main, preserve the deployment fix, run focused tests, and commit the reconciled repair. Do not deploy.",
        );
        incident = getDeploymentRepairIncident(this.incidentId)!;
        recordDeploymentRepairCommit(this.incidentId, this.cleanRepairCommit(incident));
        continue;
      }

      const retry = prepareDeploymentRetry(this.incidentId);
      const terminal = this.retryDeployment(incident, retry);
      if (terminal) return terminal;
      incident = getDeploymentRepairIncident(this.incidentId)!;
    }
  }

  private retryDeployment(incident: DeploymentRepairIncidentRow, retry: ReturnType<typeof getDeploymentRun>) {
    if (!retry) throw new Error("Deployment retry state disappeared before launch.");
    const deployed = this.services.command([join(this.repositoryRoot, "bot/scripts/deploy.sh")], {
      cwd: this.repositoryRoot,
      env: {
        CONCIERGE_DEPLOY_DETACHED: "1",
        CONCIERGE_DEPLOY_RUN_ID: retry.id,
        CONCIERGE_STATE_DIR: process.env.CONCIERGE_STATE_DIR || "/root/.local/state/concierge",
      },
    });
    const run = getDeploymentRun(retry.id);
    if (run?.status === "succeeded") return completeDeploymentRepairIncident(this.incidentId);
    if (run?.status === "releasing" && run.repair_state === "restored") return null;
    return parkDeploymentRepair(
      incident.id,
      `Deployment retry exited ${deployed.exitCode} in ${run?.status || "missing"}/${run?.repair_state || "no repair state"}: ${commandText(deployed)}`,
    );
  }

  private claim() {
    return claimDeploymentRepair({
      incidentId: this.incidentId,
      pid: this.supervisorIdentity.pid,
      bootId: this.supervisorIdentity.bootId,
      startTicks: this.supervisorIdentity.startTicks,
    });
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
    return [
      "[GOALS-ONLY] Repair the failed Slack Concierge deployment autonomously.",
      `The failed candidate was ${incident.failed_commit}; the healthy runtime was restored to ${incident.restored_commit}.`,
      `Failure evidence: ${incident.error || "no error text was recorded"}`,
      "You are trusted root on this personal server with unrestricted host access. You may inspect journald, systemd, /root, credentials, and every workspace.",
      "Find the actual cause, make the smallest complete correction in this incident worktree, run focused tests, and commit the repair. Do not deploy, push, reset state, restart the shared Codex App Server, or modify unrelated projects.",
    ].join("\n\n");
  }

  private correctionPrompt(incident: DeploymentRepairIncidentRow) {
    const review = incident.review_json ? JSON.parse(incident.review_json) : null;
    return [
      "[GOALS-ONLY] Continue the same deployment repair session and correct the current committed repair.",
      review ? `Fresh review evidence: ${JSON.stringify(review)}` : `The deployment failed again: ${incident.error}`,
      "Inspect current host evidence, make the smallest complete correction, run focused tests, and commit it. Do not deploy or push.",
    ].join("\n\n");
  }

  private async runRepair(incident: DeploymentRepairIncidentRow, prompt: string) {
    const prior = latestDeploymentRepairAgentRun(incident.id, "repair");
    const resumeSession = this.resumableSession(prior);
    return await this.runPersistedAgent("repair", incident, prompt, resumeSession);
  }

  private async runReview(incident: DeploymentRepairIncidentRow) {
    const prior = latestDeploymentRepairAgentRun(incident.id, "review");
    const resumeSession = prior && !["completed", "parked"].includes(prior.launch_state)
      ? this.resumableSession(prior)
      : null;
    const resultPath = join(this.incidentRoot, `review-${Date.now()}.json`);
    await this.runPersistedAgent(
      "review",
      incident,
      [
        "[GOALS-ONLY] Independently review the actual committed deployment-repair diff against its base.",
        `Reviewed base: ${incident.base_commit}. Repair commit: ${incident.repair_commit}.`,
        "Operating profile: one trusted operator on one personal root-access server. Security isolation between the operator's own agents is explicitly out of scope.",
        "Acceptance: the repair must fix the observed deployment failure without weakening durable batching, last-known-good rollback, health/runtime proof, exact wakes, or the shared App Server restart boundary.",
        "Return SHIP only if the committed diff is safe and sufficient now. Return NO_SHIP with only concrete blockers and the smallest correction; hypothetical scale and future hardening are non-blocking.",
      ].join("\n\n"),
      resumeSession,
      resultPath,
    );
    const parsed = JSON.parse(readFileSync(resultPath, "utf8"));
    if (!["SHIP", "NO_SHIP"].includes(parsed.verdict) || !Array.isArray(parsed.blockers)) {
      throw new Error("Fresh repair review did not return the required structured verdict.");
    }
    return parsed as { verdict: "SHIP" | "NO_SHIP"; summary: string; blockers: string[] };
  }

  private resumableSession(prior: DeploymentRepairAgentRunRow | null) {
    if (!prior || prior.launch_state === "completed" || prior.launch_state === "parked") {
      return prior?.session_uuid || null;
    }
    const childAlive = prior.child_pid != null && this.services.isAlive({
      pid: prior.child_pid,
      bootId: prior.child_boot_id || "",
      startTicks: prior.child_start_ticks || "",
    });
    if (childAlive) throw new Error(`Prior ${prior.kind} child ${prior.child_pid} is still alive; refusing a duplicate.`);
    if (!prior.session_uuid) {
      parkDeploymentRepairAgentRun(prior.id, "Launch was intended but no Codex session UUID was durably bound.");
      parkDeploymentRepair(this.incidentId, `Ambiguous unbound ${prior.kind} launch; no second session was started.`);
      throw new Error(`Ambiguous unbound ${prior.kind} launch.`);
    }
    return prior.session_uuid;
  }

  private async runPersistedAgent(
    kind: "repair" | "review",
    incident: DeploymentRepairIncidentRow,
    prompt: string,
    sessionUuid: string | null,
    explicitFinalPath?: string,
  ) {
    const stamp = `${kind}-${Date.now()}`;
    const outputPath = join(this.incidentRoot, `${stamp}.jsonl`);
    const finalMessagePath = explicitFinalPath || join(this.incidentRoot, `${stamp}.final.txt`);
    const agentRun = prepareDeploymentRepairAgentLaunch({
      incidentId: incident.id,
      kind,
      supervisorPid: this.supervisorIdentity.pid,
      supervisorBootId: this.supervisorIdentity.bootId,
      supervisorStartTicks: this.supervisorIdentity.startTicks,
      outputPath,
    });
    let boundSession = sessionUuid;
    let sessionBindingError: Error | null = null;
    if (sessionUuid) bindDeploymentRepairSession(agentRun.id, sessionUuid);
    const exitCode = await this.services.runAgent({
      kind,
      cwd: incident.worktree_path!,
      prompt,
      sessionUuid,
      outputPath,
      finalMessagePath,
      onSpawn: (pid) => recordDeploymentRepairChild(agentRun.id, processIdentity(pid)),
      onSession: (uuid) => {
        try {
          if (boundSession && boundSession !== uuid) throw new Error("Codex resumed a different repair session UUID.");
          boundSession = uuid;
          bindDeploymentRepairSession(agentRun.id, uuid);
        } catch (error) {
          sessionBindingError = error instanceof Error ? error : new Error(String(error));
        }
      },
    });
    if (sessionBindingError) throw sessionBindingError;
    if (!boundSession) {
      parkDeploymentRepairAgentRun(agentRun.id, `${kind} exited without binding a Codex session UUID.`);
      parkDeploymentRepair(this.incidentId, `Ambiguous unbound ${kind} launch; no second session will be started.`);
      throw new Error(`${kind} did not bind a Codex session UUID.`);
    }
    if (exitCode !== 0) throw new Error(`${kind} Codex session ${boundSession} exited ${exitCode}; systemd will resume it.`);
    completeDeploymentRepairAgentRun(agentRun.id, { session_uuid: boundSession, final_message_path: finalMessagePath });
    return boundSession;
  }

  private cleanRepairCommit(incident: DeploymentRepairIncidentRow) {
    const status = this.git(["status", "--porcelain", "--untracked-files=normal"], incident.worktree_path!);
    if (status) throw new Error("Repair agent stopped with uncommitted work; the same session must finish and commit it.");
    const head = this.git(["rev-parse", "HEAD"], incident.worktree_path!);
    if (head === incident.base_commit) throw new Error("Repair agent did not create a repair commit.");
    const ancestor = this.services.command(
      ["git", "merge-base", "--is-ancestor", incident.base_commit, head],
      { cwd: incident.worktree_path! },
    );
    if (ancestor.exitCode !== 0) throw new Error("Repair commit is not descended from the reviewed base.");
    return head;
  }

  private discoverCommittedRepair(incident: DeploymentRepairIncidentRow) {
    const status = this.git(["status", "--porcelain", "--untracked-files=normal"], incident.worktree_path!);
    if (status) return null;
    const head = this.git(["rev-parse", "HEAD"], incident.worktree_path!);
    if (head === incident.base_commit) return null;
    const ancestor = this.services.command(
      ["git", "merge-base", "--is-ancestor", incident.base_commit, head],
      { cwd: incident.worktree_path! },
    );
    return ancestor.exitCode === 0 ? head : null;
  }

  private integrateReviewedRepair(incident: DeploymentRepairIncidentRow): "pushed" | "origin_moved" {
    const fetched = this.services.command(["git", "fetch", "origin", "main"], { cwd: this.repositoryRoot });
    if (fetched.exitCode !== 0) throw new Error(`Could not refresh origin/main: ${commandText(fetched)}`);
    const originMain = this.git(["rev-parse", "origin/main"], this.repositoryRoot);
    const head = this.git(["rev-parse", "HEAD"], incident.worktree_path!);
    if (head !== incident.repair_commit) throw new Error("Reviewed repair tree changed before integration.");
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
