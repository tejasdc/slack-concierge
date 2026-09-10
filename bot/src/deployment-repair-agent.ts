import { spawn } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

export interface RepairAgentInput {
  kind: "repair" | "review";
  cwd: string;
  prompt: string;
  sessionUuid?: string | null;
  outputPath: string;
  finalMessagePath: string;
  onSpawn(pid: number): void;
  onSession(sessionUuid: string): void;
}

export class RepairAttemptIntegrityError extends Error {}

export function repairSessionFromEvent(line: string) {
  let event: any;
  try { event = JSON.parse(line); } catch { return null; }
  const uuid = event.thread_id || event.threadId || event.session_id || event.sessionId || event.thread?.id;
  return typeof uuid === "string" && /^[0-9a-f-]{30,50}$/i.test(uuid) ? uuid : null;
}

export async function runRepairAgent(input: RepairAgentInput, repositoryRoot: string): Promise<number> {
  const executable = process.env.CONCIERGE_CODEX_BIN || "/root/.codex/packages/standalone/current/codex";
  const schema = join(process.env.CONCIERGE_DEPLOYMENT_CONTROL_ROOT || join(repositoryRoot, "bot/scripts"),
    "deployment-repair-review.schema.json");
  const args = ["exec", ...(input.sessionUuid ? ["resume"] : []),
    "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--json",
    ...(!input.sessionUuid ? ["-C", input.cwd] : []),
    ...(input.kind === "review" ? ["--output-schema", schema] : []),
    "-o", input.finalMessagePath, ...(input.sessionUuid ? [input.sessionUuid] : []), input.prompt];
  const output = openSync(input.outputPath, "a", 0o600);
  let failure: Error | null = null;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
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
    child = spawn(executable, args, {
      cwd: input.cwd, env: { ...process.env, HOME: "/root" },
      detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = new Promise<number>((resolve) => {
      child!.once("error", fail);
      child!.once("close", (code) => resolve(code ?? 1));
    });
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
    closeSync(output);
  }
}
