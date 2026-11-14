import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { providerOwnerEnvironment } from "./provider-owner-environment";
import { withoutMachinePaths } from "./runner-machine";
import { splitTurnOutcomeMarker } from "./turn-outcome-marker";
import { codexHistoryMessages, providerMessageObserver, type ProviderMessageCallback } from "./provider-history";
import {
  CodexAppServerClientError,
  CodexAppServerUnansweredError,
  codexAppServerReady,
  codexRelayRunner,
  sharedCodexAppServerClient,
  type CodexAppServerClientLike,
} from "./codex-app-server-client";
import { errorFields, log } from "./log";
import { ProviderDispatchError, ProviderTurnCancelledError } from "./provider-failures";
import { assertUsageAvailable, codexUsageReset, recordUsageExhaustion, recordUsageSuccess, usageAttempt } from "./provider-usage";
import { SteeringNotSentError, SteeringSender } from "./steering";
import { SubprocessClaudeCodeTransport, type ClaudeCodeTransport, type TransportFrameMeta } from "./claude-code";
import { webActivityDetails } from "./agent-progress";
import { ledgerDurable } from "./ledger-durability-barrier";
import { macSurfaceActivity, type MacSurfaceActivity } from "./mac-surface-activity";
import {isCodeEditTool} from './implementation-models';
import { assertProviderForkPolicy, assertProviderInteractionPolicy, codexConsultationConfig,
  CONSULTATION_PERMISSION_PROFILE, ProviderCapabilityUnavailableError, type ProviderInteractionPolicy } from "./provider-policy";

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
  | { type: "tool_use"; toolName?: string; itemId?: string; details?: string; codeEdit?: boolean }
  | { type: "tool_started" | "tool_finished"; toolName?: string; itemId?: string }
  | { type: "mac_surface_activity"; itemId: string; activity: MacSurfaceActivity }
  | { type: "done"; text?: string };

export type ProgressCb = (event: ProgressEvent) => void;

export interface RunResult {
  /**
   * What the turn actually said, empty when it said nothing of its own — a turn whose whole
   * answer was the outcome marker has nothing left once the marker is removed. An empty answer
   * is not a message: no surface substitutes wording for it, because a placeholder written here
   * reads as the agent speaking (Tejas saw one in a thread on 2026-09-22).
   */
  text: string;
  model?: string;
  sessionUUID: string | null;
  toolsUsed: string[];
  providerTurnId?: string | null;
  durationMs?: number;
  /** The outcome marker the final answer ended with, removed from `text`. Absent when it had none. */
  turnOutcome?: import("./turn-outcome-marker").TurnOutcomeMark;
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
  if (["command_execution", "commandExecution", "CommandExecution"].includes(item.type)) {
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
    const action = item.action;
    const details = webActivityDetails(action?.type === "search" ? action
      : action?.type === "openPage" ? { url: action.url }
      : action?.type === "findInPage" ? { url: action.url, pattern: action.pattern }
      : { query: item.query });
    return { itemId, title: item.action?.type === "openPage" ? "Reading a web page"
      : item.action?.type === "findInPage" ? "Searching a web page" : "Searching the web",
      ...(details ? { details } : {}) };
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
/**
 * How long a turn's resume may go unanswered before the repair agent is told. The slowest cold
 * load seen (a 218 MB conversation on a swapping host, 2026-11-04) took about 2.5 minutes, so ten
 * minutes means the App Server is stuck, not loading. The turn keeps waiting either way.
 */
export const CODEX_RESUME_NOTICE_AFTER_MS = 10 * 60_000;
export type CodexResumeWait = {
  providerThreadId: string; startedAtMs: number; waitedMs: number; state: "waiting" | "ended";
};
/** Items of a recovered turn recorded between yields to the owner's loop. */
const RECOVERED_ITEMS_PER_STEP = 50;
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
    const text = chunk.toString();
    stdoutBuf += text;
    if (!text.includes("\n")) return;
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
  codexRecovery?: {authorizationId:string;capability?:string;model:string;effort:string;preparedPromptDigest?:string};
  applicationInstructions?: string;
  clientUserMessageId?: string;
  environment?: Record<string, string>;
  accountLabel?: string;
  usageProbe?: boolean;
  interactionPolicy?: ProviderInteractionPolicy;
  onProgress?: ProgressCb;
  onProviderMessage?: ProviderMessageCallback;
  onSteeringReady?: (sender: SteeringSender) => void;
  onCancellationReady?: (cancel: () => Promise<void>) => void;
  onProviderTerminal?: (evidence?:{providerThreadId:string|null;providerTurnId:string|null;status:string}) => void;
  onInputAcknowledged?: () => void;
  onProviderThreadStarted?: (providerThreadId: string) => void;
  onProviderTurnStarted?: (providerTurnId: string) => void;
  /** A resume unanswered past `resumeNoticeAfterMs` ("waiting"), then its end ("ended"). */
  onResumeUnanswered?: (wait: CodexResumeWait) => void;
  resumeNoticeAfterMs?: number;
  executable?: string;
  requestTimeoutMs?: number;
  inactivityTimeoutMs?: number;
  shutdownGraceMs?: number;
  appServerClient?: CodexAppServerClientLike;
  onRateLimits?: (snapshot: unknown) => void;
  /**
   * This run's turn was started by an earlier coordinator and is still the daemon's: follow it by
   * its exact thread (and turn, when recorded), never start one (design 2026-10-07 §4.2).
   */
  adoptTurn?: { threadId: string; turnId: string | null };
  /** A private app-server process's line transport (a direct child by default, or an execution host). */
  transport?: ClaudeCodeTransport;
  /** That private process was started by an earlier coordinator; its record is replayed, nothing resent. */
  adopted?: boolean;
  /** Follow-ups the earlier coordinator was sending; Codex's history decides whether each arrived. */
  recoveredSteeringClientIds?: string[];
  onRecoveredSteering?: (clientMessageId: string, outcome: "acknowledged" | "unacknowledged") => void;
  /** The adopted turn was still running in the daemon when it was taken over (survival evidence). */
  onAdoptedLive?: () => void;
}

function codexMessageObserver(input: RunCodexTurnInput, submissionClientId: string, currentModel:()=>string|undefined) {
  const publish = providerMessageObserver(input.onProviderMessage);
  let binding: { threadId: string; turnId: string } | null = null;
  let acknowledged = false;
  const pending: Array<{ threadId: string; turnId: string; item: any }> = [];
  const observe = (event: { threadId: string; turnId: string; item: any }) => {
    if (!input.onProviderMessage) return;
    if (!binding) { pending.push(event); return; }
    if (event.threadId !== binding.threadId || event.turnId !== binding.turnId) return;
    if (event.item?.type === "userMessage" && event.item.clientId === submissionClientId) acknowledged = true;
    if (!acknowledged) return;
    let messages;
    try { messages = codexHistoryMessages(event.item, binding.turnId, binding.threadId); }
    catch { return; } // Missing native identity cannot become a fabricated message.
    const model=currentModel();
    publish(messages.map(message=>message.role==='user'?message:{...message,
      ...(model?{model,modelSource:'provider' as const}:{}),
      ...(input.reasoning_effort?{reasoningEffort:input.reasoning_effort,reasoningEffortSource:'requested' as const}:{}),
    }));
  };
  return {
    observe,
    bind(threadId: string, turnId: string) {
      binding = { threadId, turnId };
      for (const event of pending.splice(0)) observe(event);
    },
  };
}

async function codexThreadParameters(
  input: RunCodexTurnInput,
  request: (method: string, params: unknown) => Promise<any>,
  threadEnvironment?: Record<string, string>,
) {
  const consultation = input.interactionPolicy === "consultation-only";
  const { CONCIERGE_COMMIT_PROVENANCE: _turnProvenance, ...shellEnvironment } = threadEnvironment || {};
  return {
    cwd: input.cwd,
    runtimeWorkspaceRoots: consultation ? [input.cwd] : [...new Set([input.cwd, ...input.additionalDirs])],
    approvalPolicy: "never",
    ...(consultation ? {
      // turn/start inherits this verified profile; reselecting its name there
      // reloads host config without this request-local permissions table.
      permissions: CONSULTATION_PERMISSION_PROFILE,
      config: { ...codexConsultationConfig((await request("config/read", { cwd: input.cwd, includeLayers: false }))?.config),
        agents: { default_subagent_model: "gpt-6-luna", default_subagent_reasoning_effort: "medium" } },
      ...(!input.sessionUUID ? { dynamicTools: [], environments: [] } : {}),
    } : {
      sandbox: "danger-full-access",
      config: { agents: { default_subagent_model: "gpt-6-luna", default_subagent_reasoning_effort: "medium" },
        ...(input.codexRecovery?{model_reasoning_effort:input.codexRecovery.effort}:{}),
        ...(Object.keys(shellEnvironment).length > 0
          ? { shell_environment_policy: { inherit: "all", set: shellEnvironment } } : {}) },
    }),
    ...(input.model ? { model: input.model } : {}),
  };
}

function verifyCodexConsultationPolicy(input: RunCodexTurnInput, response: any) {
  if (input.interactionPolicy !== "consultation-only") return;
  if (response?.approvalPolicy !== "never"
    || response?.activePermissionProfile?.id !== CONSULTATION_PERMISSION_PROFILE
    || response?.sandbox?.type !== "readOnly" || response.sandbox.networkAccess === true) {
    throw new ProviderCapabilityUnavailableError("consultation", "Codex did not confirm its information-only permission policy.");
  }
}

/**
 * A Codex turn on its own app-server process (an account home bound to this turn). The process is
 * reached through a line transport: a direct child, or an execution host (design 2026-10-07 §2,
 * docs/architecture/EXECUTION-HOST.md), which lets a later coordinator take the run back by
 * replaying the host's record: the predecessor's requests and the server's answers and
 * notifications rebuild the turn's state, and nothing the predecessor sent is sent again.
 */
async function runCodexTurnStdio(input: RunCodexTurnInput): Promise<RunResult> {
  const { prompt, cwd, onProgress, sessionUUID } = input;
  const submissionClientId = input.clientUserMessageId || `slack-concierge:ephemeral:${randomUUID()}`;
  const providerMessages = codexMessageObserver(input, submissionClientId,()=>model);
  let initialInputAcknowledged = false;
  const requestTimeoutMs = input.requestTimeoutMs ?? DEFAULT_CODEX_REQUEST_TIMEOUT_MS;
  const inactivityTimeoutMs = input.inactivityTimeoutMs ?? DEFAULT_CODEX_INACTIVITY_TIMEOUT_MS;
  const shutdownGraceMs = input.shutdownGraceMs ?? DEFAULT_CODEX_SHUTDOWN_GRACE_MS;

  const process_ = codexTransport(input);
  const transport: ClaudeCodeTransport = input.transport
    ?? new SubprocessClaudeCodeTransport(process_.executable, { inactivityMs: inactivityTimeoutMs, shutdownGraceMs });

  let stderr = "";
  let requestId = 0;
  let activeThreadId: string | null = sessionUUID;
  let activeTurnId: string | null = null;
  let durationMs: number | undefined;
  let model: string | undefined;
  let extractedUUID: string | null = sessionUUID;
  let turnSettled = false;
  let terminalReported = false;
  let processClosed = false;
  const toolsUsed: string[] = [];
  const messageParts: string[] = [];
  const finalAnswerParts: string[] = [];
  const submittedSteeringClientIds = new Set<string>();
  const observedSteeringBoundaryClientIds = new Set<string>();
  const recoveredSteering = new Set<string>();
  let latestSubmittedSteeringClientId: string | null = null;
  let suppressOutputUntilSteeringBoundary = false;
  let cancellationReason: ProviderTurnCancelledError | null = null;
  const progressedToolItemIds = new Set<string>();
  const pendingRequests = new Map<number, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout> | undefined;
    onAccepted?: (value: any) => void;
  }>();
  // An adopted run's predecessor's requests, by id, so their answers in the replay are understood.
  const predecessorRequests = new Map<number, { method: string; params: any }>();
  let replaying = !!input.adopted;
  let replayEnded!: () => void;
  const replayDone = new Promise<void>((resolve) => { replayEnded = resolve; });
  if (!replaying) replayEnded();

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

  const textInput = (text: string) => [{ type: "text", text, text_elements: [] }];

  let writeLine: ((line: string, meta?: TransportFrameMeta) => Promise<void>) | null = null;
  let closeInput: () => void = () => {};
  let recordActivity: () => void = () => {};
  let resolveWriter!: () => void;
  const writerReady = new Promise<void>((resolve) => { resolveWriter = resolve; });

  const writeMessage = async (message: unknown, meta?: TransportFrameMeta, afterWrite?: () => void) => {
    await writerReady;
    // Turn and steering rows reach the disk before Codex is told; the barrier keeps call order.
    await ledgerDurable();
    if (processClosed || !writeLine) throw new Error("codex app-server stdin is closed");
    await writeLine(`${JSON.stringify(message)}\n`, meta);
    afterWrite?.();
  };

  const request = (method: string, params: unknown, onAccepted?: (value: any) => void): Promise<any> => {
    const id = ++requestId;
    return new Promise((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject, timeout: undefined, onAccepted });
      // Codex's answer time starts once the request is written, not while the ledger reaches disk
      // or the write waits: a timeout reads as an ambiguous send, so it must follow a real send.
      const armTimeout = () => {
        const pending = pendingRequests.get(id);
        if (!pending) return;
        pending.timeout = setTimeout(() => {
          if (pendingRequests.get(id) !== pending) return;
          pendingRequests.delete(id);
          pending.reject(new Error(`codex app-server ${method} timed out after ${requestTimeoutMs}ms`));
        }, requestTimeoutMs);
      };
      const meta: TransportFrameMeta | undefined = method === "turn/steer" && typeof (params as any)?.clientUserMessageId === "string"
        ? { kind: "steering", clientMessageId: (params as any).clientUserMessageId, commandId: `steer-${(params as any).clientUserMessageId}` }
        : method === "turn/interrupt" ? { kind: "interrupt" } : undefined;
      void writeMessage({ method, id, params }, meta, armTimeout).catch((error) => {
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
      const activity = macSurfaceActivity(toolName, item);
      if (activity) onProgress?.({ type: 'mac_surface_activity', itemId, activity });
    }
    onProgress?.({type:phase==='started'?'tool_started':'tool_finished',toolName,...(itemId?{itemId}:{})});
    if (itemId) {
      if (progressedToolItemIds.has(itemId)) return;
      progressedToolItemIds.add(itemId);
    } else if (phase === "completed" && item.type !== "file_change") {
      return;
    }
    onProgress?.({ type: "tool_use", toolName, ...(itemId ? { itemId } : {}), ...(isCodeEditTool(toolName,item.command??item)?{codeEdit:true}:{}) });
  };
  const reportActivityProgress = (item: any, status: "in_progress" | "complete" | "error") => {
    const activity = codexProgressActivity(item);
    if (!activity) return;
    onProgress?.({ type: "activity", ...activity, status });
  };

  const observeSteeringBoundary = (item: any) => {
    if (item.type !== "userMessage" || typeof item.clientId !== "string") return;
    if (item.clientId === submissionClientId && !initialInputAcknowledged) {
      input.onInputAcknowledged?.();
      initialInputAcknowledged = true;
    }
    if (!submittedSteeringClientIds.has(item.clientId)) return;
    if (observedSteeringBoundaryClientIds.has(item.clientId)) return;
    observedSteeringBoundaryClientIds.add(item.clientId);
    onProgress?.({ type: "steering", clientMessageId: item.clientId });
    if (recoveredSteering.delete(item.clientId)) input.onRecoveredSteering?.(item.clientId, "acknowledged");
    if (item.clientId !== latestSubmittedSteeringClientId) return;
    messageParts.length = 0;
    finalAnswerParts.length = 0;
    suppressOutputUntilSteeringBoundary = false;
  };

  const settleCompletedTurn = (completedTurn: any, threadId: string | null) => {
    for (const item of completedTurn.items || []) {
      observeSteeringBoundary(item);
      providerMessages.observe({ threadId: threadId ?? activeThreadId!, turnId: completedTurn.id, item });
    }
    activeTurnId = completedTurn.id || activeTurnId;
    reportProviderTerminal();
    if (turnSettled) return;
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
  };

  const handleNotification = (event: any) => {
    const params = event.params || {};
    switch (event.method) {
      case "account/rateLimits/updated":
        input.onRateLimits?.(params.rateLimits);
        break;
      case "codex/event/token_count":
        input.onRateLimits?.(params.msg?.rate_limits);
        break;
      case "model/rerouted":
        if (params.threadId === activeThreadId && params.turnId === activeTurnId
            && typeof params.toModel === "string" && params.toModel.trim()) model = params.toModel.trim();
        break;
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
        providerMessages.observe(params);
        if ((!activeThreadId || params.threadId === activeThreadId) && (!activeTurnId || params.turnId === activeTurnId)) {
          observeSteeringBoundary(params.item || {});
          reportToolProgress(params.item || {}, "started");
          reportActivityProgress(params.item || {}, "in_progress");
        }
        break;
      case "item/completed": {
        providerMessages.observe(params);
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
        settleCompletedTurn(completedTurn, params.threadId);
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

  /** The answer to a request the predecessor made, met again in the replay. */
  const recoverPredecessorAnswer = (id: number, result: any) => {
    const asked = predecessorRequests.get(id);
    if (!asked) return;
    if ((asked.method === "thread/start" || asked.method === "thread/resume") && typeof result?.thread?.id === "string") {
      activeThreadId = result.thread.id;
      extractedUUID = result.thread.id;
      if (typeof result?.model === "string") model = result.model.trim() || model;
    }
    if (asked.method === "turn/start" && typeof result?.turn?.id === "string") activeTurnId = result.turn.id;
  };

  const handleLine = (line: string) => {
    if (!line.trim()) return;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (Object.prototype.hasOwnProperty.call(ev, "id") && ("result" in ev || "error" in ev)) {
      const pending = pendingRequests.get(Number(ev.id));
      if (!pending) {
        if (replaying && !ev.error) recoverPredecessorAnswer(Number(ev.id), ev.result);
        return;
      }
      recordActivity();
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
      // A server request in the history is answered only if the record shows no answer from the
      // predecessor; those still open are answered once, after the replay (unansweredServerRequests).
      if (replaying) { unansweredServerRequests.set(String(ev.id), ev.method); return; }
      recordActivity();
      void writeMessage({
        id: ev.id,
        error: { code: -32601, message: `Slack Concierge cannot answer server request ${ev.method}.` },
      }).catch(() => {});
    } else if (ev.method) {
      if (!replaying) recordActivity();
      handleNotification(ev);
    }
  };

  /** A request the predecessor wrote to this same process, replayed from the host's record. */
  const unansweredServerRequests = new Map<string, string>();
  const recoverPredecessorRequest = (line: string, meta: TransportFrameMeta | null) => {
    let message: any;
    try { message = JSON.parse(line); } catch { return; }
    if (message && Object.prototype.hasOwnProperty.call(message, "id") && !message.method && ("result" in message || "error" in message))
      unansweredServerRequests.delete(String(message.id));
    if (typeof message?.id === "number") {
      requestId = Math.max(requestId, message.id);
      if (typeof message.method === "string") predecessorRequests.set(message.id, { method: message.method, params: message.params });
    }
    if (message?.method === "turn/steer" && typeof message.params?.clientUserMessageId === "string") {
      submittedSteeringClientIds.add(message.params.clientUserMessageId);
      latestSubmittedSteeringClientId = message.params.clientUserMessageId;
      if (meta?.kind === "steering") recoveredSteering.add(message.params.clientUserMessageId);
    }
    if (message?.method === "turn/interrupt") cancellationReason ??= new ProviderTurnCancelledError();
  };

  const handleProcessFailure = (error: unknown) => {
    const failure = error instanceof Error ? error : new Error(String(error));
    rejectPendingRequests(failure);
    if (!turnStartSettled) {
      turnStartSettled = true;
      rejectTurnStarted(failure);
    }
    if (activeTurnId) rejectActiveTurn(failure);
  };

  let stdoutRest = "";
  const processRun = transport.run({
    args: process_.args, cwd, environment: input.environment, stdin: input.adopted ? "" : `${JSON.stringify({ method: "initialize", id: ++requestId, params: {
      clientInfo: { name: "slack_concierge", title: "Slack Concierge", version: "0.2.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    } })}\n`,
    onStdout: (chunk) => {
      stdoutRest += chunk;
      // Only a chunk that ends a line needs the split; see the Claude runner's stdout reader.
      if (!chunk.includes("\n")) return;
      const lines = stdoutRest.split("\n");
      stdoutRest = lines.pop() || "";
      for (const line of lines) handleLine(line);
    },
    onStderr: (chunk) => { stderr += chunk; },
    onStdinReady: (write, close) => { writeLine = write; closeInput = close; resolveWriter(); },
    onProtocolActivityReady: (record) => { recordActivity = record; },
    onReplayedInput: (line, meta) => recoverPredecessorRequest(line, meta),
    onReplayEnd: () => {
      replaying = false;
      for (const [id, method] of unansweredServerRequests) void writeMessage({
        id: Number.isNaN(Number(id)) ? id : Number(id),
        error: { code: -32601, message: `Slack Concierge cannot answer server request ${method}.` },
      }).catch(() => {});
      unansweredServerRequests.clear();
      replayEnded();
    },
  });
  const processClose = processRun.then(
    (exit) => {
      processClosed = true;
      const failure = new Error(`codex app-server exited ${exit.code}: ${stderr.slice(0, 800) || "(no stderr)"}`);
      rejectPendingRequests(failure);
      if (!turnStartSettled) {
        turnStartSettled = true;
        rejectTurnStarted(failure);
      }
      if (activeTurnId && !turnSettled) rejectActiveTurn(failure);
      replayEnded();
    },
    (error) => { processClosed = true; handleProcessFailure(error); replayEnded(); },
  );

  const terminateProcess = async () => {
    if (processClosed) return;
    closeInput();
    await processClose;
  };

  // The initialize request in a launch is the process's opening input; its answer arrives as any other.
  const initializing = input.adopted ? null : new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { pendingRequests.delete(1); reject(new Error(`codex app-server initialize timed out after ${requestTimeoutMs}ms`)); }, requestTimeoutMs);
    pendingRequests.set(1, { resolve: () => resolve(), reject, timeout });
  });

  try {
    let threadId: string;
    if (input.adopted) {
      // Taken back after a Concierge restart: the record rebuilt the thread, turn and anything already
      // finished. What it does not settle is read from the thread's own history, never re-requested.
      await replayDone;
      if (!activeThreadId) throw new ProviderDispatchError({ message: "The Codex thread an earlier Concierge started is not in its record.", terminalConfirmed: false, toolsUsed, providerSessionId: null });
      threadId = activeThreadId;
      if (!turnSettled) {
        const history = await request("thread/read", { threadId, includeTurns: true });
        const turns = Array.isArray(history?.thread?.turns) ? history.thread.turns : [];
        const turn = turns.find((candidate: any) => candidate?.id === activeTurnId)
          ?? turns.find((candidate: any) => (Array.isArray(candidate?.items) ? candidate.items : []).some((item: any) => item?.type === "userMessage" && item?.clientId === submissionClientId));
        if (!turn) throw new ProviderDispatchError({ message: "The Codex turn an earlier Concierge started is not in its thread's history.", terminalConfirmed: false, toolsUsed, providerSessionId: threadId });
        activeTurnId = turn.id;
        providerMessages.bind(threadId, turn.id);
        if (turn.status && turn.status !== "inProgress") settleCompletedTurn(turn, threadId);
        else if (!turnStartSettled) { turnStartSettled = true; onProgress?.({ type: "started" }); resolveTurnStarted(); }
      }
    } else {
      await initializing;
      await notify("initialized");

      const threadParams = await codexThreadParameters(input, request, input.environment);
      const threadResponse = sessionUUID
        ? await request("thread/resume", { threadId: sessionUUID, ...threadParams, excludeTurns: true })
        : await request("thread/start", threadParams);
      verifyCodexConsultationPolicy(input, threadResponse);
      threadId = threadResponse?.thread?.id || sessionUUID;
      model = typeof threadResponse?.model === "string" ? threadResponse.model.trim() || undefined : undefined;
      if (!threadId) throw new Error("codex app-server did not return a thread id");
      activeThreadId = threadId;
      extractedUUID = threadId;
      input.onProviderThreadStarted?.(threadId);

      const turnResponse = await request("turn/start", {
        threadId,
        input: textInput(prompt),
        clientUserMessageId: submissionClientId,
        ...(input.reasoning_effort ? { effort: input.reasoning_effort } : {}),
        ...(input.interactionPolicy === "consultation-only" ? { environments: [] } : {}),
        ...turnAdditionalContext(input.applicationInstructions),
      });
      activeTurnId = turnResponse?.turn?.id || activeTurnId;
      if (!activeTurnId) throw new Error("codex app-server did not return a turn id");
      input.onProviderTurnStarted?.(activeTurnId);
      if (typeof turnResponse?.turn?.id === "string") providerMessages.bind(threadId, turnResponse.turn.id);
    }
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
    rejectPendingRequests(new Error("codex app-server turn ended before the request completed"));
    for (const clientId of recoveredSteering) input.onRecoveredSteering?.(clientId, "unacknowledged");
    await terminateProcess();
  }

  const { text, mark: turnOutcome } = splitTurnOutcomeMarker((finalAnswerParts.length ? finalAnswerParts : messageParts).join("\n\n").trim());
  if (!initialInputAcknowledged && !messageParts.some(part=>part.trim()) && !finalAnswerParts.some(part=>part.trim()) && toolsUsed.length === 0) {
    throw new ProviderDispatchError({message: `CODEX_INPUT_NOT_ACKNOWLEDGED: Codex completed native turn ${activeTurnId ?? "unknown"} without acknowledging Concierge's accepted input or producing output. The original input is preserved; exact transcript proof is required before recovery.`,
      failureClass:"parked_terminal",terminalConfirmed:true,toolsUsed,assistantOutput:false,
      providerSessionId:extractedUUID,providerTurnId:activeTurnId});
  }
  return {
    text,
    sessionUUID: extractedUUID,
    toolsUsed,
    providerTurnId: activeTurnId,
    ...(model ? { model } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(turnOutcome ? { turnOutcome } : {}),
  };
}

async function runCodexTurnShared(input: RunCodexTurnInput): Promise<RunResult> {
  const { prompt, cwd, onProgress, sessionUUID } = input;
  let initialInputAcknowledged = false;
  const requestTimeoutMs = input.requestTimeoutMs ?? DEFAULT_CODEX_REQUEST_TIMEOUT_MS;
  const inactivityTimeoutMs = input.inactivityTimeoutMs ?? DEFAULT_CODEX_INACTIVITY_TIMEOUT_MS;
  const client = input.appServerClient ?? sharedCodexAppServerClient();
  const submissionClientId = input.clientUserMessageId
    ?? `slack-concierge:ephemeral:${randomUUID()}`;
  const providerMessages = codexMessageObserver(input, submissionClientId,()=>model);
  // The app-server shell policy belongs to the durable thread, while commit
  // provenance belongs to one turn. The Git hook resolves that value from the
  // live CODEX_THREAD_ID so a resumed thread cannot retain an older turn token.
  // The same holds for a run's network token and owner address (docs/architecture/RUNNERS.md): a
  // thread keeps them for its whole life, past the token's expiry and the owner's moves. Helpers in
  // a Codex shell instead use the runner's own address and token file, which the runner's App
  // Server carries in its environment (router-request-client.ts).
  const {
    CONCIERGE_COMMIT_PROVENANCE: _turnScopedCommitProvenance,
    CONCIERGE_AGENT_TOKEN: _turnScopedAgentToken,
    CONCIERGE_OWNER_URL: _ownerAddressOfThisTurn,
    ...threadEnvironment
  } = input.environment || {};
  let connectionGeneration: number | null = null;
  let activeThreadId: string | null = sessionUUID;
  let activeTurnId: string | null = null;
  let durationMs: number | undefined;
  let model: string | undefined;
  let extractedUUID: string | null = sessionUUID;
  let turnSubmissionAttempted = false;
  let turnSettled = false;
  let adoptedTerminalObserved = false;
  let terminalReported = false;
  let providerTurnReported = false;
  let interruptionReason: Error | null = null;
  let recoveryCause: Error | null = null;
  let unconfirmedFailure: ProviderDispatchError | null = null;
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
  const recoveryParams=(method:string,params:unknown)=>input.codexRecovery&&['thread/resume','turn/start','turn/interrupt'].includes(method)
    ?{...(params as Record<string,unknown>),__conciergeRecovery:input.codexRecovery}:params;
  const request = async (
    method: string,
    params: unknown,
    onAccepted?: (value: any) => void,
  ) => {
    // Turn and steering rows reach the disk before Codex is told, and before the answer timer
    // starts; the barrier releases in call order, so requests keep theirs.
    await ledgerDurable();
    const result = await client.request(method, recoveryParams(method,params), { requestTimeoutMs, onAccepted });
    resetInactivityTimeout();
    return result;
  };
  let stopBeforeSubmission!: (error: Error) => void;
  const stoppedBeforeSubmission = new Promise<never>((_resolve, reject) => { stopBeforeSubmission = reject; });
  void stoppedBeforeSubmission.catch(() => {});
  const resumeNoticeAfterMs = input.resumeNoticeAfterMs ?? CODEX_RESUME_NOTICE_AFTER_MS;
  const reportResumeWait = (wait: CodexResumeWait) => {
    try { input.onResumeUnanswered?.(wait); }
    catch (error) { log("error", "codex_resume_notice_failed", { provider_thread_uuid: wait.providerThreadId, ...errorFields(error) }); }
  };
  // A resume waits for its answer with no deadline. Logged every request period, and once past
  // the notice bound it becomes a repair notice, so a server that holds its socket open but never
  // answers reaches the repair agent instead of hanging unseen. Returns the wait's end.
  // Every wait ends when the turn ends, even one whose resume never settles (a hung recovery
  // resume when the turn is parked), so no timer outlives its turn or reports it as waiting.
  const activeResumeWatches = new Set<() => void>();
  const watchResume = (threadId: string) => {
    const startedAtMs = Date.now();
    let noticed = false;
    const slow = setInterval(() => log("warn", "codex_resume_waiting", {
      provider_thread_uuid: threadId, waited_ms: Date.now() - startedAtMs,
    }), requestTimeoutMs);
    const notice = setTimeout(() => {
      noticed = true;
      const waitedMs = Date.now() - startedAtMs;
      log("error", "codex_resume_unanswered", { provider_thread_uuid: threadId, waited_ms: waitedMs });
      reportResumeWait({ providerThreadId: threadId, startedAtMs, waitedMs, state: "waiting" });
    }, resumeNoticeAfterMs);
    const end = () => {
      if (!activeResumeWatches.delete(end)) return;
      clearInterval(slow);
      clearTimeout(notice);
      if (noticed) reportResumeWait({ providerThreadId: threadId, startedAtMs, waitedMs: Date.now() - startedAtMs, state: "ended" });
    };
    activeResumeWatches.add(end);
    return end;
  };
  const resumeUntilAnswered = async (threadId: string, params: unknown) => {
    await ledgerDurable();
    if (interruptionReason) throw interruptionReason;
    const endWatch = watchResume(threadId);
    try {
      const result = await Promise.race([
        client.request("thread/resume", recoveryParams('thread/resume',params), { untilDisconnect: true }),
        stoppedBeforeSubmission,
      ]);
      resetInactivityTimeout();
      return result;
    } finally {
      endWatch();
    }
  };
  const textInput = (text: string) => [{ type: "text", text, text_elements: [] }];

  const reportProviderTerminal = (status:string) => {
    if (terminalReported) return;
    terminalReported = true;
    input.onProviderTerminal?.({providerThreadId:activeThreadId,providerTurnId:activeTurnId,status});
  };
  const describeFailure = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return error instanceof CodexAppServerClientError && Number.isFinite(error.code)
      ? `${message} (JSON-RPC code ${error.code})` : message;
  };
  const parkUnconfirmedTurn = (error: unknown) => {
    if (unconfirmedFailure) return unconfirmedFailure;
    const message = [recoveryCause ? `Original Codex failure: ${describeFailure(recoveryCause)}` : null,
      `Codex turn outcome remains unconfirmed: ${describeFailure(error)}`].filter(Boolean).join(". ");
    unconfirmedFailure = new ProviderDispatchError({ message, terminalConfirmed: false,
      toolsUsed, providerSessionId: activeThreadId, providerTurnId: activeTurnId });
    turnSettled = true;
    stopInactivityTimeout();
    rejectTurn(unconfirmedFailure);
    log("error", "codex_turn_reconciliation_failed", { ...errorFields(unconfirmedFailure),
      provider_thread_uuid: activeThreadId, provider_turn_id: activeTurnId, client_user_message_id: submissionClientId });
    return unconfirmedFailure;
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
      const activity = macSurfaceActivity(toolName, item);
      if (activity) onProgress?.({ type: 'mac_surface_activity', itemId, activity });
    }
    onProgress?.({type:phase==='started'?'tool_started':'tool_finished',toolName,...(itemId?{itemId}:{})});
    if (itemId) {
      if (progressedToolItemIds.has(itemId)) return;
      progressedToolItemIds.add(itemId);
    } else if (phase === "completed" && item.type !== "file_change") {
      return;
    }
    onProgress?.({ type: "tool_use", toolName, ...(itemId ? { itemId } : {}), ...(isCodeEditTool(toolName,item.command??item)?{codeEdit:true}:{}) });
  };
  const reportActivityProgress = (item: any, status: "in_progress" | "complete" | "error") => {
    const activity = codexProgressActivity(item);
    if (!activity) return;
    onProgress?.({ type: "activity", ...activity, status });
  };
  const recoveredSteering = new Set(input.recoveredSteeringClientIds ?? []);
  for (const clientId of recoveredSteering) submittedSteeringClientIds.add(clientId);
  const observeSteeringBoundary = (item: any) => {
    if (item.type !== "userMessage" || typeof item.clientId !== "string") return;
    if (item.clientId === submissionClientId && !initialInputAcknowledged) {
      input.onInputAcknowledged?.();
      initialInputAcknowledged = true;
    }
    if (!submittedSteeringClientIds.has(item.clientId)) return;
    if (observedSteeringBoundaryClientIds.has(item.clientId)) return;
    observedSteeringBoundaryClientIds.add(item.clientId);
    onProgress?.({ type: "steering", clientMessageId: item.clientId });
    if (recoveredSteering.delete(item.clientId)) input.onRecoveredSteering?.(item.clientId, "acknowledged");
    if (item.clientId !== latestSubmittedSteeringClientId) return;
    messageParts.length = 0;
    finalAnswerParts.length = 0;
    suppressOutputUntilSteeringBoundary = false;
  };
  const recordCompletedItem = (item: any) => {
    if (activeThreadId && activeTurnId) providerMessages.observe({ threadId: activeThreadId, turnId: activeTurnId, item });
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
  const settleFromTurn = (turn: any, itemsRecorded = false) => {
    if (turnSettled) return;
    if (typeof turn?.id === "string") activeTurnId = turn.id;
    reportTurnStarted();
    if (!itemsRecorded) for (const item of Array.isArray(turn?.items) ? turn.items : []) recordCompletedItem(item);
    if (!turn?.status || turn.status === "inProgress") return;
    durationMs = codexTurnDurationMs(turn);
    reportProviderTerminal(turn.status);
    turnSettled = true;
    if (interruptionReason) {
      rejectTurn(interruptionReason);
    } else if (turn.status !== "completed") {
      rejectTurn(new ProviderDispatchError({
        message: turn.error?.message || `Codex turn ended with status ${turn.status}.`,
        terminalConfirmed: true,
        modelAtCapacity: turn.error?.codexErrorInfo === "serverOverloaded",
        toolsUsed,
        assistantOutput: messageParts.some(part => part.trim().length > 0),
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
    if (turnSettled || controllerClosed) return;
    const params = event.params || {};
    if (event.method === "account/rateLimits/updated" || event.method === "codex/event/token_count") {
      input.onRateLimits?.(event.method === "account/rateLimits/updated" ? params.rateLimits : params.msg?.rate_limits);
      return;
    }
    const eventTurnId = event.method === "turn/started"
      ? params.turn?.id
      : event.method === "turn/completed"
        ? params.turn?.id
        : ["item/started", "item/completed", "model/rerouted"].includes(event.method)
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
      case "model/rerouted":
        if (params.threadId === activeThreadId && params.turnId === activeTurnId
            && typeof params.toModel === "string" && params.toModel.trim()) model = params.toModel.trim();
        return;
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
        providerMessages.observe(params);
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
        if (input.adoptTurn) {
          adoptedTerminalObserved = true;
          void ensureRecovered();
          return;
        }
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
    if (activeThreadId) providerMessages.bind(activeThreadId, turnId);
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
  // An adopted turn that its thread's history never shows did not reach the daemon from here, so
  // following it cannot end by waiting; a turn this run submitted itself keeps the open search.
  let adoptedSearchesLeft = input.adoptTurn ? 20 : Infinity;
  let adoptedLiveReported = false;
  const reconcileAcceptedTurn = async () => {
    stopInactivityTimeout();
    let retryMs = 100;
    while (!turnSettled && !controllerClosed) {
      try {
        if (!activeThreadId) throw new Error("Cannot reconcile a Codex turn without its thread id.");
        connectionGeneration = await client.connect();
        if (turnSettled || controllerClosed) return;
        const recoveredInput = { ...input, sessionUUID: activeThreadId };
        const recoveredParams = await codexThreadParameters(recoveredInput,
          (method, params) => client.request(method, params, { requestTimeoutMs }), threadEnvironment);
        if (turnSettled || controllerClosed) return;
        // Recovery retries this loop until it settles, so a deadline here only stacked cold loads.
        const endWatch = watchResume(activeThreadId);
        const resumed = input.codexRecovery?null:await client.request("thread/resume", {
          threadId: activeThreadId,
          ...recoveredParams,
          excludeTurns: true,
        }, { untilDisconnect: true }).finally(endWatch);
        if(input.codexRecovery)endWatch();
        if (turnSettled || controllerClosed) return;
        if(resumed)verifyCodexConsultationPolicy(input, resumed);
        // Full thread hydration can materialize hundreds of megabytes for every adopted run.
        // Find the exact turn in summary pages; only a terminal turn's persisted item pages
        // can prove a complete replay across both legacy and paginated history modes.
        let turn: any = null;
        let turnCursor: string | null = null;
        do {
          const page = await client.request("thread/turns/list", {
            threadId: activeThreadId, cursor: turnCursor, limit: 20,
            sortDirection: "desc", itemsView: "summary",
          }, { requestTimeoutMs });
          if (turnSettled || controllerClosed) return;
          if (!Array.isArray(page?.data)) throw new Error("Codex did not return a turn page.");
          turn = matchingTurn(page.data);
          if (turn) break;
          const nextCursor = typeof page.nextCursor === "string" ? page.nextCursor : null;
          if (nextCursor && nextCursor === turnCursor) throw new Error("Codex repeated a turn cursor.");
          turnCursor = nextCursor;
        } while (turnCursor);
        if (!turn) {
          if (--adoptedSearchesLeft <= 0) {
            if (recoveryMustInterrupt) {
              // Stop on adopted work is never proof that the daemon stopped. If its exact turn
              // cannot be found by retained identity, keep the accepted work visibly uncertain.
              parkUnconfirmedTurn(new Error("The stopped Codex turn is not confirmed in its thread's history."));
              return;
            }
            // Codex records a turn's user message when it accepts turn/start. A turn that never got
            // a provider turn id and that the thread's whole history still lacks after every search
            // never reached Codex, so sending it again repeats nothing: it is retried, not parked.
            if (!input.adoptTurn?.turnId && !activeTurnId) {
              turnSettled = true;
              stopInactivityTimeout();
              log("warn", "codex_adopted_turn_never_landed", { provider_thread_uuid: activeThreadId,
                client_user_message_id: submissionClientId });
              rejectTurn(new ProviderDispatchError({ failureClass: "retryable", terminalConfirmed: true,
                message: "The Codex turn never reached Codex: its thread's history has no message from it.",
                toolsUsed, providerSessionId: activeThreadId, threadScoped: true }));
              return;
            }
            parkUnconfirmedTurn(new Error("The Codex turn an earlier Concierge started is not in its thread's history."));
            return;
          }
          await waitForRecoveryRetry(retryMs);
          retryMs = Math.min(retryMs * 2, 5_000);
          continue;
        }
        if (typeof turn.id === "string") acceptActiveTurnId(turn.id);
        const stillRunning = !turn?.status || turn.status === "inProgress";
        if (stillRunning) {
          // A live paginated turn can have items only in Codex memory. Its first user item
          // proves receipt; later notifications and terminal persisted history carry output.
          for (const item of Array.isArray(turn.items) ? turn.items : [])
            if (item?.type === "userMessage") recordCompletedItem(item);
        } else {
          let itemCursor: string | null = null;
          do {
            const page = await client.request("thread/items/list", {
              threadId: activeThreadId, turnId: turn.id, cursor: itemCursor,
              limit: RECOVERED_ITEMS_PER_STEP, sortDirection: "asc",
            }, { requestTimeoutMs });
            if (turnSettled || controllerClosed) return;
            if (!Array.isArray(page?.data) || page.data.some((entry: any) => entry?.turnId !== turn.id))
              throw new Error("Codex did not return the exact turn's item page.");
            for (const entry of page.data) recordCompletedItem(entry.item);
            await new Promise<void>((resolve) => setImmediate(resolve));
            if (turnSettled || controllerClosed) return;
            const nextCursor = typeof page.nextCursor === "string" ? page.nextCursor : null;
            if (nextCursor && nextCursor === itemCursor) throw new Error("Codex repeated an item cursor.");
            itemCursor = nextCursor;
          } while (itemCursor);
        }
        settleFromTurn(turn, true);
        if (input.adoptTurn && stillRunning && !adoptedLiveReported) { adoptedLiveReported = true; input.onAdoptedLive?.(); }
        if (turnSettled) return;
        if (recoveryMustInterrupt && activeTurnId) {
          try {
            await client.request("turn/interrupt", recoveryParams('turn/interrupt',{
              threadId: activeThreadId,
              turnId: activeTurnId,
            }), { requestTimeoutMs });
          } catch {
            // The interrupt response is non-atomic with the daemon state. The
            // next exact history read, not the transport outcome, is decisive.
          }
          await waitForRecoveryRetry(retryMs);
          retryMs = Math.min(retryMs * 2, 5_000);
          continue;
        }
        if (adoptedTerminalObserved) {
          await waitForRecoveryRetry(retryMs);
          retryMs = Math.min(retryMs * 2, 5_000);
          continue;
        }
        resetInactivityTimeout();
        return;
      } catch (error) {
        if (turnSettled || controllerClosed) return;
        if (error instanceof ProviderCapabilityUnavailableError
          || (error instanceof CodexAppServerClientError && Number.isFinite(error.code))) {
          parkUnconfirmedTurn(error);
          return;
        }
        stopInactivityTimeout();
        await waitForRecoveryRetry(retryMs);
        retryMs = Math.min(retryMs * 2, 5_000);
      }
    }
  };
  const ensureRecovered = (cause?: unknown) => {
    if (cause && !recoveryCause) recoveryCause = cause instanceof Error ? cause : new Error(String(cause));
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
      void ensureRecovered(interruptionReason);
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
      if (turnSubmissionAttempted && activeThreadId) void ensureRecovered(error);
    }
  });
  const unsubscribeDisconnect = client.onDisconnect((error, generation) => {
    if (connectionGeneration !== generation) return;
    stopInactivityTimeout();
    if (turnSubmissionAttempted && activeThreadId) {
      void ensureRecovered(error);
      return;
    }
    // Before turn/start nothing has been sent: the request or connect that was waiting rejects on
    // its own and is waited out below, so the turn's start is not failed here (2026-11-12).
  });
  try {
    if (input.adoptTurn) {
      // Adoption means the provider may already be acting. Establish its retained identity before
      // registering cancellation, whose callback can run synchronously for a retained Stop.
      activeThreadId = input.adoptTurn.threadId;
      extractedUUID = input.adoptTurn.threadId;
      turnSubmissionAttempted = true;
      if (input.adoptTurn.turnId) acceptActiveTurnId(input.adoptTurn.turnId);
    }
    input.onCancellationReady?.(async () => {
      if (unconfirmedFailure) throw unconfirmedFailure;
      if (turnSettled) return;
      interruptionReason = new ProviderTurnCancelledError();
      recoveryMustInterrupt = true;
      if (input.adoptTurn) {
        // Let exact-history recovery reconnect and discover a missing turn id by the retained
        // client message identity. Callback completion alone does not prove provider termination.
        await ensureRecovered(interruptionReason);
        if (unconfirmedFailure) throw unconfirmedFailure;
        return;
      }
      if (!turnSubmissionAttempted) { stopBeforeSubmission(interruptionReason); return; }
      if (!activeThreadId || !activeTurnId) {
        throw parkUnconfirmedTurn(new Error("Stop requested before Codex confirmed an exact provider turn; cancellation is not confirmed."));
      }
      try {
        await request("turn/interrupt", { threadId: activeThreadId, turnId: activeTurnId });
      } catch (error) {
        if (unconfirmedFailure) throw unconfirmedFailure;
        if (turnSettled) return;
        throw parkUnconfirmedTurn(error);
      }
    });
    // Nothing reaches Codex before turn/start, so a connection lost before it is waited out on this
    // same attempt: no retry budget spent, nothing parked. On 2026-11-12 the App Server restarted
    // for an account switch while 36 released turns were connecting; the lost connection escaped
    // as an unknown send and all 36 were parked as possibly sent, 10 of them for 50 minutes.
    let reconnectWaitMs = 1_000;
    const waitOutLostConnection = async (error: unknown) => {
      if (interruptionReason) throw interruptionReason;
      if (!isLostCodexConnection(error)) throw error;
      log("warn", "codex_connection_lost_before_submission", { ...errorFields(error),
        wait_ms: reconnectWaitMs, client_user_message_id: submissionClientId });
      await Promise.race([new Promise<void>((resolve) => setTimeout(resolve, reconnectWaitMs)), stoppedBeforeSubmission]);
      reconnectWaitMs = Math.min(reconnectWaitMs * 2, 30_000);
    };
    const connectBeforeSubmission = async (): Promise<number> => {
      for (;;) {
        try {
          // The shared App Server may still be unreachable after a restart; the turn waits for it
          // (Stop still ends the wait) rather than failing or being parked unsent.
          if (!input.appServerClient) await Promise.race([codexAppServerReady(), stoppedBeforeSubmission]);
          if (interruptionReason) throw interruptionReason;
          return await Promise.race([client.connect(), stoppedBeforeSubmission]);
        } catch (error) {
          await waitOutLostConnection(error);
        }
      }
    };
    let threadId: string;
    if (input.adoptTurn) {
      // Taken back after a Concierge restart: the daemon kept the turn. Its exact history settles it
      // or shows it still running, and live notifications continue from there; nothing is resubmitted.
      threadId = activeThreadId!;
      activeThreadId = threadId;
      extractedUUID = threadId;
      await Promise.race([ensureRecovered(), turnCompletion]);
    } else {
    connectionGeneration = await connectBeforeSubmission();
    let threadResponse: any;
    for (;;) try {
    if (interruptionReason) throw interruptionReason;
    const threadParams = await codexThreadParameters(input, request, threadEnvironment);
    if (interruptionReason) throw interruptionReason;
      // A turn reads only the thread's id, model and policy from this answer, so it never asks
      // for history. A cold resume still loads the whole rollout before answering, which on
      // 2026-11-04 took minutes for a 218 MB conversation on a swapping host. Giving up at a
      // deadline and asking again only stacked more loads and ended in a refused turn, so the
      // turn waits for this answer while the connection lives; Stop ends it, and a lost
      // connection is waited out and the answer asked for again.
      threadResponse = sessionUUID
        ? await resumeUntilAnswered(sessionUUID, { threadId: sessionUUID, ...threadParams, excludeTurns: true })
        : await request("thread/start", threadParams);
      break;
    } catch (error) {
      // Neither operation sends the user's input. Even if the App Server created or
      // resumed a thread before the response was lost, asking again cannot repeat
      // the requested work because turn/start has not been called yet. A lost
      // connection is the daemon's: wait it out and ask again on this attempt.
      if (isLostCodexConnection(error)) {
        await waitOutLostConnection(error);
        connectionGeneration = await connectBeforeSubmission();
        continue;
      }
      if (error instanceof CodexAppServerClientError && error.outcome === "ambiguous") {
        throw new ProviderDispatchError({ message: error.message, terminalConfirmed: true,
          failureClass: "retryable", toolsUsed,
          // A disconnect is the daemon's, not this thread's; only an unanswered resume is.
          threadScoped: Boolean(sessionUUID) && error instanceof CodexAppServerUnansweredError });
      }
      throw error;
    }
    verifyCodexConsultationPolicy(input, threadResponse);
    threadId = threadResponse?.thread?.id || sessionUUID;
    model = typeof threadResponse?.model === "string" ? threadResponse.model.trim() || undefined : undefined;
    if (!threadId) throw new Error("codex app-server did not return a thread id");
    activeThreadId = threadId;
    extractedUUID = threadId;
    input.onProviderThreadStarted?.(threadId);
    if (interruptionReason) throw interruptionReason;

    turnSubmissionAttempted = true;
    try {
      const starting = request("turn/start", {
        threadId,
        input: textInput(prompt),
        ...(input.codexRecovery?{model:input.codexRecovery.model}:{}),
        clientUserMessageId: submissionClientId,
        ...(input.reasoning_effort ? { effort: input.reasoning_effort } : {}),
        ...(input.interactionPolicy === "consultation-only" ? { environments: [] } : {}),
        ...turnAdditionalContext(input.applicationInstructions),
      }).catch(error => {
        recoveryCause = error instanceof Error ? error : new Error(String(error));
        log("error", "codex_turn_start_failed", { ...errorFields(error),
          rpc_method: "turn/start", rpc_error_code: error instanceof CodexAppServerClientError ? error.code ?? null : null,
          provider_thread_uuid: activeThreadId, client_user_message_id: submissionClientId });
        throw error;
      });
      const turnResponse = await Promise.race([starting, turnCompletion]);
      const returnedTurnId = turnResponse?.turn?.id || activeTurnId;
      if (!returnedTurnId) throw new Error("codex app-server did not return a turn id");
      acceptActiveTurnId(returnedTurnId);
      resetInactivityTimeout();
    } catch (error) {
      if (turnSettled) throw error;
      if (error instanceof CodexAppServerClientError && error.outcome === "rejected") {
        const detail=error.data as {codex_error_info?:unknown;codexErrorInfo?:unknown}|null;
        throw new ProviderDispatchError({message:error.message,terminalConfirmed:true,
          modelAtCapacity:detail?.codex_error_info==='server_overloaded'||detail?.codexErrorInfo==='serverOverloaded'});
      }
      await Promise.race([ensureRecovered(error), turnCompletion]);
    }
    }
    await Promise.race([turnStarted, turnCompletion]);

    if (!turnSettled) {
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
    for (const endWatch of [...activeResumeWatches]) endWatch();
    stopInactivityTimeout();
    unsubscribeNotifications();
    unsubscribeDisconnect();
    for (const clientId of recoveredSteering) input.onRecoveredSteering?.(clientId, "unacknowledged");
  }

  const { text, mark: turnOutcome } = splitTurnOutcomeMarker((finalAnswerParts.length ? finalAnswerParts : messageParts).join("\n\n").trim());
  if (!initialInputAcknowledged && !messageParts.some(part=>part.trim()) && !finalAnswerParts.some(part=>part.trim()) && toolsUsed.length === 0) {
    throw new ProviderDispatchError({message: `CODEX_INPUT_NOT_ACKNOWLEDGED: Codex completed native turn ${activeTurnId ?? "unknown"} without acknowledging Concierge's accepted input or producing output. The original input is preserved; exact transcript proof is required before recovery.`,
      failureClass:"parked_terminal",terminalConfirmed:true,toolsUsed,assistantOutput:false,
      providerSessionId:extractedUUID,providerTurnId:activeTurnId});
  }
  return {
    text,
    sessionUUID: extractedUUID,
    toolsUsed,
    providerTurnId: activeTurnId,
    ...(model ? { model } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(turnOutcome ? { turnOutcome } : {}),
  };
}

/**
 * A connection that went away, as opposed to an answer: only a transport loss is waited out before
 * turn/start. A JSON-RPC error carries the App Server's code and is its answer (a missing rollout
 * would fail the same way forever); a closed client is Concierge stopping; an unanswered request on a
 * live connection belongs to that one conversation. Those keep their counted retries.
 */
function isLostCodexConnection(error: unknown) {
  return error instanceof CodexAppServerClientError && error.outcome === "ambiguous"
    && !Number.isFinite(error.code) && !(error instanceof CodexAppServerUnansweredError)
    && !/app-server (observer|client)( is)? closed\./.test(error.message);
}

export async function runCodexTurn(input: RunCodexTurnInput): Promise<RunResult> {
  assertProviderInteractionPolicy(input.interactionPolicy);
  const attempt = usageAttempt("codex", undefined, input.accountLabel);
  // A turn being taken back is already the daemon's; refusing it on usage would abandon it running.
  if (!input.adoptTurn && !input.adopted && !input.usageProbe) assertUsageAvailable(attempt);
  let resetAt: number | null = null;
  const onRateLimits = input.onRateLimits;
  input = { ...input, onRateLimits(snapshot) {
    const reportedReset = codexUsageReset(snapshot);
    if (reportedReset !== null) resetAt = reportedReset;
    onRateLimits?.(snapshot);
  } };
  if (input.interactionPolicy !== "consultation-only") {
    const environment = providerOwnerEnvironment(input.environment);
    // A runner's App Server gets that runner's folders from the runner (runner-machine.ts), never ours.
    input = { ...input, environment: !input.executable && codexRelayRunner() ? withoutMachinePaths(environment) : environment };
  }
  try {
    const result = await (input.executable ? runCodexTurnStdio(input) : runCodexTurnShared(input));
    recordUsageSuccess(attempt);
    return result;
  } catch (error) {
    if (error instanceof Error && /^you(?:'|’)ve hit your usage limit\b/i.test(error.message)) {
      if (resetAt === null && !input.executable) {
        try {
          const report = await (input.appServerClient ?? sharedCodexAppServerClient())
            .request("account/rateLimits/read", {}, { requestTimeoutMs: 10_000 });
          resetAt = codexUsageReset(report?.rateLimitsByLimitId?.codex ?? report?.rateLimits);
        } catch {
          log("warn", "provider_usage_reset_unavailable", { provider: "codex" });
        }
      }
      recordUsageExhaustion(attempt, resetAt);
    }
    throw error;
  }
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
  interactionPolicy?: ProviderInteractionPolicy;
}): Promise<RunResult> {
  assertProviderForkPolicy(input.interactionPolicy);
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
