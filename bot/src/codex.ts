import { spawn } from "node:child_process";

type ProgressCb = (event: {
  type: "started" | "narration" | "tool_use" | "done";
  text?: string;
  toolName?: string;
}) => void;

export interface RunResult {
  text: string;
  sessionUUID: string | null;
  toolsUsed: string[];
}

// Real codex `exec --json` event shape (verified 2026-08-06):
//   {"type":"thread.started","thread_id":"<uuid>"}
//   {"type":"turn.started"}
//   {"type":"item.started","item":{"id":"...","type":"command_execution",...}}
//   {"type":"item.completed","item":{"id":"...","type":"agent_message","text":"..."}}
//   {"type":"item.completed","item":{"id":"...","type":"command_execution","command":"...","exit_code":0,"status":"completed",...}}
//   {"type":"turn.completed","usage":{...}}
//
// A single turn can emit multiple agent_message items (narration + final answer);
// we concatenate them in order for the Slack post.
//
// Resume: `codex exec resume <UUID> [PROMPT]` — does NOT accept `-C`, so we
// run resume from the intended cwd via child_process cwd option.
export async function runCodexTurn(input: {
  prompt: string;
  cwd: string;
  sessionUUID: string | null;
  onProgress?: ProgressCb;
}): Promise<RunResult> {
  const { prompt, cwd, sessionUUID, onProgress } = input;

  const CMD = "codex";
  // Common flags: --json, --skip-git-repo-check, sandbox bypass.
  // For a fresh session we also pass -C <cwd> (extra defence against wrong cwd);
  // for resume we omit -C because the resume subcommand rejects it.
  const commonFlags = [
    "--json",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
  ];
  const args: string[] = sessionUUID
    ? ["exec", "resume", sessionUUID, ...commonFlags, prompt]
    : ["exec", ...commonFlags, "-C", cwd, prompt];

  const proc = spawn(CMD, args, {
    cwd,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdoutBuf = "";
  let stderr = "";
  const toolsUsed: string[] = [];
  let extractedUUID: string | null = null;
  const messageParts: string[] = [];
  let sawTurnComplete = false;

  proc.stdout.on("data", (chunk: Buffer) => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split("\n");
    stdoutBuf = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev: any;
      try { ev = JSON.parse(line); } catch { continue; }

      const t = ev.type;
      switch (t) {
        case "thread.started":
          if (ev.thread_id && !extractedUUID) extractedUUID = ev.thread_id;
          break;
        case "turn.started":
          onProgress?.({ type: "started", text: "" });
          break;
        case "item.started": {
          const item = ev.item || {};
          if (item.type === "command_execution") {
            const name = String(item.command || "").split(/\s+/)[0] || "cmd";
            onProgress?.({ type: "tool_use", toolName: name });
          }
          break;
        }
        case "item.completed": {
          const item = ev.item || {};
          if (item.type === "agent_message" && typeof item.text === "string") {
            messageParts.push(item.text);
            onProgress?.({ type: "narration", text: item.text });
          } else if (item.type === "command_execution") {
            const name = String(item.command || "").split(/\s+/)[0] || "cmd";
            toolsUsed.push(name);
          } else if (item.type) {
            // reasoning / other item types — count as tool activity so progress
            // reflects that something happened, but don't include in text.
            toolsUsed.push(item.type);
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
  proc.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });

  return new Promise((resolve, reject) => {
    proc.on("close", (code) => {
      const text = messageParts.join("\n\n").trim();
      if (code !== 0 && !text) {
        reject(new Error(`codex exited ${code}: ${stderr.slice(0, 400) || "(no stderr)"}`));
        return;
      }
      resolve({
        text: text || (sawTurnComplete ? "(agent completed without a text reply)" : "(no assistant text captured)"),
        sessionUUID: extractedUUID,
        toolsUsed,
      });
    });
    proc.on("error", (err) => reject(err));
  });
}
