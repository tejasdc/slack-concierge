import { spawn } from "node:child_process";
import { log } from "./log";
import { ProgressCb, RunResult } from "./codex";

type JsonValue = Record<string, any>;

export interface ClaudeCodeTransport {
  run(input: {
    args: string[];
    cwd: string;
    onStdout: (chunk: string) => void;
    onStderr: (chunk: string) => void;
  }): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export class SubprocessClaudeCodeTransport implements ClaudeCodeTransport {
  run(input: {
    args: string[];
    cwd: string;
    onStdout: (chunk: string) => void;
    onStderr: (chunk: string) => void;
  }): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    const proc = spawn("claude", input.args, {
      cwd: input.cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout.on("data", (chunk: Buffer) => input.onStdout(chunk.toString()));
    proc.stderr.on("data", (chunk: Buffer) => input.onStderr(chunk.toString()));

    return new Promise((resolve, reject) => {
      proc.on("close", (code, signal) => resolve({ code, signal }));
      proc.on("error", reject);
    });
  }
}

export interface ClaudeCodeParseResult {
  text: string;
  sessionUUID: string | null;
  toolsUsed: string[];
  isError: boolean;
}

export function parseClaudeCodeOutput(stdout: string, fallbackSessionUUID: string | null = null): ClaudeCodeParseResult {
  const events = parseClaudeEvents(stdout);
  let sessionUUID = fallbackSessionUUID;
  let finalResult = "";
  let isError = false;
  const messageParts: string[] = [];
  const toolsUsed: string[] = [];

  for (const ev of events) {
    if (typeof ev.session_id === "string") sessionUUID = ev.session_id;
    if (ev.type === "system" && ev.subtype === "init" && typeof ev.session_id === "string") {
      sessionUUID = ev.session_id;
    }
    if (ev.type === "result") {
      if (typeof ev.session_id === "string") sessionUUID = ev.session_id;
      if (typeof ev.result === "string") finalResult = ev.result;
      if (ev.is_error === true) isError = true;
    }
    if (ev.type !== "assistant") continue;
    const content = Array.isArray(ev.message?.content) ? ev.message.content : [];
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") {
        messageParts.push(block.text);
      } else if (block?.type === "tool_use") {
        toolsUsed.push(String(block.name || "tool"));
      }
    }
  }

  const text = messageParts.join("\n\n").trim() || finalResult.trim() || stdout.trim();
  if (events.length === 0 && stdout.trim()) {
    sessionUUID = sessionUUID || extractUuid(stdout);
  }
  return { text, sessionUUID, toolsUsed, isError };
}

function parseClaudeEvents(stdout: string): JsonValue[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  const whole = parseJson(trimmed);
  if (Array.isArray(whole)) return whole.filter(isRecord);
  if (isRecord(whole)) return [whole];

  const events: JsonValue[] = [];
  for (const line of stdout.split("\n")) {
    const parsed = parseJson(line.trim());
    if (isRecord(parsed)) events.push(parsed);
  }
  return events;
}

function parseJson(input: string): unknown {
  if (!input) return null;
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is JsonValue {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function extractUuid(text: string) {
  return text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] || null;
}

export function claudeCodeArgs(input: {
  prompt: string;
  additionalDirs: string[];
  sessionUUID: string | null;
  forkSession?: boolean;
}) {
  const args = [
    "--print",
    "--verbose",
    "--output-format",
    "stream-json",
    ...(input.sessionUUID ? ["--resume", input.sessionUUID] : []),
    ...(input.forkSession ? ["--fork-session"] : []),
    input.prompt,
  ];

  // Claude variadic flags consume following positional args, so keep them after the prompt.
  for (const dir of input.additionalDirs) args.push("--add-dir", dir);
  return args;
}

export async function runClaudeCodeTurn(input: {
  prompt: string;
  cwd: string;
  additionalDirs: string[];
  sessionUUID: string | null;
  forkSession?: boolean;
  onProgress?: ProgressCb;
  transport?: ClaudeCodeTransport;
}): Promise<RunResult> {
  const transport = input.transport || new SubprocessClaudeCodeTransport();
  const args = claudeCodeArgs(input);
  let stdout = "";
  let stderr = "";
  let reportedToolCount = 0;

  log("info", "claude_code_turn_started", {
    cwd: input.cwd,
    resume: !!input.sessionUUID,
    additional_dir_count: input.additionalDirs.length,
  });
  input.onProgress?.({ type: "started" });

  const outcome = await transport.run({
    args,
    cwd: input.cwd,
    onStdout: (chunk) => {
      stdout += chunk;
      const parsed = parseClaudeCodeOutput(stdout, input.sessionUUID);
      for (const tool of parsed.toolsUsed.slice(reportedToolCount)) {
        input.onProgress?.({ type: "tool_use", toolName: tool });
      }
      reportedToolCount = parsed.toolsUsed.length;
      if (parsed.text) input.onProgress?.({ type: "narration", text: parsed.text });
    },
    onStderr: (chunk) => {
      stderr += chunk;
    },
  });

  const parsed = parseClaudeCodeOutput(stdout, input.sessionUUID);
  log("info", "claude_code_turn_finished", {
    code: outcome.code,
    signal: outcome.signal,
    session_uuid: parsed.sessionUUID,
    tool_count: parsed.toolsUsed.length,
    is_error: parsed.isError,
  });

  if ((outcome.code !== 0 || parsed.isError) && !parsed.text) {
    throw new Error(`claude-code exited ${outcome.code}: ${stderr.slice(0, 800) || "(no stderr)"}`);
  }
  if (parsed.isError) throw new Error(parsed.text || stderr.slice(0, 800) || "claude-code returned an error");
  input.onProgress?.({ type: "done", text: parsed.text });

  return {
    text: parsed.text || "(agent completed without a text reply)",
    sessionUUID: parsed.sessionUUID,
    toolsUsed: parsed.toolsUsed,
  };
}

export async function forkClaudeCodeSession(input: {
  sessionUUID: string;
  cwd: string;
  additionalDirs: string[];
  prompt?: string;
  transport?: ClaudeCodeTransport;
}): Promise<RunResult> {
  const result = await runClaudeCodeTurn({
    cwd: input.cwd,
    additionalDirs: input.additionalDirs,
    sessionUUID: input.sessionUUID,
    forkSession: true,
    prompt: input.prompt || "Fork this Claude Code session for Slack Concierge. Reply with a short confirmation.",
    transport: input.transport,
  });
  if (!result.sessionUUID || result.sessionUUID === input.sessionUUID) {
    throw new Error("claude-code fork did not return a new session id");
  }
  return result;
}
