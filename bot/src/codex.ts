import { spawn } from "node:child_process";

export type ProgressCb = (event: {
  type: "started" | "narration" | "tool_use" | "done";
  text?: string;
  toolName?: string;
}) => void;

export interface RunResult {
  text: string;
  sessionUUID: string | null;
  toolsUsed: string[];
}

function toolNameFromItem(item: any): string | null {
  if (item.type === "command_execution") {
    return String(item.command || "").split(/\s+/)[0] || "cmd";
  }
  if (["collab_tool_call", "dynamic_tool_call", "mcp_tool_call", "web_search", "file_change"].includes(item.type)) {
    return String(item.tool || item.name || item.type);
  }
  return null;
}

function resumeExecFlags() {
  return [
    "--json",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
  ];
}

function freshExecFlags(additionalDirs: string[]) {
  return [
    ...resumeExecFlags(),
    ...additionalDirs.flatMap((dir) => ["--add-dir", dir]),
  ];
}

export function codexExecArgs(input: {
  prompt: string;
  cwd: string;
  additionalDirs: string[];
  sessionUUID: string | null;
}): string[] {
  const { prompt, cwd, additionalDirs, sessionUUID } = input;
  return sessionUUID
    ? ["exec", "resume", ...resumeExecFlags(), sessionUUID, prompt]
    : ["exec", ...freshExecFlags(additionalDirs), "-C", cwd, prompt];
}

export async function runCodexTurn(input: {
  prompt: string;
  cwd: string;
  additionalDirs: string[];
  sessionUUID: string | null;
  onProgress?: ProgressCb;
}): Promise<RunResult> {
  const { prompt, cwd, onProgress, sessionUUID } = input;
  const args = codexExecArgs(input);

  const proc = spawn("codex", args, {
    cwd,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdoutBuf = "";
  let stderr = "";
  const toolsUsed: string[] = [];
  let extractedUUID: string | null = sessionUUID;
  const messageParts: string[] = [];
  const progressedToolItemIds = new Set<string>();
  let sawTurnComplete = false;

  const reportToolProgress = (item: any, phase: "started" | "completed") => {
    const toolName = toolNameFromItem(item);
    if (!toolName) return;
    const itemId = typeof item.id === "string" ? item.id : null;
    if (itemId) {
      if (progressedToolItemIds.has(itemId)) return;
      progressedToolItemIds.add(itemId);
    } else if (phase === "completed" && item.type !== "file_change") {
      return;
    }
    onProgress?.({ type: "tool_use", toolName });
  };

  proc.stdout.on("data", (chunk: Buffer) => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split("\n");
    stdoutBuf = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }

      switch (ev.type) {
        case "thread.started":
          if (ev.thread_id) extractedUUID = ev.thread_id;
          break;
        case "turn.started":
          onProgress?.({ type: "started" });
          break;
        case "item.started": {
          const item = ev.item || {};
          reportToolProgress(item, "started");
          break;
        }
        case "item.completed": {
          const item = ev.item || {};
          reportToolProgress(item, "completed");
          if (item.type === "agent_message" && typeof item.text === "string") {
            messageParts.push(item.text);
            onProgress?.({ type: "narration", text: item.text });
          } else {
            const toolName = toolNameFromItem(item);
            if (toolName) toolsUsed.push(toolName);
          }
          break;
        }
        case "turn.completed":
          sawTurnComplete = true;
          onProgress?.({ type: "done", text: messageParts.join("\n\n") });
          break;
      }
    }
  });
  proc.stderr.on("data", (c: Buffer) => {
    stderr += c.toString();
  });

  return new Promise((resolve, reject) => {
    proc.on("close", (code) => {
      const text = messageParts.join("\n\n").trim();
      if (code !== 0 && !text) {
        reject(new Error(`codex exited ${code}: ${stderr.slice(0, 800) || "(no stderr)"}`));
        return;
      }
      resolve({
        text: text || (sawTurnComplete ? "(agent completed without a text reply)" : "(no assistant text captured)"),
        sessionUUID: extractedUUID,
        toolsUsed,
      });
    });
    proc.on("error", reject);
  });
}

export async function forkCodexSession(input: {
  sessionUUID: string;
  cwd: string;
  additionalDirs: string[];
  prompt?: string;
}): Promise<RunResult> {
  const flags = freshExecFlags(input.additionalDirs);
  const prompt = input.prompt || "Fork this session for Slack Concierge. Reply with a short confirmation.";

  try {
    return await runForkCommand(["exec", "fork", input.sessionUUID, ...flags, "-C", input.cwd, prompt], input.cwd, input.sessionUUID);
  } catch (err) {
    return await runForkCommand(
      ["fork", input.sessionUUID, ...input.additionalDirs.flatMap((dir) => ["--add-dir", dir]), "-C", input.cwd, prompt],
      input.cwd,
      input.sessionUUID,
      err,
    );
  }
}

function runForkCommand(args: string[], cwd: string, originalUUID: string, previousErr?: unknown): Promise<RunResult> {
  const proc = spawn("codex", args, {
    cwd,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (c: Buffer) => {
    stdout += c.toString();
  });
  proc.stderr.on("data", (c: Buffer) => {
    stderr += c.toString();
  });

  const timer = setTimeout(() => proc.kill("SIGTERM"), 30_000);
  return new Promise((resolve, reject) => {
    proc.on("close", (code) => {
      clearTimeout(timer);
      const uuid = stdout.match(/"thread_id"\s*:\s*"([^"]+)"/)?.[1] || stdout.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i)?.[0] || null;
      if (code === 0 && uuid && uuid !== originalUUID) {
        resolve({ text: "Fork created.", sessionUUID: uuid, toolsUsed: [] });
        return;
      }
      const prior = previousErr instanceof Error ? ` Previous attempt: ${previousErr.message}` : "";
      reject(new Error(`codex fork did not return a new session id.${prior} stderr=${stderr.slice(0, 500)} stdout=${stdout.slice(0, 500)}`));
    });
    proc.on("error", reject);
  });
}
