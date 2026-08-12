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

export function codexAppServerArgs(): string[] {
  return ["app-server", "--stdio"];
}

const DEFAULT_CODEX_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CODEX_INACTIVITY_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_CODEX_SHUTDOWN_GRACE_MS = 2_000;

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
  };
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
