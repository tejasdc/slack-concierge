import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  CodexAppServerClientError,
  sharedCodexAppServerClient,
  type CodexAppServerClientLike,
} from "./codex-app-server-client";
import { errorFields, log } from "./log";
import { ProviderDispatchError, ProviderTurnCancelledError } from "./provider-failures";
import { SteeringNotSentError, SteeringSender } from "./steering";

export type ProgressEvent =
  | { type: "started" }
  | { type: "narration"; text?: string }
  | { type: "commentary"; text: string }
  | {
      type: "activity";
      itemId: string;
      title: string;
      details?: string;
      status: "in_progress" | "complete" | "error";
    }
  | {
      type: "plan";
      planTitle?: string;
      title: string;
      details?: string;
      status: "pending" | "in_progress" | "complete" | "error";
    }
  | { type: "compaction" }
  | { type: "steering"; clientMessageId: string }
  | { type: "tool_use"; toolName?: string; itemId?: string }
  | { type: "done"; text?: string };

export type ProgressCb = (event: ProgressEvent) => void;

export interface RunResult {
  text: string;
  sessionUUID: string | null;
  toolsUsed: string[];
  providerTurnId?: string | null;
  durationMs?: number;
}

export function codexTurnDurationMs(turn: {
  durationMs?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
}): number | undefined {
  if (typeof turn.durationMs === "number" && Number.isSafeInteger(turn.durationMs) && turn.durationMs >= 0) {
    return turn.durationMs;
  }
  if (typeof turn.startedAt !== "number" || !Number.isSafeInteger(turn.startedAt) || turn.startedAt < 0
    || typeof turn.completedAt !== "number" || !Number.isSafeInteger(turn.completedAt)
    || turn.completedAt < turn.startedAt) return undefined;
  const durationMs = (turn.completedAt - turn.startedAt) * 1_000;
  return Number.isSafeInteger(durationMs) ? durationMs : undefined;
}

export class CodexControlRequestError extends Error {
  constructor(
    message: string,
    readonly outcome: "rejected" | "ambiguous",
  ) {
    super(message);
    this.name = "CodexControlRequestError";
  }
}

function toolNameFromItem(item: any): string | null {
  if (["command_execution", "commandExecution"].includes(item.type)) {
    return String(item.command || "").split(/\s+/)[0] || "cmd";
  }
  if ([
    "collab_tool_call", "collabAgentToolCall",
    "dynamic_tool_call", "dynamicToolCall",
    "mcp_tool_call", "mcpToolCall",
    "web_search", "webSearch",
    "file_change", "fileChange",
  ].includes(item.type)) {
    return String(item.tool?.type || item.tool || item.name || item.type);
  }
  return null;
}

function safeActivityLabel(value: unknown, fallback: string) {
  const normalized = String(value || "")
    .replace(/[^a-zA-Z0-9_. -]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return (normalized || fallback).slice(0, 80);
}

function safeCommandExecutable(command: unknown) {
  const source = Array.isArray(command) ? command[0] : command;
  const firstToken = String(source || "").trim().split(/\s+/)[0] || "command";
  if (firstToken.includes("=")) return "command";
  const basename = firstToken.split(/[\\/]/).at(-1) || "command";
  return safeActivityLabel(basename, "command");
}

export function codexProgressActivity(item: any): { itemId: string; title: string; details?: string } | null {
  const itemId = typeof item?.id === "string" ? item.id : null;
  if (!itemId) return null;
  const type = String(item.type || "");
  if (type === "reasoning") {
    return { itemId, title: "Thinking" };
  }
  if (["contextCompaction", "context_compaction"].includes(type)) {
    return { itemId, title: "Compacting context" };
  }
  if (["command_execution", "commandExecution"].includes(type)) {
    const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
    const filesOnly = actions.every((action: any) => ["read", "listFiles", "search"].includes(action?.type));
    const labels: string[] = [...new Set<string>(actions.map((action: any) => {
      if (action?.type === "read") return "Reading files";
      if (action?.type === "listFiles") return "Listing files";
      if (action?.type === "search") return "Searching files";
      return `Running ${safeCommandExecutable(action?.command || item.command)}`;
    }))];
    const title = actions.length > 1
      ? filesOnly ? "Inspecting files" : "Running commands"
      : labels[0] || `Running ${safeCommandExecutable(item.command)}`;
    return { itemId, title, ...(!filesOnly && actions.length > 1 ? { details: labels.join("\n") } : {}) };
  }
  if (["file_change", "fileChange"].includes(type)) {
    const count = Array.isArray(item.changes) ? item.changes.length : 1;
    return { itemId, title: `Editing ${count} ${count === 1 ? "file" : "files"}` };
  }
  if (["mcp_tool_call", "mcpToolCall", "dynamic_tool_call", "dynamicToolCall"].includes(type)) {
    return {
      itemId,
      title: `Using ${safeActivityLabel(item.tool?.name || item.tool || item.name, "tool")}`,
    };
  }
  if (["web_search", "webSearch"].includes(type)) {
    return { itemId, title: item.action?.type === "openPage" ? "Reading a web page"
      : item.action?.type === "findInPage" ? "Searching a web page" : "Searching the web" };
  }
  if (["collab_tool_call", "collabAgentToolCall", "subAgentActivity"].includes(type)) {
    return { itemId, title: "Working with a sub-agent" };
  }
  if (type === "sleep") return { itemId, title: "Waiting" };
  if (["enteredReviewMode", "exitedReviewMode"].includes(type)) return { itemId, title: "Reviewing changes" };
  if (["image_generation", "imageGeneration", "image_view", "imageView"].includes(type)) {
    return { itemId, title: type.includes("generation") || type.includes("Generation") ? "Generating image" : "Inspecting image" };
  }
  return null;
}

export function codexPlanProgress(plan: any): Extract<ProgressEvent, { type: "plan" }> | null {
  const steps = Array.isArray(plan?.steps) ? plan.steps : Array.isArray(plan) ? plan : [];
  if (steps.length === 0) return null;
  const normalized = steps.map((step: any) => ({
    step: String(step?.step || step?.title || "Step").replace(/\s+/g, " ").trim(),
    status: String(step?.status || "pending").replaceAll("inProgress", "in_progress"),
  }));
  const currentIndex = normalized.findIndex((step) => step.status === "in_progress");
  const pendingIndex = normalized.findIndex((step) => step.status === "pending");
  const selectedIndex = currentIndex >= 0 ? currentIndex : pendingIndex;
  const details = normalized.map((step) => `${["complete", "completed"].includes(step.status) ? "✓" : step.status === "in_progress" ? "→" : "○"} ${step.step}`).join("\n");
  if (selectedIndex < 0) {
    return {
      type: "plan",
      planTitle: String(plan?.explanation || "Plan"),
      title: `${normalized.length}/${normalized.length} steps complete`,
      status: "complete",
      details,
    };
  }
  const selected = normalized[selectedIndex];
  return {
    type: "plan",
    planTitle: String(plan?.explanation || "Plan"),
    title: `Step ${selectedIndex + 1}/${normalized.length} · ${selected.step || "Working"}`,
    status: selected.status === "in_progress" ? "in_progress" : "pending",
    details,
  };
}

function turnAdditionalContext(applicationInstructions: string | undefined) {
  return applicationInstructions
    ? {
        additionalContext: {
          "slack-concierge": {
            value: applicationInstructions,
            kind: "application",
          },
        },
      }
    : {};
}

export function codexAppServerArgs(): string[] {
  return ["app-server", "--stdio"];
}

function codexTransport(input: { executable?: string }) {
  if (!input.executable) throw new Error("The stdio Codex transport requires an explicit executable.");
  return { executable: input.executable, args: codexAppServerArgs() };
}

const DEFAULT_CODEX_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CODEX_INACTIVITY_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_CODEX_SHUTDOWN_GRACE_MS = 2_000;

async function runCodexControlRequest(input: {
  method: string;
  params: unknown;
  cwd: string;
  executable?: string;
  requestTimeoutMs?: number;
  shutdownGraceMs?: number;
}): Promise<any> {
  if (!input.executable) {
    try {
      return await sharedCodexAppServerClient().request(input.method, input.params, {
        requestTimeoutMs: input.requestTimeoutMs,
      });
    } catch (error) {
      const appServerError = error instanceof CodexAppServerClientError ? error : null;
      const outcome = appServerError?.outcome === "rejected"
        ? input.method === "thread/fork" && appServerError.code !== -32602
          ? "ambiguous"
          : "rejected"
        : "ambiguous";
      throw new CodexControlRequestError(
        error instanceof Error ? error.message : String(error),
        outcome,
      );
    }
  }
  const requestTimeoutMs = input.requestTimeoutMs ?? DEFAULT_CODEX_REQUEST_TIMEOUT_MS;
  const shutdownGraceMs = input.shutdownGraceMs ?? DEFAULT_CODEX_SHUTDOWN_GRACE_MS;
  const transport = codexTransport(input);
  const proc = spawn(transport.executable, transport.args, {
    cwd: input.cwd,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdoutBuf = "";
  let stderr = "";
  let requestId = 0;
  let processClosed = false;
  const pendingRequests = new Map<number, {
    method: string;
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();

  let resolveProcessClosed!: () => void;
  const processClose = new Promise<void>((resolve) => {
    resolveProcessClosed = resolve;
  });

  const rejectPendingRequests = (error: Error) => {
    for (const pending of pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    pendingRequests.clear();
  };

  proc.stdout.on("data", (chunk: Buffer) => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split("\n");
    stdoutBuf = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof message.id !== "number") continue;
      const pending = pendingRequests.get(message.id);
      if (!pending) continue;
      clearTimeout(pending.timeout);
      pendingRequests.delete(message.id);
      if (message.error) {
        const errorCode = Number(message.error.code);
        const outcome = pending.method === "thread/fork" && errorCode !== -32602
          ? "ambiguous"
          : "rejected";
        pending.reject(new CodexControlRequestError(
          `codex ${pending.method} failed: ${message.error.message || JSON.stringify(message.error)}`,
          outcome,
        ));
      } else {
        pending.resolve(message.result);
      }
    }
  });
  proc.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  proc.on("error", (error) => {
    rejectPendingRequests(new CodexControlRequestError(error.message, "ambiguous"));
  });
  proc.stdin.on("error", (error) => {
    rejectPendingRequests(new CodexControlRequestError(error.message, "ambiguous"));
  });
  proc.on("close", (code, signal) => {
    processClosed = true;
    const detail = stderr.trim().slice(0, 800) || `signal ${signal || "none"}`;
    rejectPendingRequests(new CodexControlRequestError(
      `codex app-server exited ${code}: ${detail}`,
      "ambiguous",
    ));
    resolveProcessClosed();
  });

  const request = (method: string, params: unknown): Promise<any> => {
    const id = ++requestId;
    return new Promise((resolve, reject) => {
      if (processClosed || proc.stdin.destroyed || proc.stdin.writableEnded) {
        reject(new CodexControlRequestError(`codex app-server closed before ${method}`, "ambiguous"));
        return;
      }
      const timeout = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new CodexControlRequestError(
          `codex ${method} timed out after ${requestTimeoutMs}ms`,
          "ambiguous",
        ));
      }, requestTimeoutMs);
      pendingRequests.set(id, { method, resolve, reject, timeout });
      proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) return;
        const pending = pendingRequests.get(id);
        if (!pending) return;
        clearTimeout(pending.timeout);
        pendingRequests.delete(id);
        pending.reject(new CodexControlRequestError(error.message, "ambiguous"));
      });
    });
  };

  const notify = (method: string, params?: unknown) => new Promise<void>((resolve, reject) => {
    if (processClosed || proc.stdin.destroyed || proc.stdin.writableEnded) {
      reject(new CodexControlRequestError(`codex app-server closed before ${method}`, "ambiguous"));
      return;
    }
    const message = params === undefined ? { method } : { method, params };
    proc.stdin.write(`${JSON.stringify(message)}\n`, (error) => error
      ? reject(new CodexControlRequestError(error.message, "ambiguous"))
      : resolve());
  });

  const waitForProcessClose = (milliseconds: number) => Promise.race([
    processClose.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), milliseconds)),
  ]);

  const terminateProcess = async () => {
    if (processClosed) return;
    if (!proc.stdin.writableEnded) proc.stdin.end();
    if (await waitForProcessClose(shutdownGraceMs)) return;
    proc.kill("SIGTERM");
    if (await waitForProcessClose(shutdownGraceMs)) return;
    proc.kill("SIGKILL");
    if (!await waitForProcessClose(shutdownGraceMs)) {
      throw new CodexControlRequestError("codex app-server did not exit after SIGKILL", "ambiguous");
    }
  };

  let operationFailed = false;
  try {
    await request("initialize", {
      clientInfo: { name: "slack_concierge", title: "Slack Concierge", version: "0.2.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    await notify("initialized");
    return await request(input.method, input.params);
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    rejectPendingRequests(new CodexControlRequestError(
      `codex app-server closed before ${input.method} completed`,
      "ambiguous",
    ));
    try {
      await terminateProcess();
    } catch (cleanupError) {
      if (!operationFailed) throw cleanupError;
    }
  }
}

export interface RunCodexTurnInput {
  prompt: string;
  cwd: string;
  additionalDirs: string[];
  sessionUUID: string | null;
  model?: string;
  reasoning_effort?: string;
  applicationInstructions?: string;
  clientUserMessageId?: string;
  environment?: Record<string, string>;
  onProgress?: ProgressCb;
  onSteeringReady?: (sender: SteeringSender) => void;
  onCancellationReady?: (cancel: () => Promise<void>) => void;
  onProviderTerminal?: () => void;
  onProviderThreadStarted?: (providerThreadId: string) => void;
  onProviderTurnStarted?: (providerTurnId: string) => void;
  executable?: string;
  requestTimeoutMs?: number;
  inactivityTimeoutMs?: number;
  shutdownGraceMs?: number;
  appServerClient?: CodexAppServerClientLike;
}

async function runCodexTurnStdio(input: RunCodexTurnInput): Promise<RunResult> {
  const { prompt, cwd, onProgress, sessionUUID } = input;
  const requestTimeoutMs = input.requestTimeoutMs ?? DEFAULT_CODEX_REQUEST_TIMEOUT_MS;
  const inactivityTimeoutMs = input.inactivityTimeoutMs ?? DEFAULT_CODEX_INACTIVITY_TIMEOUT_MS;
  const shutdownGraceMs = input.shutdownGraceMs ?? DEFAULT_CODEX_SHUTDOWN_GRACE_MS;

  const transport = codexTransport(input);
  const proc = spawn(transport.executable, transport.args, {
    cwd,
    env: { ...process.env, ...input.environment },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdoutBuf = "";
  let stderr = "";
  let requestId = 0;
  let activeThreadId: string | null = sessionUUID;
  let activeTurnId: string | null = null;
  let durationMs: number | undefined;
  let extractedUUID: string | null = sessionUUID;
  let turnSettled = false;
  let terminalReported = false;
  let processClosed = false;
  const toolsUsed: string[] = [];
  const messageParts: string[] = [];
  const finalAnswerParts: string[] = [];
  const submittedSteeringClientIds = new Set<string>();
  const observedSteeringBoundaryClientIds = new Set<string>();
  let latestSubmittedSteeringClientId: string | null = null;
  let suppressOutputUntilSteeringBoundary = false;
  let cancellationReason: ProviderTurnCancelledError | null = null;
  const progressedToolItemIds = new Set<string>();
  const pendingRequests = new Map<number, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
    onAccepted?: (value: any) => void;
  }>();

  let resolveTurn!: () => void;
  let rejectTurn!: (error: Error) => void;
  const turnCompletion = new Promise<void>((resolve, reject) => {
    resolveTurn = resolve;
    rejectTurn = reject;
  });
  void turnCompletion.catch(() => {});

  let resolveTurnStarted!: () => void;
  let rejectTurnStarted!: (error: Error) => void;
  let turnStartSettled = false;
  const turnStarted = new Promise<void>((resolve, reject) => {
    resolveTurnStarted = resolve;
    rejectTurnStarted = reject;
  });
  void turnStarted.catch(() => {});

  let resolveProcessClosed!: () => void;
  const processClose = new Promise<void>((resolve) => {
    resolveProcessClosed = resolve;
  });

  const textInput = (text: string) => [{ type: "text", text, text_elements: [] }];

  const writeMessage = (message: unknown) => new Promise<void>((resolve, reject) => {
    if (processClosed || proc.stdin.destroyed || proc.stdin.writableEnded) {
      reject(new Error("codex app-server stdin is closed"));
      return;
    }
    proc.stdin.write(`${JSON.stringify(message)}\n`, (error) => error ? reject(error) : resolve());
  });

  const request = (method: string, params: unknown, onAccepted?: (value: any) => void): Promise<any> => {
    const id = ++requestId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = pendingRequests.get(id);
        if (!pending) return;
        pendingRequests.delete(id);
        pending.reject(new Error(`codex app-server ${method} timed out after ${requestTimeoutMs}ms`));
      }, requestTimeoutMs);
      pendingRequests.set(id, { resolve, reject, timeout, onAccepted });
      void writeMessage({ method, id, params }).catch((error) => {
        const pending = pendingRequests.get(id);
        if (pending) clearTimeout(pending.timeout);
        pendingRequests.delete(id);
        reject(error);
      });
    });
  };

  const notify = (method: string) => writeMessage({ method });

  const rejectActiveTurn = (error: Error) => {
    if (turnSettled) return;
    turnSettled = true;
    rejectTurn(error);
  };

  const rejectPendingRequests = (error: Error) => {
    for (const pending of pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    pendingRequests.clear();
  };

  const reportProviderTerminal = () => {
    if (terminalReported) return;
    terminalReported = true;
    input.onProviderTerminal?.();
  };

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
    onProgress?.({ type: "tool_use", toolName, ...(itemId ? { itemId } : {}) });
  };
  const reportActivityProgress = (item: any, status: "in_progress" | "complete" | "error") => {
    const activity = codexProgressActivity(item);
    if (!activity) return;
    onProgress?.({ type: "activity", ...activity, status });
  };

  const observeSteeringBoundary = (item: any) => {
    if (item.type !== "userMessage" || typeof item.clientId !== "string") return;
    if (!submittedSteeringClientIds.has(item.clientId)) return;
    if (observedSteeringBoundaryClientIds.has(item.clientId)) return;
    observedSteeringBoundaryClientIds.add(item.clientId);
    onProgress?.({ type: "steering", clientMessageId: item.clientId });
    if (item.clientId !== latestSubmittedSteeringClientId) return;
    messageParts.length = 0;
    finalAnswerParts.length = 0;
    suppressOutputUntilSteeringBoundary = false;
  };

  const handleNotification = (event: any) => {
    const params = event.params || {};
    switch (event.method) {
      case "thread/started":
        if (params.thread?.id && (!activeThreadId || params.thread.id === activeThreadId)) {
          activeThreadId = params.thread.id;
          extractedUUID = params.thread.id;
        }
        break;
      case "turn/started":
        if (activeThreadId && params.threadId !== activeThreadId) break;
        if (params.turn?.id) activeTurnId = params.turn.id;
        onProgress?.({ type: "started" });
        if (!turnStartSettled) {
          turnStartSettled = true;
          resolveTurnStarted();
        }
        break;
      case "item/started":
        if ((!activeThreadId || params.threadId === activeThreadId) && (!activeTurnId || params.turnId === activeTurnId)) {
          observeSteeringBoundary(params.item || {});
          reportToolProgress(params.item || {}, "started");
          reportActivityProgress(params.item || {}, "in_progress");
        }
        break;
      case "item/completed": {
        if (activeThreadId && params.threadId !== activeThreadId) break;
        if (activeTurnId && params.turnId !== activeTurnId) break;
        const item = params.item || {};
        observeSteeringBoundary(item);
        reportToolProgress(item, "completed");
        reportActivityProgress(item, item?.status === "failed" ? "error" : "complete");
        if (item.type === "agentMessage" && typeof item.text === "string") {
          if (!suppressOutputUntilSteeringBoundary) {
            messageParts.push(item.text);
            if (["final_answer", "finalAnswer"].includes(item.phase)) finalAnswerParts.push(item.text);
            if (item.phase === "commentary") onProgress?.({ type: "commentary", text: item.text });
            onProgress?.({ type: "narration", text: item.text });
          }
        } else {
          const toolName = toolNameFromItem(item);
          if (toolName) toolsUsed.push(toolName);
        }
        break;
      }
      case "turn/completed": {
        if (activeThreadId && params.threadId !== activeThreadId) break;
        const completedTurn = params.turn || {};
        if (activeTurnId && completedTurn.id !== activeTurnId) break;
        activeTurnId = completedTurn.id || activeTurnId;
        reportProviderTerminal();
        if (turnSettled) break;
        durationMs = codexTurnDurationMs(completedTurn);
        turnSettled = true;
        if (cancellationReason) {
          rejectTurn(cancellationReason);
        } else if (completedTurn.status !== "completed") {
          rejectTurn(new Error(
            completedTurn.error?.message || `Codex turn ended with status ${completedTurn.status || "unknown"}.`,
          ));
        } else {
          onProgress?.({ type: "done", text: (finalAnswerParts.length ? finalAnswerParts : messageParts).join("\n\n") });
          resolveTurn();
        }
        break;
      }
      case "turn/plan/updated": {
        if (activeThreadId && params.threadId !== activeThreadId) break;
        if (activeTurnId && params.turnId !== activeTurnId) break;
        const planProgress = codexPlanProgress(params.plan);
        if (planProgress) onProgress?.(planProgress);
        break;
      }
      case "thread/compacted":
        if (!activeThreadId || params.threadId === activeThreadId) onProgress?.({ type: "compaction" });
        break;
    }
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
      if (Object.prototype.hasOwnProperty.call(ev, "id") && ("result" in ev || "error" in ev)) {
        const pending = pendingRequests.get(Number(ev.id));
        if (!pending) continue;
        resetInactivityTimeout();
        clearTimeout(pending.timeout);
        pendingRequests.delete(Number(ev.id));
        if (ev.error) {
          pending.reject(new Error(`codex app-server ${ev.error.code ?? "error"}: ${ev.error.message || JSON.stringify(ev.error)}`));
        } else {
          try {
            // This runs synchronously at the exact JSON-RPC acceptance
            // boundary, before any later provider event in the same chunk.
            pending.onAccepted?.(ev.result);
            pending.resolve(ev.result);
          } catch (error) {
            pending.reject(error instanceof Error ? error : new Error(String(error)));
          }
        }
      } else if (Object.prototype.hasOwnProperty.call(ev, "id") && ev.method) {
        resetInactivityTimeout();
        void writeMessage({
          id: ev.id,
          error: { code: -32601, message: `Slack Concierge cannot answer server request ${ev.method}.` },
        }).catch(() => {});
      } else if (ev.method) {
        resetInactivityTimeout();
        handleNotification(ev);
      }
    }
  });
  proc.stderr.on("data", (c: Buffer) => {
    stderr += c.toString();
  });

  const handleProcessFailure = (error: unknown) => {
    const failure = error instanceof Error ? error : new Error(String(error));
    rejectPendingRequests(failure);
    if (!turnStartSettled) {
      turnStartSettled = true;
      rejectTurnStarted(failure);
    }
    if (activeTurnId) rejectActiveTurn(failure);
  };
  let inactivityTimeout: ReturnType<typeof setTimeout> | null = null;
  const stopInactivityTimeout = () => {
    if (!inactivityTimeout) return;
    clearTimeout(inactivityTimeout);
    inactivityTimeout = null;
  };
  const resetInactivityTimeout = () => {
    stopInactivityTimeout();
    inactivityTimeout = setTimeout(() => {
      const failure = new Error(`codex app-server produced no protocol activity for ${inactivityTimeoutMs}ms`);
      handleProcessFailure(failure);
      proc.kill("SIGTERM");
    }, inactivityTimeoutMs);
  };
  proc.on("error", handleProcessFailure);
  proc.stdin.on("error", handleProcessFailure);
  proc.on("close", (code) => {
    stopInactivityTimeout();
    processClosed = true;
    const failure = new Error(`codex app-server exited ${code}: ${stderr.slice(0, 800) || "(no stderr)"}`);
    rejectPendingRequests(failure);
    if (!turnStartSettled) {
      turnStartSettled = true;
      rejectTurnStarted(failure);
    }
    if (activeTurnId && !turnSettled) rejectActiveTurn(failure);
    resolveProcessClosed();
  });
  resetInactivityTimeout();

  const waitForProcessClose = (milliseconds: number) => Promise.race([
    processClose.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), milliseconds)),
  ]);

  const terminateProcess = async () => {
    if (processClosed) return;
    if (!proc.stdin.writableEnded) proc.stdin.end();
    if (await waitForProcessClose(shutdownGraceMs)) return;
    proc.kill("SIGTERM");
    if (await waitForProcessClose(shutdownGraceMs)) return;
    proc.kill("SIGKILL");
    if (!await waitForProcessClose(shutdownGraceMs)) {
      throw new Error("codex app-server did not exit after SIGKILL");
    }
  };

  try {
    await request("initialize", {
      clientInfo: { name: "slack_concierge", title: "Slack Concierge", version: "0.2.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    await notify("initialized");

    const runtimeWorkspaceRoots = [...new Set([cwd, ...input.additionalDirs])];
    const threadParams = {
      cwd,
      runtimeWorkspaceRoots,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      ...(input.model ? { model: input.model } : {}),
      ...(input.reasoning_effort ? { reasoningEffort: input.reasoning_effort } : {}),
    };
    const threadResponse = sessionUUID
      ? await request("thread/resume", { threadId: sessionUUID, ...threadParams })
      : await request("thread/start", threadParams);
    const threadId = threadResponse?.thread?.id || sessionUUID;
    if (!threadId) throw new Error("codex app-server did not return a thread id");
    activeThreadId = threadId;
    extractedUUID = threadId;
    input.onProviderThreadStarted?.(threadId);

    const turnResponse = await request("turn/start", {
      threadId,
      input: textInput(prompt),
      ...(input.clientUserMessageId ? { clientUserMessageId: input.clientUserMessageId } : {}),
      ...turnAdditionalContext(input.applicationInstructions),
    });
    activeTurnId = turnResponse?.turn?.id || activeTurnId;
    if (!activeTurnId) throw new Error("codex app-server did not return a turn id");
    input.onProviderTurnStarted?.(activeTurnId);
    await Promise.race([turnStarted, turnCompletion]);

    if (!turnSettled) {
      input.onCancellationReady?.(async () => {
        if (turnSettled || !activeTurnId) return;
        cancellationReason = new ProviderTurnCancelledError();
        await request("turn/interrupt", { threadId, turnId: activeTurnId });
      });
      input.onSteeringReady?.(async (steering) => {
        if (turnSettled || !activeTurnId) {
          throw new SteeringNotSentError("Codex completed before the steering message arrived.");
        }
        submittedSteeringClientIds.add(steering.clientMessageId);
        latestSubmittedSteeringClientId = steering.clientMessageId;
        try {
          await request("turn/steer", {
            threadId,
            expectedTurnId: activeTurnId,
            clientUserMessageId: steering.clientMessageId,
            input: textInput(steering.text),
          }, (response) => {
            if (response?.turnId !== activeTurnId) {
              throw new Error(
                `codex app-server acknowledged steering for unexpected turn ${String(response?.turnId || "unknown")}`,
              );
            }
            // Notifications and JSON-RPC responses are independent streams.
            // If the boundary arrived first, it already opened the replacement
            // output segment. Otherwise suppress stale output until it arrives.
            if (observedSteeringBoundaryClientIds.has(steering.clientMessageId)) {
              suppressOutputUntilSteeringBoundary = false;
            } else {
              suppressOutputUntilSteeringBoundary = true;
              messageParts.length = 0;
              finalAnswerParts.length = 0;
            }
          });
        } catch (error) {
          submittedSteeringClientIds.delete(steering.clientMessageId);
          throw error;
        }
      });
    }

    await turnCompletion;
  } finally {
    stopInactivityTimeout();
    rejectPendingRequests(new Error("codex app-server turn ended before the request completed"));
    await terminateProcess();
  }

  const text = (finalAnswerParts.length ? finalAnswerParts : messageParts).join("\n\n").trim();
  return {
    text: text || "(agent completed without a text reply)",
    sessionUUID: extractedUUID,
    toolsUsed,
    providerTurnId: activeTurnId,
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

async function runCodexTurnShared(input: RunCodexTurnInput): Promise<RunResult> {
  const { prompt, cwd, onProgress, sessionUUID } = input;
  const requestTimeoutMs = input.requestTimeoutMs ?? DEFAULT_CODEX_REQUEST_TIMEOUT_MS;
  const inactivityTimeoutMs = input.inactivityTimeoutMs ?? DEFAULT_CODEX_INACTIVITY_TIMEOUT_MS;
  const client = input.appServerClient ?? sharedCodexAppServerClient();
  const submissionClientId = input.clientUserMessageId
    ?? `slack-concierge:ephemeral:${randomUUID()}`;
  const runtimeWorkspaceRoots = [...new Set([cwd, ...input.additionalDirs])];
  // The app-server shell policy belongs to the durable thread, while commit
  // provenance belongs to one turn. The Git hook resolves that value from the
  // live CODEX_THREAD_ID so a resumed thread cannot retain an older turn token.
  const {
    CONCIERGE_COMMIT_PROVENANCE: _turnScopedCommitProvenance,
    ...threadEnvironment
  } = input.environment || {};
  const threadParams = {
    cwd,
    runtimeWorkspaceRoots,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    ...(Object.keys(threadEnvironment).length > 0
      ? { config: { shell_environment_policy: { inherit: "all", set: threadEnvironment } } }
      : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.reasoning_effort ? { reasoningEffort: input.reasoning_effort } : {}),
  };
  let connectionGeneration: number | null = null;
  let activeThreadId: string | null = sessionUUID;
  let activeTurnId: string | null = null;
  let durationMs: number | undefined;
  let extractedUUID: string | null = sessionUUID;
  let turnSubmissionAttempted = false;
  let turnSettled = false;
  let terminalReported = false;
  let providerTurnReported = false;
  let interruptionReason: Error | null = null;
  let recoveryMustInterrupt = false;
  let recoveryPromise: Promise<void> | null = null;
  let controllerClosed = false;
  const preIdentityEvents: any[] = [];
  const toolsUsed: string[] = [];
  const messageParts: string[] = [];
  const finalAnswerParts: string[] = [];
  const submittedSteeringClientIds = new Set<string>();
  const observedSteeringBoundaryClientIds = new Set<string>();
  let latestSubmittedSteeringClientId: string | null = null;
  let suppressOutputUntilSteeringBoundary = false;
  const progressedToolItemIds = new Set<string>();
  const completedItemIds = new Set<string>();

  let resolveTurn!: () => void;
  let rejectTurn!: (error: Error) => void;
  const turnCompletion = new Promise<void>((resolve, reject) => {
    resolveTurn = resolve;
    rejectTurn = reject;
  });
  void turnCompletion.catch(() => {});

  let resolveTurnStarted!: () => void;
  let rejectTurnStarted!: (error: Error) => void;
  let turnStartSettled = false;
  const turnStarted = new Promise<void>((resolve, reject) => {
    resolveTurnStarted = resolve;
    rejectTurnStarted = reject;
  });
  void turnStarted.catch(() => {});

  let inactivityTimeout: ReturnType<typeof setTimeout> | null = null;
  const stopInactivityTimeout = () => {
    if (!inactivityTimeout) return;
    clearTimeout(inactivityTimeout);
    inactivityTimeout = null;
  };
  let resetInactivityTimeout = () => {};
  const request = async (
    method: string,
    params: unknown,
    onAccepted?: (value: any) => void,
  ) => {
    const result = await client.request(method, params, { requestTimeoutMs, onAccepted });
    resetInactivityTimeout();
    return result;
  };
  const textInput = (text: string) => [{ type: "text", text, text_elements: [] }];

  const reportProviderTerminal = () => {
    if (terminalReported) return;
    terminalReported = true;
    input.onProviderTerminal?.();
  };
  const reportTurnStarted = () => {
    if (!activeTurnId) return;
    if (!providerTurnReported) {
      input.onProviderTurnStarted?.(activeTurnId);
      providerTurnReported = true;
    }
    if (!turnStartSettled) {
      turnStartSettled = true;
      onProgress?.({ type: "started" });
      resolveTurnStarted();
    }
  };
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
    onProgress?.({ type: "tool_use", toolName, ...(itemId ? { itemId } : {}) });
  };
  const reportActivityProgress = (item: any, status: "in_progress" | "complete" | "error") => {
    const activity = codexProgressActivity(item);
    if (!activity) return;
    onProgress?.({ type: "activity", ...activity, status });
  };
  const observeSteeringBoundary = (item: any) => {
    if (item.type !== "userMessage" || typeof item.clientId !== "string") return;
    if (!submittedSteeringClientIds.has(item.clientId)) return;
    if (observedSteeringBoundaryClientIds.has(item.clientId)) return;
    observedSteeringBoundaryClientIds.add(item.clientId);
    onProgress?.({ type: "steering", clientMessageId: item.clientId });
    if (item.clientId !== latestSubmittedSteeringClientId) return;
    messageParts.length = 0;
    finalAnswerParts.length = 0;
    suppressOutputUntilSteeringBoundary = false;
  };
  const recordCompletedItem = (item: any) => {
    const itemId = typeof item.id === "string" ? item.id : null;
    if (itemId) {
      if (completedItemIds.has(itemId)) return;
      completedItemIds.add(itemId);
    }
    observeSteeringBoundary(item);
    reportToolProgress(item, "completed");
    reportActivityProgress(item, item?.status === "failed" ? "error" : "complete");
    if (item.type === "agentMessage" && typeof item.text === "string") {
      if (!suppressOutputUntilSteeringBoundary) {
        messageParts.push(item.text);
        if (["final_answer", "finalAnswer"].includes(item.phase)) finalAnswerParts.push(item.text);
        if (item.phase === "commentary") onProgress?.({ type: "commentary", text: item.text });
        onProgress?.({ type: "narration", text: item.text });
      }
      return;
    }
    const toolName = toolNameFromItem(item);
    if (toolName) toolsUsed.push(toolName);
  };
  const settleFromTurn = (turn: any) => {
    if (turnSettled) return;
    if (typeof turn?.id === "string") activeTurnId = turn.id;
    reportTurnStarted();
    for (const item of Array.isArray(turn?.items) ? turn.items : []) recordCompletedItem(item);
    if (!turn?.status || turn.status === "inProgress") return;
    durationMs = codexTurnDurationMs(turn);
    reportProviderTerminal();
    turnSettled = true;
    if (interruptionReason) {
      rejectTurn(interruptionReason);
    } else if (turn.status !== "completed") {
      rejectTurn(new ProviderDispatchError({
        message: turn.error?.message || `Codex turn ended with status ${turn.status}.`,
        terminalConfirmed: true,
        toolsUsed,
        providerSessionId: activeThreadId,
        providerTurnId: activeTurnId,
      }));
    } else {
      onProgress?.({ type: "done", text: (finalAnswerParts.length ? finalAnswerParts : messageParts).join("\n\n") });
      resolveTurn();
    }
  };
  let flushPreIdentityEvents = () => {};
  const handleNotification = (event: any) => {
    const params = event.params || {};
    const eventTurnId = event.method === "turn/started"
      ? params.turn?.id
      : event.method === "turn/completed"
        ? params.turn?.id
        : ["item/started", "item/completed"].includes(event.method)
          ? params.turnId
          : null;
    if (eventTurnId && !activeTurnId) {
      if (
        activeThreadId
        && params.threadId === activeThreadId
        && preIdentityEvents.length < 1_000
      ) {
        preIdentityEvents.push(event);
      }
      return;
    }
    switch (event.method) {
      case "thread/started":
        if (!activeThreadId || params.thread?.id !== activeThreadId) return;
        resetInactivityTimeout();
        return;
      case "turn/started":
        if (!activeThreadId || params.threadId !== activeThreadId) return;
        if (params.turn?.id !== activeTurnId) return;
        resetInactivityTimeout();
        reportTurnStarted();
        return;
      case "item/started":
        if (!activeThreadId || params.threadId !== activeThreadId) return;
        if (activeTurnId && params.turnId !== activeTurnId) return;
        resetInactivityTimeout();
        observeSteeringBoundary(params.item || {});
        reportToolProgress(params.item || {}, "started");
        reportActivityProgress(params.item || {}, "in_progress");
        return;
      case "item/completed": {
        if (!activeThreadId || params.threadId !== activeThreadId) return;
        if (activeTurnId && params.turnId !== activeTurnId) return;
        resetInactivityTimeout();
        recordCompletedItem(params.item || {});
        return;
      }
      case "turn/completed": {
        if (!activeThreadId || params.threadId !== activeThreadId) return;
        const completedTurn = params.turn || {};
        if (activeTurnId && completedTurn.id !== activeTurnId) return;
        resetInactivityTimeout();
        settleFromTurn(completedTurn);
        return;
      }
      case "turn/plan/updated": {
        if (!activeThreadId || params.threadId !== activeThreadId) return;
        if (activeTurnId && params.turnId !== activeTurnId) return;
        resetInactivityTimeout();
        const planProgress = codexPlanProgress(params.plan);
        if (planProgress) onProgress?.(planProgress);
        return;
      }
      case "thread/compacted":
        if (!activeThreadId || params.threadId !== activeThreadId) return;
        resetInactivityTimeout();
        onProgress?.({ type: "compaction" });
        return;
    }
  };
  flushPreIdentityEvents = () => {
    if (!activeTurnId || preIdentityEvents.length === 0) return;
    const queued = preIdentityEvents.splice(0);
    for (const event of queued) handleNotification(event);
  };
  const acceptActiveTurnId = (turnId: string) => {
    activeTurnId = turnId;
    reportTurnStarted();
    flushPreIdentityEvents();
  };

  const matchingTurn = (turns: any[]) => {
    if (activeTurnId) {
      const exact = turns.find((turn) => turn?.id === activeTurnId);
      if (exact) return exact;
    }
    return turns.find((turn) => (Array.isArray(turn?.items) ? turn.items : []).some(
      (item: any) => item?.type === "userMessage" && item?.clientId === submissionClientId,
    ));
  };

  const waitForRecoveryRetry = (milliseconds: number) => new Promise<void>(
    (resolve) => setTimeout(resolve, milliseconds),
  );
  const reconcileAcceptedTurn = async () => {
    stopInactivityTimeout();
    let retryMs = 100;
    while (!turnSettled && !controllerClosed) {
      try {
        if (!activeThreadId) throw new Error("Cannot reconcile a Codex turn without its thread id.");
        connectionGeneration = await client.connect();
        await client.request("thread/resume", {
          threadId: activeThreadId,
          ...threadParams,
        }, { requestTimeoutMs });
        const history = await client.request("thread/read", {
          threadId: activeThreadId,
          includeTurns: true,
        }, { requestTimeoutMs });
        const turns = Array.isArray(history?.thread?.turns) ? history.thread.turns : [];
        const turn = matchingTurn(turns);
        if (!turn) {
          await waitForRecoveryRetry(retryMs);
          retryMs = Math.min(retryMs * 2, 5_000);
          continue;
        }
        if (typeof turn.id === "string") acceptActiveTurnId(turn.id);
        settleFromTurn(turn);
        if (turnSettled) return;
        if (recoveryMustInterrupt && activeTurnId) {
          try {
            await client.request("turn/interrupt", {
              threadId: activeThreadId,
              turnId: activeTurnId,
            }, { requestTimeoutMs });
          } catch {
            // The interrupt response is non-atomic with the daemon state. The
            // next exact history read, not the transport outcome, is decisive.
          }
          await waitForRecoveryRetry(retryMs);
          retryMs = Math.min(retryMs * 2, 5_000);
          continue;
        }
        resetInactivityTimeout();
        return;
      } catch {
        stopInactivityTimeout();
        await waitForRecoveryRetry(retryMs);
        retryMs = Math.min(retryMs * 2, 5_000);
      }
    }
  };
  const ensureRecovered = () => {
    recoveryPromise ??= reconcileAcceptedTurn().finally(() => {
      recoveryPromise = null;
    });
    return recoveryPromise;
  };
  resetInactivityTimeout = () => {
    stopInactivityTimeout();
    if (!turnSubmissionAttempted || turnSettled) return;
    inactivityTimeout = setTimeout(() => {
      if (turnSettled) return;
      interruptionReason = new Error(
        `codex app-server produced no turn activity for ${inactivityTimeoutMs}ms`,
      );
      recoveryMustInterrupt = true;
      void ensureRecovered();
    }, inactivityTimeoutMs);
  };

  const unsubscribeNotifications = client.onNotification((event) => {
    try {
      handleNotification(event);
    } catch (error) {
      log("error", "codex_turn_notification_failed", {
        ...errorFields(error),
        provider_thread_uuid: activeThreadId,
        provider_turn_id: activeTurnId,
        method: event?.method,
      });
      stopInactivityTimeout();
      if (turnSubmissionAttempted && activeThreadId) void ensureRecovered();
    }
  });
  const unsubscribeDisconnect = client.onDisconnect((error, generation) => {
    if (connectionGeneration !== generation) return;
    stopInactivityTimeout();
    if (turnSubmissionAttempted && activeThreadId) {
      void ensureRecovered();
      return;
    }
    if (!turnStartSettled) {
      turnStartSettled = true;
      rejectTurnStarted(error);
    }
  });
  try {
    connectionGeneration = await client.connect();
    const threadResponse = sessionUUID
      ? await request("thread/resume", { threadId: sessionUUID, ...threadParams })
      : await request("thread/start", threadParams);
    const threadId = threadResponse?.thread?.id || sessionUUID;
    if (!threadId) throw new Error("codex app-server did not return a thread id");
    activeThreadId = threadId;
    extractedUUID = threadId;
    input.onProviderThreadStarted?.(threadId);

    turnSubmissionAttempted = true;
    try {
      const turnResponse = await request("turn/start", {
        threadId,
        input: textInput(prompt),
        clientUserMessageId: submissionClientId,
        ...turnAdditionalContext(input.applicationInstructions),
      });
      const returnedTurnId = turnResponse?.turn?.id || activeTurnId;
      if (!returnedTurnId) throw new Error("codex app-server did not return a turn id");
      acceptActiveTurnId(returnedTurnId);
      resetInactivityTimeout();
    } catch (error) {
      if (error instanceof CodexAppServerClientError && error.outcome === "rejected") throw error;
      await ensureRecovered();
    }
    await Promise.race([turnStarted, turnCompletion]);

    if (!turnSettled) {
      input.onCancellationReady?.(async () => {
        if (recoveryPromise) await recoveryPromise;
        if (turnSettled || !activeTurnId) return;
        interruptionReason = new ProviderTurnCancelledError();
        recoveryMustInterrupt = true;
        try {
          await request("turn/interrupt", { threadId, turnId: activeTurnId });
        } catch {
          await ensureRecovered();
        }
      });
      input.onSteeringReady?.(async (steering) => {
        if (recoveryPromise) await recoveryPromise;
        if (turnSettled || !activeTurnId) {
          throw new SteeringNotSentError("Codex completed before the steering message arrived.");
        }
        submittedSteeringClientIds.add(steering.clientMessageId);
        latestSubmittedSteeringClientId = steering.clientMessageId;
        try {
          await request("turn/steer", {
            threadId,
            expectedTurnId: activeTurnId,
            clientUserMessageId: steering.clientMessageId,
            input: textInput(steering.text),
          }, (response) => {
            if (response?.turnId !== activeTurnId) {
              throw new Error(
                `codex app-server acknowledged steering for unexpected turn ${String(response?.turnId || "unknown")}`,
              );
            }
            if (observedSteeringBoundaryClientIds.has(steering.clientMessageId)) {
              suppressOutputUntilSteeringBoundary = false;
            } else {
              suppressOutputUntilSteeringBoundary = true;
              messageParts.length = 0;
              finalAnswerParts.length = 0;
            }
          });
        } catch (error) {
          submittedSteeringClientIds.delete(steering.clientMessageId);
          throw error;
        }
      });
    }
    await turnCompletion;
  } finally {
    controllerClosed = true;
    stopInactivityTimeout();
    unsubscribeNotifications();
    unsubscribeDisconnect();
  }

  const text = (finalAnswerParts.length ? finalAnswerParts : messageParts).join("\n\n").trim();
  return {
    text: text || "(agent completed without a text reply)",
    sessionUUID: extractedUUID,
    toolsUsed,
    providerTurnId: activeTurnId,
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

export async function runCodexTurn(input: RunCodexTurnInput): Promise<RunResult> {
  return input.executable ? runCodexTurnStdio(input) : runCodexTurnShared(input);
}

export async function forkCodexSession(input: {
  sessionUUID: string;
  cwd: string;
  additionalDirs: string[];
  executable?: string;
  requestTimeoutMs?: number;
  shutdownGraceMs?: number;
  lastTurnId?: string | null;
  threadSource?: string | null;
}): Promise<RunResult> {
  const runtimeWorkspaceRoots = [...new Set([input.cwd, ...input.additionalDirs])];
  const response = await runCodexControlRequest({
    method: "thread/fork",
    params: {
      threadId: input.sessionUUID,
      cwd: input.cwd,
      runtimeWorkspaceRoots,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      deferGoalContinuation: true,
      excludeTurns: true,
      ...(input.lastTurnId ? { lastTurnId: input.lastTurnId } : {}),
      ...(input.threadSource ? { threadSource: input.threadSource } : {}),
    },
    cwd: input.cwd,
    executable: input.executable,
    requestTimeoutMs: input.requestTimeoutMs,
    shutdownGraceMs: input.shutdownGraceMs,
  });
  const forkedThreadId = response?.thread?.id;
  if (!forkedThreadId || forkedThreadId === input.sessionUUID) {
    throw new Error("codex thread/fork did not return a distinct new thread id");
  }
  return { text: "Fork created.", sessionUUID: forkedThreadId, toolsUsed: [], providerTurnId: null };
}

export async function findCodexForksByThreadSource(input: {
  sourceSessionUUID: string;
  threadSource: string;
  cwd: string;
  executable?: string;
  requestTimeoutMs?: number;
  shutdownGraceMs?: number;
}): Promise<string[]> {
  const found = new Set<string>();
  let cursor: string | null = null;
  do {
    const response = await runCodexControlRequest({
      method: "thread/list",
      params: {
        // The top-level `codex app-server` command identifies its sessions as
        // VS Code sessions in Codex 0.147.0. `appServer` is reserved for the
        // standalone app-server binary, which this integration does not run.
        sourceKinds: ["vscode"],
        cwd: input.cwd,
        limit: 100,
        cursor,
        sortKey: "created_at",
        sortDirection: "desc",
      },
      cwd: input.cwd,
      executable: input.executable,
      requestTimeoutMs: input.requestTimeoutMs,
      shutdownGraceMs: input.shutdownGraceMs,
    });
    for (const thread of response?.data || []) {
      if (
        thread?.forkedFromId === input.sourceSessionUUID
        && thread?.threadSource === input.threadSource
        && thread?.id
      ) {
        found.add(String(thread.id));
      }
    }
    cursor = response?.nextCursor || null;
  } while (cursor);
  return [...found];
}

export async function findCodexTurnIdsByReplayText(input: {
  sessionUUID: string;
  replayText: string;
  cwd: string;
  executable?: string;
  requestTimeoutMs?: number;
  shutdownGraceMs?: number;
}): Promise<string[]> {
  const response = await runCodexControlRequest({
    method: "thread/read",
    params: { threadId: input.sessionUUID, includeTurns: true },
    cwd: input.cwd,
    executable: input.executable,
    requestTimeoutMs: input.requestTimeoutMs,
    shutdownGraceMs: input.shutdownGraceMs,
  });
  const replayText = input.replayText.trim();
  if (!replayText) return [];
  const matches = new Set<string>();
  for (const turn of response?.thread?.turns || []) {
    const messageTexts = (turn?.items || [])
      .filter((item: any) => item?.type === "userMessage")
      .map((item: any) => (item.content || [])
        .filter((content: any) => content?.type === "text" && typeof content.text === "string")
        .map((content: any) => content.text)
        .join("\n"));
    const matchesReplay = messageTexts.some((message: string) => {
      const trimmed = message.trim();
      return trimmed === replayText
        || trimmed.endsWith(`\n\n${replayText}`)
        || trimmed.includes(`\n\n${replayText}\n\nSlack attachments for this message were downloaded locally for this turn.`);
    });
    if (matchesReplay && turn?.id) matches.add(String(turn.id));
  }
  return [...matches];
}
