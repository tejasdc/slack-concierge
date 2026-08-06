import { spawn } from "node:child_process";
import { forkCodexSession, ProgressCb, runCodexTurn, RunResult } from "./codex";
import { ProviderId } from "./state";

export interface AgentProvider {
  id: ProviderId;
  run(input: {
    prompt: string;
    cwd: string;
    additionalDirs: string[];
    sessionUUID: string | null;
    onProgress?: ProgressCb;
    systemPrompt?: string;
  }): Promise<RunResult>;
  fork(input: {
    cwd: string;
    additionalDirs: string[];
    sessionUUID: string;
    atMessageIdx?: number;
  }): Promise<RunResult>;
}

class CodexProvider implements AgentProvider {
  id: ProviderId = "codex";

  run(input: Parameters<AgentProvider["run"]>[0]) {
    const prompt = input.systemPrompt ? `${input.systemPrompt}\n\n${input.prompt}` : input.prompt;
    return runCodexTurn({ ...input, prompt });
  }

  fork(input: Parameters<AgentProvider["fork"]>[0]) {
    const suffix = input.atMessageIdx == null ? "" : ` Fork from Slack message index ${input.atMessageIdx}.`;
    return forkCodexSession({ ...input, prompt: `Fork this session for Slack Concierge.${suffix}` });
  }
}

class ClaudeCodeProvider implements AgentProvider {
  id: ProviderId = "claude-code";

  async run(input: Parameters<AgentProvider["run"]>[0]): Promise<RunResult> {
    const args = [
      "--print",
      "--verbose",
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
      ...(input.sessionUUID ? ["--resume", input.sessionUUID] : []),
      input.systemPrompt ? `${input.systemPrompt}\n\n${input.prompt}` : input.prompt,
    ];
    const proc = spawn("claude", args, { cwd: input.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c: Buffer) => {
      stdout += c.toString();
      input.onProgress?.({ type: "narration" });
    });
    proc.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    return new Promise((resolve, reject) => {
      proc.on("close", (code) => {
        if (code !== 0 && !stdout.trim()) {
          reject(new Error(`claude-code exited ${code}: ${stderr.slice(0, 500)}`));
          return;
        }
        const sessionUUID = stdout.match(/"session_id"\s*:\s*"([^"]+)"/)?.[1] || input.sessionUUID;
        const parts = stdout
          .split("\n")
          .map((line) => {
            try {
              const ev = JSON.parse(line);
              return ev.type === "assistant" || ev.type === "result" ? ev.message?.content?.[0]?.text || ev.result || "" : "";
            } catch {
              return "";
            }
          })
          .filter(Boolean);
        resolve({ text: parts.join("\n\n").trim() || stdout.trim(), sessionUUID, toolsUsed: [] });
      });
      proc.on("error", reject);
    });
  }

  async fork(): Promise<RunResult> {
    throw new Error("claude-code fork is not wired yet; provider interface is in place for native --fork-session support.");
  }
}

export const providers: Record<ProviderId, AgentProvider> = {
  codex: new CodexProvider(),
  "claude-code": new ClaudeCodeProvider(),
};

export function providerFromText(text: string, fallback: ProviderId): ProviderId {
  if (/<@[^>]+>\s*claude-code/i.test(text) || /@claude-code/i.test(text)) return "claude-code";
  return fallback;
}
