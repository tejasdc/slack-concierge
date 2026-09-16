import { spawn } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

export interface RepairAgentInput {
  kind: "repair";
  cwd: string;
  prompt: string;
  sessionUuid?: string | null;
  outputPath: string;
  finalMessagePath: string;
  deadlineMs: number;
  onSpawn(pid: number): void;
  onSession(sessionUuid: string): void;
}

export class RepairAttemptIntegrityError extends Error {}
export class RepairAttemptStoppedError extends Error {}

export interface RepairAgentResult {
  status: "repair_committed" | "blocked";
  commit: string | null;
  summary: string;
  blocker: string | null;
  next_action: string;
}

export function parseRepairAgentResult(text: string): RepairAgentResult {
  let result: any;
  try { result = JSON.parse(text); } catch {
    throw new RepairAttemptStoppedError("Repair returned no structured outcome; inspect its retained final message before any further attempt.");
  }
  if (!result || !["repair_committed", "blocked"].includes(result.status)
    || typeof result.summary !== "string" || !result.summary.trim()
    || typeof result.next_action !== "string" || !result.next_action.trim()
    || (result.status === "repair_committed" && (typeof result.commit !== "string"
      || !/^[0-9a-f]{40}$/i.test(result.commit) || result.blocker !== null))
    || (result.status === "blocked" && (result.commit !== null
      || typeof result.blocker !== "string" || !result.blocker.trim()))) {
    throw new RepairAttemptStoppedError("Repair returned an invalid outcome; inspect its retained final message before any further attempt.");
  }
  return result;
}

export function repairSessionFromEvent(line: string) {
  let event: any;
  try { event = JSON.parse(line); } catch { return null; }
  const uuid = event.thread_id || event.threadId || event.session_id || event.sessionId || event.thread?.id;
  return typeof uuid === "string" && /^[0-9a-f-]{30,50}$/i.test(uuid) ? uuid : null;
}

export async function runRepairAgent(input: RepairAgentInput, repositoryRoot: string): Promise<number> {
  if (input.kind !== "repair") throw new RepairAttemptStoppedError("Autonomous deployment reviews are prohibited by current human policy.");
  if (!Number.isFinite(input.deadlineMs) || input.deadlineMs <= Date.now()) {
    throw new RepairAttemptStoppedError("The autonomous repair time budget is exhausted; operator help is required.");
  }
  const executable = process.env.CONCIERGE_CODEX_BIN || "/root/.codex/packages/standalone/current/codex";
  // Keep the immutable artifact filename: the previous LKG's builder owns the first rollout.
  const schema = join(process.env.CONCIERGE_DEPLOYMENT_CONTROL_ROOT || join(repositoryRoot, "bot/scripts"),
    "deployment-repair-review.schema.json");
  const args = ["exec", ...(input.sessionUuid ? ["resume"] : []),
    "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--json",
    ...(!input.sessionUuid ? ["-C", input.cwd] : []),
    "--output-schema", schema,
    "-o", input.finalMessagePath, ...(input.sessionUuid ? [input.sessionUuid] : []), input.prompt];
  const output = openSync(input.outputPath, "a", 0o600);
  let failure: Error | null = null;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  const fail = (error: unknown) => {
    failure ||= error instanceof Error ? error : new Error(String(error));
    if (!child?.pid) return;
    const signal = (name: NodeJS.Signals) => {
      try { process.kill(-child!.pid!, name); } catch (error: any) {
        if (error.code !== "ESRCH") failure ||= error;
      }
    };
    signal("SIGTERM");
    killTimer ||= setTimeout(() => signal("SIGKILL"), 5000);
  };
  try {
    const environment: NodeJS.ProcessEnv = { ...process.env, HOME: "/root" };
    // Model children inspect production explicitly; source imports must not inherit its writable ledger.
    delete environment.CONCIERGE_STATE_DIR;
    delete environment.CONCIERGE_CAPTURE_STATE_DIR;
    // A repair CLI owns its own provider identity, never a managed caller's turn.
    for (const name of ["CODEX_THREAD_ID", "CODEX_SESSION_ID", "CONCIERGE_COMMIT_PROVENANCE",
      "CONCIERGE_SOURCE_INPUT_ID", "CONCIERGE_SOURCE_RUN_ID", "CONCIERGE_TURN_ID",
      "CONCIERGE_SESSION_ID", "CONCIERGE_TURN_KIND", "CONCIERGE_OWNER_INSTANCE_ID",
      "CONCIERGE_ACCEPTED_INPUT_ID", "CONCIERGE_SLACK_CHANNEL_ID", "CONCIERGE_SLACK_THREAD_TS"]) delete environment[name];
    child = spawn(executable, args, {
      cwd: input.cwd, env: environment,
      detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = new Promise<number>((resolve) => {
      child!.once("error", fail);
      child!.once("close", (code) => resolve(code ?? 1));
    });
    deadlineTimer = setTimeout(() => fail(new RepairAttemptStoppedError(
      "The autonomous repair time budget expired; only this repair process group was stopped. Operator help is required.",
    )), Math.max(1, input.deadlineMs - Date.now()));
    const stdout = createInterface({ input: child.stdout! });
    stdout.on("line", (line) => {
      try {
        writeSync(output, `${line}\n`);
        const session = repairSessionFromEvent(line);
        if (session && !failure) input.onSession(session);
      } catch (error) {
        fail(new RepairAttemptIntegrityError(`Repair output bookkeeping failed: ${String(error)}`));
      }
    });
    child.stdout!.on("error", fail);
    child.stderr!.on("error", fail);
    child.stderr!.on("data", (chunk) => {
      try { writeSync(output, chunk); } catch (error) { fail(error); }
    });
    try {
      if (child.pid) input.onSpawn(child.pid);
    } catch (error) {
      fail(new RepairAttemptIntegrityError(`Repair process bookkeeping failed: ${String(error)}`));
    }
    const code = await closed;
    stdout.close();
    if (failure) throw failure;
    return code;
  } finally {
    if (failure && child?.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch (error: any) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    clearTimeout(killTimer);
    clearTimeout(deadlineTimer);
    closeSync(output);
  }
}
