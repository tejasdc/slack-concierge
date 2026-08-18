import { spawn } from "node:child_process";
import { SteeringNotSentError, SteeringSender } from "./steering";

export type ProgressCb = (event: {
  type: "started" | "narration" | "tool_use" | "done";
  text?: string;
  toolName?: string;
}) => void;

export interface RunResult {
  text: string;
  sessionUUID: string | null;
  toolsUsed: string[];
  providerTurnId?: string | null;
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

export function codexAppServerArgs(): string[] {
  return ["app-server", "--stdio"];
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
  const requestTimeoutMs = input.requestTimeoutMs ?? DEFAULT_CODEX_REQUEST_TIMEOUT_MS;
  const shutdownGraceMs = input.shutdownGraceMs ?? DEFAULT_CODEX_SHUTDOWN_GRACE_MS;
  const proc = spawn(input.executable || "codex", codexAppServerArgs(), {
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

export async function runCodexTurn(input: {
  prompt: string;
  cwd: string;
  additionalDirs: string[];
  sessionUUID: string | null;
  model?: string;
  reasoning_effort?: string;
  onProgress?: ProgressCb;
  onSteeringReady?: (sender: SteeringSender) => void;
  onProviderTerminal?: () => void;
  executable?: string;
  requestTimeoutMs?: number;
  inactivityTimeoutMs?: number;
  shutdownGraceMs?: number;
}): Promise<RunResult> {
  const { prompt, cwd, onProgress, sessionUUID } = input;
  const requestTimeoutMs = input.requestTimeoutMs ?? DEFAULT_CODEX_REQUEST_TIMEOUT_MS;
  const inactivityTimeoutMs = input.inactivityTimeoutMs ?? DEFAULT_CODEX_INACTIVITY_TIMEOUT_MS;
  const shutdownGraceMs = input.shutdownGraceMs ?? DEFAULT_CODEX_SHUTDOWN_GRACE_MS;

  const proc = spawn(input.executable || "codex", codexAppServerArgs(), {
    cwd,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdoutBuf = "";
  let stderr = "";
  let requestId = 0;
  let activeThreadId: string | null = sessionUUID;
  let activeTurnId: string | null = null;
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
    onProgress?.({ type: "tool_use", toolName });
  };

  const observeSteeringBoundary = (item: any) => {
    if (item.type !== "userMessage" || typeof item.clientId !== "string") return;
    if (!submittedSteeringClientIds.has(item.clientId)) return;
    observedSteeringBoundaryClientIds.add(item.clientId);
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
        }
        break;
      case "item/completed": {
        if (activeThreadId && params.threadId !== activeThreadId) break;
        if (activeTurnId && params.turnId !== activeTurnId) break;
        const item = params.item || {};
        observeSteeringBoundary(item);
        reportToolProgress(item, "completed");
        if (item.type === "agentMessage" && typeof item.text === "string") {
          if (!suppressOutputUntilSteeringBoundary) {
            messageParts.push(item.text);
            if (["final_answer", "finalAnswer"].includes(item.phase)) finalAnswerParts.push(item.text);
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
        turnSettled = true;
        if (completedTurn.status !== "completed") {
          rejectTurn(new Error(
            completedTurn.error?.message || `Codex turn ended with status ${completedTurn.status || "unknown"}.`,
          ));
        } else {
          onProgress?.({ type: "done", text: (finalAnswerParts.length ? finalAnswerParts : messageParts).join("\n\n") });
          resolveTurn();
        }
        break;
      }
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

    const turnResponse = await request("turn/start", {
      threadId,
      input: textInput(prompt),
    });
    activeTurnId = turnResponse?.turn?.id || activeTurnId;
    if (!activeTurnId) throw new Error("codex app-server did not return a turn id");
    await Promise.race([turnStarted, turnCompletion]);

    if (!turnSettled) {
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
  };
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
