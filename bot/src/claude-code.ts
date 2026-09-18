import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { providerOwnerEnvironment } from "./provider-owner-environment";
import { structuredTurnOutcome, TURN_OUTCOME_SCHEMA, type StructuredTurnOutcome } from "./turn-structured-output";
import { claudeHistoryMessages, providerMessageObserver, type ProviderMessageCallback } from "./provider-history";
import { log } from "./log";
import { ProgressCb, RunResult } from "./codex";
import { ProviderDispatchError, ProviderTurnCancelledError, isClaudeUsageExhaustion } from "./provider-failures";
import { SteeringNotSentError, SteeringSender } from "./steering";
import { watchClaudeTranscript, type ClaudeTranscriptPickup } from "./claude-transcript-watch";
import { webActivityDetails } from "./agent-progress";
import { claudeUsageFallbackModels } from "./aliases";
import { assertUsageAvailable, cachedUsageLimit, recordUsageExhaustion, recordUsageSuccess,
  resetEpochMilliseconds, usageAttempt, usageLimitMessage, type UsageAttempt } from "./provider-usage";
import { assertProviderForkPolicy, assertProviderInteractionPolicy, claudeConsultationArgs,
  type ProviderInteractionPolicy } from "./provider-policy";

type JsonValue = Record<string, any>;
const USAGE_FALLBACK_CONTINUATION = "Continue the unfinished user request in this same conversation after the usage-limit interruption. Preserve all prior instructions and completed work; do not repeat completed actions. The accepted user inputs for this turn are replayed verbatim below, oldest first. Later guidance takes priority over earlier input. This is a retry of the same task, not a new request.";

const CLAUDE_PROTOCOL_EVENT_TYPES = new Set([
  "system",
  "user",
  "assistant",
  "result",
  "control_response",
  "control_request",
  "rate_limit_event",
  "keep_alive",
  "tool_progress",
  "tool_use_summary",
  "stream_event",
]);

export interface ClaudeCodeTransport {
  run(input: {
    args: string[];
    cwd: string;
    environment?: Record<string, string>;
    inheritEnvironment?: boolean;
    stdin: string;
    onStdout: (chunk: string) => void;
    onStderr: (chunk: string) => void;
    onStdinReady?: (write: (input: string) => Promise<void>, close: () => void) => void;
    onProtocolActivityReady?: (record: () => void) => void;
  }): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export class SubprocessClaudeCodeTransport implements ClaudeCodeTransport {
  constructor(
    // The env override exists so the isolated sandbox can substitute a scripted
    // CLI for provider-failure acceptance; production units never set it.
    private readonly executable = process.env.CONCIERGE_CLAUDE_CODE_EXECUTABLE || "claude",
    private readonly timeouts: { inactivityMs?: number; shutdownGraceMs?: number } = {},
  ) {}

  run(input: {
    args: string[];
    cwd: string;
    environment?: Record<string, string>;
    inheritEnvironment?: boolean;
    stdin: string;
    onStdout: (chunk: string) => void;
    onStderr: (chunk: string) => void;
    onStdinReady?: (write: (input: string) => Promise<void>, close: () => void) => void;
    onProtocolActivityReady?: (record: () => void) => void;
  }): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    const proc = spawn(this.executable, input.args, {
      cwd: input.cwd,
      env: { ...(input.inheritEnvironment === false ? {} : process.env), ...input.environment },
      stdio: ["pipe", "pipe", "pipe"],
    });

    return new Promise((resolve, reject) => {
      const inactivityMs = this.timeouts.inactivityMs ?? 30 * 60_000;
      const shutdownGraceMs = this.timeouts.shutdownGraceMs ?? 2_000;
      let settled = false;
      let processClosed = false;
      let inputClosing = false;
      let terminationError: Error | null = null;
      let inactivityTimeout: ReturnType<typeof setTimeout> | null = null;
      let terminateTimeout: ReturnType<typeof setTimeout> | null = null;
      let killTimeout: ReturnType<typeof setTimeout> | null = null;
      const clearTimers = () => {
        if (inactivityTimeout) clearTimeout(inactivityTimeout);
        if (terminateTimeout) clearTimeout(terminateTimeout);
        if (killTimeout) clearTimeout(killTimeout);
        inactivityTimeout = null;
        terminateTimeout = null;
        killTimeout = null;
      };
      const scheduleKill = () => {
        if (killTimeout) return;
        killTimeout = setTimeout(() => {
          if (!processClosed) proc.kill("SIGKILL");
        }, shutdownGraceMs);
      };
      const terminateWithError = (error: unknown) => {
        if (terminationError || processClosed) return;
        terminationError = error instanceof Error ? error : new Error(String(error));
        if (inactivityTimeout) clearTimeout(inactivityTimeout);
        inactivityTimeout = null;
        if (!proc.stdin.writableEnded) proc.stdin.end();
        proc.kill("SIGTERM");
        scheduleKill();
      };
      const closeInput = () => {
        if (inputClosing) return;
        inputClosing = true;
        if (!proc.stdin.writableEnded) proc.stdin.end();
        terminateTimeout = setTimeout(() => {
          if (!processClosed) proc.kill("SIGTERM");
          scheduleKill();
        }, shutdownGraceMs);
      };
      const failForInactivity = () => {
        if (settled) return;
        terminateWithError(new Error(`claude-code produced no provider activity for ${inactivityMs}ms`));
      };
      const resetInactivityTimeout = () => {
        if (inactivityTimeout) clearTimeout(inactivityTimeout);
        inactivityTimeout = setTimeout(failForInactivity, inactivityMs);
      };

      proc.stdout.on("data", (chunk: Buffer) => input.onStdout(chunk.toString()));
      proc.stderr.on("data", (chunk: Buffer) => input.onStderr(chunk.toString()));
      proc.on("error", terminateWithError);
      proc.stdin.on("error", terminateWithError);
      proc.on("close", (code, signal) => {
        if (settled) return;
        processClosed = true;
        settled = true;
        clearTimers();
        if (terminationError) reject(terminationError);
        else resolve({ code, signal });
      });
      const write = (value: string) => new Promise<void>((resolveWrite, rejectWrite) => {
        if (proc.stdin.destroyed || proc.stdin.writableEnded) {
          rejectWrite(new Error("claude-code stdin is closed"));
          return;
        }
        proc.stdin.write(value, (error) => error ? rejectWrite(error) : resolveWrite());
      });
      void write(input.stdin).then(() => {
        if (input.onStdinReady) input.onStdinReady(write, closeInput);
        else closeInput();
      }).catch(terminateWithError);
      input.onProtocolActivityReady?.(resetInactivityTimeout);
      resetInactivityTimeout();
    });
  }
}

export interface ClaudeCodeParseResult {
  text: string;
  model?: string;
  sessionUUID: string | null;
  toolsUsed: string[];
  isError: boolean;
  durationMs?: number;
  /** The provider-validated outcome of the latest response, when it produced one. */
  turnOutcome?: StructuredTurnOutcome;
}

export function parseClaudeCodeOutput(stdout: string, fallbackSessionUUID: string | null = null, initialPrompt?: string): ClaudeCodeParseResult {
  const events = parseClaudeEvents(stdout);
  let sessionUUID = fallbackSessionUUID;
  let finalResult = "";
  let turnOutcome: StructuredTurnOutcome | null = null;
  let isError = false;
  let durationMs: number | undefined;
  let sessionModel: string | undefined;
  let model: string | undefined;
  const messageParts: string[] = [];
  const toolsUsed: string[] = [];
  let sawAcknowledgedUserInput = false;
  let awaitingInitialPrompt = initialPrompt !== undefined;

  for (const ev of events) {
    if (awaitingInitialPrompt) {
      if (acknowledgedUserText(ev) === initialPrompt) awaitingInitialPrompt = false;
      else if (ev.type !== "system" || ev.subtype !== "init") continue;
    }
    if (acknowledgedUserText(ev) !== null) {
      if (sawAcknowledgedUserInput) {
        // Every accepted stdin user message starts a new visible response
        // segment. This covers interrupted tools, interrupted streaming, and
        // the race where the prior response completes before interrupt ack.
        messageParts.length = 0;
        finalResult = "";
        turnOutcome = null;
        isError = false;
        durationMs = undefined;
        model = sessionModel;
      }
      sawAcknowledgedUserInput = true;
    }
    if (typeof ev.session_id === "string") sessionUUID = ev.session_id;
    if (ev.type === "system" && ev.subtype === "init" && typeof ev.model === "string") {
      sessionModel = ev.model.trim() || undefined;
      model = sessionModel;
    }
    if (ev.type === "system" && ev.subtype === "init" && typeof ev.session_id === "string") {
      sessionUUID = ev.session_id;
    }
    if (ev.type === "result") {
      if (typeof ev.session_id === "string") sessionUUID = ev.session_id;
      if (typeof ev.result === "string") finalResult = ev.result;
      turnOutcome = structuredTurnOutcome(ev.structured_output);
      isError = ev.is_error === true;
      durationMs = typeof ev.duration_ms === "number" && Number.isSafeInteger(ev.duration_ms) && ev.duration_ms >= 0
        ? ev.duration_ms : undefined;
      if (typeof ev.terminal_reason === "string" && ev.terminal_reason.startsWith("aborted_")) {
        messageParts.length = 0;
        finalResult = "";
        turnOutcome = null;
        durationMs = undefined;
        model = sessionModel;
      }
    }
    if (ev.type !== "assistant") continue;
    if (ev.parent_tool_use_id == null && typeof ev.message?.model === "string"
        && ev.message.model.trim() && !ev.message.model.startsWith("<")) model = ev.message.model.trim();
    const content = Array.isArray(ev.message?.content) ? ev.message.content : [];
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") {
        messageParts.push(block.text);
      } else if (block?.type === "tool_use") {
        toolsUsed.push(String(block.name || "tool"));
      }
    }
  }

  // The structured answer's message is what the turn says; any prose before it stays in history.
  const text = turnOutcome?.message.trim() || finalResult.trim() || messageParts.join("\n\n").trim() || (events.length === 0 ? stdout.trim() : "");
  if (events.length === 0 && stdout.trim()) {
    sessionUUID = sessionUUID || extractUuid(stdout);
  }
  return { text, sessionUUID, toolsUsed, isError, ...(turnOutcome ? { turnOutcome } : {}), ...(model ? { model } : {}), ...(durationMs !== undefined ? { durationMs } : {}) };
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

/**
 * A message carrying its own `uuid` enters Claude Code's streaming-input command queue as
 * an identified async user message: it runs after the current work without interrupting it,
 * and its `--replay-user-messages` echo names it exactly instead of by comparing text.
 */
export function claudeCodeUserMessage(text: string, uuid?: string): string {
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text }],
    },
    ...(uuid ? { parent_tool_use_id: null, uuid } : {}),
  });
}

export function claudeCodeInterruptRequest(requestId: string): string {
  return JSON.stringify({
    type: "control_request",
    request_id: requestId,
    request: { subtype: "interrupt" },
  });
}

function acknowledgedUserText(event: JsonValue): string | null {
  if (event.type !== "user" || event.parent_tool_use_id != null) return null;
  if (typeof event.message?.content === "string") return event.message.content || null;
  const content = Array.isArray(event.message?.content) ? event.message.content : [];
  const text = content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("\n");
  return text || null;
}

function claudeConsultationEnvironment(): Record<string, string> {
  const environment: Record<string, string> = { CLAUDE_CODE_SAFE_MODE: "1" };
  for (const name of ["HOME", "PATH", "LANG", "USER", "LOGNAME", "SHELL", "XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR"]) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  return environment;
}

export function claudeCodeArgs(input: {
  prompt: string;
  additionalDirs: string[];
  sessionUUID: string | null;
  forkSession?: boolean;
  model?: string;
  reasoning_effort?: string;
  systemPrompt?: string;
  interactionPolicy?: ProviderInteractionPolicy;
}) {
  assertProviderInteractionPolicy(input.interactionPolicy);
  if (input.forkSession) assertProviderForkPolicy(input.interactionPolicy);
  const consultation = input.interactionPolicy === "consultation-only";
  const args = [
    "--print",
    "--verbose",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--replay-user-messages",
    ...(input.sessionUUID ? ["--resume", input.sessionUUID] : []),
    ...(input.forkSession ? ["--fork-session"] : []),
    ...(input.model ? ["--model", input.model] : []),
    ...(input.reasoning_effort ? ["--effort", input.reasoning_effort] : []),
    ...(consultation ? claudeConsultationArgs() : []),
    ...(input.systemPrompt ? ["--append-system-prompt", input.systemPrompt] : []),
    // Every working turn ends with a provider-validated outcome; a consultation is information only.
    ...(consultation ? [] : ["--json-schema", JSON.stringify(TURN_OUTCOME_SCHEMA)]),
  ];

  // Claude variadic flags consume following args, so keep them at the end.
  if (!consultation) for (const dir of input.additionalDirs) args.push("--add-dir", dir);
  return args;
}

export async function runClaudeCodeTurn(input: {
  prompt: string;
  cwd: string;
  additionalDirs: string[];
  sessionUUID: string | null;
  forkSession?: boolean;
  model?: string;
  reasoning_effort?: string;
  systemPrompt?: string;
  environment?: Record<string, string>;
  interactionPolicy?: ProviderInteractionPolicy;
  onProgress?: ProgressCb;
  onProviderMessage?: ProviderMessageCallback;
  onProviderThreadStarted?: (providerThreadId: string) => void;
  onSteeringReady?: (sender: SteeringSender) => void;
  onCancellationReady?: (cancel: () => Promise<void>) => void;
  onProviderTerminal?: () => void;
  onInputAcknowledged?: () => void;
  onPreferredModel?: (model: string) => void;
  modelSwitchTimeoutMs?: number;
  steeringAcknowledgementGraceMs?: number;
  transport?: ClaudeCodeTransport;
}): Promise<RunResult> {
  const transport = input.transport || new SubprocessClaudeCodeTransport();
  const selectAvailableModel = (models: string[]) => {
    for (const model of models) {
      const attempt = usageAttempt("claude-code", model);
      const limit = cachedUsageLimit(attempt);
      if (!limit) return model;
      input.onProgress?.({ type: "narration", text: usageLimitMessage(attempt, limit) });
      log("info", "provider_usage_cached_skip", { provider: "claude-code", scope: model, reset_at: limit.resetAt });
    }
    return undefined;
  };
  const selectedModel = input.model
    ? selectAvailableModel([input.model, ...claudeUsageFallbackModels(input.model)]) : undefined;
  if (input.model && !selectedModel) assertUsageAvailable(usageAttempt("claude-code", input.model));
  if (selectedModel && selectedModel !== input.model) {
    input.onProgress?.({ type: "narration", text: `Starting with ${selectedModel} because the preferred model has a cached usage limit.` });
  }
  const args = claudeCodeArgs({ ...input, model: selectedModel ?? input.model });
  const initialUsageAttempt = usageAttempt("claude-code", selectedModel ?? "unresolved");
  let currentUsageAttempt: UsageAttempt | null = selectedModel ? initialUsageAttempt : null;
  let usageResetAt: number | null = null;
  let stdout = "";
  let stderr = "";
  let reportedStarted = false;
  let closeInput = () => {};
  let writeInput: ((value: string) => Promise<void>) | null = null;
  let inputClosed = false;
  let initialPromptAcknowledged = false;
  let observedInputActive = false;
  let observedInputUuid: string | null = null;
  let observedSessionUuid = input.forkSession ? null : input.sessionUUID;
  let reportedSessionUuid: string | null = null;
  const publishProviderMessages = providerMessageObserver(input.onProviderMessage);
  const publishProviderEvent = (event: JsonValue) => {
    if (!initialPromptAcknowledged || !observedInputActive || event.parent_tool_use_id != null) return;
    if (typeof event.session_id === "string" && event.session_id) {
      if (observedSessionUuid && event.session_id !== observedSessionUuid) return;
      observedSessionUuid = event.session_id;
    }
    publishProviderRow(event);
  };
  // One Claude row becomes conversation messages the same way whether it arrived on
  // stdout or was read from Claude's transcript, so the same message keeps one identity.
  const publishProviderRow = (event: JsonValue) => {
    if (!observedSessionUuid) return;
    if (reportedSessionUuid !== observedSessionUuid) {
      input.onProviderThreadStarted?.(observedSessionUuid);
      reportedSessionUuid = observedSessionUuid;
    }
    if (!input.onProviderMessage || (event.type !== "user" && event.type !== "assistant")) return;
    let messages;
    try { messages = claudeHistoryMessages({ ...event, session_id: observedSessionUuid }, observedSessionUuid); }
    catch { return; } // Echo acknowledgement does not require optional native message IDs.
    publishProviderMessages(messages);
  };
  let steeringSenderRegistered = false;
  let eventBuffer = "";
  let providerProducedResult = false;
  let providerTerminalReported = false;
  let cancellationRegistered = false;
  let cancellationReason: ProviderTurnCancelledError | null = null;
  let recordProtocolActivity = () => {};
  let closeCheckScheduled = false;
  let acknowledgementDeadline: ReturnType<typeof setTimeout> | null = null;
  let nextControlRequestId = 0;
  let preferredModel: string | undefined;
  let fallbackModels: string[] = [];
  let usageRejected = false;
  let modelSwitch: { requestId: string; attempt: UsageAttempt; deadline: ReturnType<typeof setTimeout>; settled: Promise<void>; settle: () => void } | null = null;
  let modelSwitchError: Error | null = null;
  let pendingFallbackReplay: string | null = null;
  const acceptedUserInputs = [input.prompt];
  // Follow-ups written into Claude Code's command queue, awaiting their identified echo.
  // Each stays pending until the CLI dequeues it — possibly after a long tool call — so
  // no per-message deadline applies while the turn is live.
  const pendingAcknowledgements: Array<{
    text: string;
    clientMessageId: string;
    uuid: string;
    settled: boolean;
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];
  // A message's own uuid identifies it exactly. Text equality is kept only as a fallback
  // for a record that does not carry the client uuid; the prepared bytes are
  // header-stamped, so they are unique within a session.
  const pendingAcknowledgementFor = (uuid: unknown, text: string) =>
    (typeof uuid === "string" && pendingAcknowledgements.find((pending) => pending.uuid === uuid))
    || pendingAcknowledgements.find((pending) => pending.text === text)
    || null;
  // Receipts come from Claude's transcript as soon as Claude picks a message up, and the
  // stdout echo of the same message arrives later with Claude's first output. The echo
  // still marks the start of that message's output for publishing, so each message
  // acknowledged from the transcript is remembered until its echo is seen.
  let initialEchoObserved = false;
  const pickedUpAwaitingEcho: Array<{ text: string; uuid: string }> = [];
  const takePickedUpEcho = (uuid: unknown, text: string) => {
    const index = pickedUpAwaitingEcho.findIndex((picked) =>
      (typeof uuid === "string" && picked.uuid === uuid) || picked.text === text);
    if (index < 0) return false;
    pickedUpAwaitingEcho.splice(index, 1);
    return true;
  };
  const settleAcknowledgement = (
    acknowledgement: (typeof pendingAcknowledgements)[number],
    error?: Error,
  ) => {
    if (acknowledgement.settled) return;
    acknowledgement.settled = true;
    const index = pendingAcknowledgements.indexOf(acknowledgement);
    if (index >= 0) pendingAcknowledgements.splice(index, 1);
    if (error) acknowledgement.reject(error);
    else acknowledgement.resolve();
    if (pendingAcknowledgements.length === 0 && acknowledgementDeadline) {
      clearTimeout(acknowledgementDeadline);
      acknowledgementDeadline = null;
    }
  };
  const failPendingAcknowledgements = (error: Error) => {
    for (const acknowledgement of [...pendingAcknowledgements]) settleAcknowledgement(acknowledgement, error);
  };
  const reportProviderTerminal = () => {
    if (providerTerminalReported) return;
    providerTerminalReported = true;
    input.onProviderTerminal?.();
  };
  const closeProviderInput = (reason = new Error("Claude Code completed before acknowledging the steering message.")) => {
    if (inputClosed) return;
    inputClosed = true;
    if (modelSwitch) {
      clearTimeout(modelSwitch.deadline);
      modelSwitch.settle();
    }
    modelSwitch = null;
    if (acknowledgementDeadline) {
      clearTimeout(acknowledgementDeadline);
      acknowledgementDeadline = null;
    }
    failPendingAcknowledgements(reason);
    closeInput();
  };
  const failModelSwitch = (error: unknown) => {
    modelSwitchError = error instanceof Error ? error : new Error(String(error));
    closeProviderInput(modelSwitchError);
  };
  const startUsageFallback = () => {
    const parsed = parseClaudeCodeOutput(stdout, input.sessionUUID, input.prompt);
    if (!parsed.isError || !initialPromptAcknowledged || !writeInput || cancellationReason || modelSwitchError
        || (!usageRejected && !isClaudeUsageExhaustion(parsed.text))) return false;
    if (currentUsageAttempt) recordUsageExhaustion(currentUsageAttempt, usageResetAt);
    const model = selectAvailableModel(fallbackModels);
    if (!model) return false;
    fallbackModels = fallbackModels.slice(fallbackModels.indexOf(model) + 1);
    const requestId = `concierge_model_${++nextControlRequestId}`;
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    modelSwitch = { requestId, attempt: usageAttempt("claude-code", model), settled, settle, deadline: setTimeout(() => {
      failModelSwitch(new Error("Claude Code did not acknowledge the fallback model switch."));
    }, input.modelSwitchTimeoutMs ?? 10_000) };
    input.onProgress?.({ type: "narration", text: `Claude reached its usage limit. Continuing this conversation with ${model}.` });
    log("info", "claude_code_usage_fallback", { session_uuid: parsed.sessionUUID, preferred_model: preferredModel, model });
    void writeInput(`${JSON.stringify({ type: "control_request", request_id: requestId,
      request: { subtype: "set_model", model } })}\n`).catch(failModelSwitch);
    return true;
  };
  const scheduleCloseAfterResult = () => {
    if (closeCheckScheduled || inputClosed) return;
    closeCheckScheduled = true;
    queueMicrotask(() => {
      closeCheckScheduled = false;
      if (inputClosed || modelSwitch) return;
      if (!providerProducedResult) return;
      if (pendingAcknowledgements.length === 0) {
        if (startUsageFallback()) return;
        reportProviderTerminal();
        closeProviderInput();
        return;
      }
      if (!acknowledgementDeadline) {
        acknowledgementDeadline = setTimeout(() => {
          acknowledgementDeadline = null;
          reportProviderTerminal();
          closeProviderInput(new Error("Claude Code did not acknowledge steering after completing its prior response."));
        }, input.steeringAcknowledgementGraceMs ?? 5_000);
      }
    });
  };
  const maybeRegisterSteeringSender = () => {
    if (steeringSenderRegistered || inputClosed || !writeInput || !initialPromptAcknowledged) return;
    steeringSenderRegistered = true;
    input.onSteeringReady?.(async (steering) => {
      if (modelSwitch) await modelSwitch.settled;
      return new Promise<void>((resolve, reject) => {
        if (inputClosed || !writeInput) {
          reject(new SteeringNotSentError("Claude Code completed before the steering message arrived."));
          return;
        }
        // A follow-up joins Claude Code's own command queue rather than interrupting the
        // current step. Stop remains the only interrupt this adapter sends.
        const acknowledgement = {
          text: steering.text,
          clientMessageId: steering.clientMessageId,
          uuid: randomUUID(),
          settled: false,
          resolve,
          reject,
        };
        pendingAcknowledgements.push(acknowledgement);
        void writeInput(`${claudeCodeUserMessage(acknowledgement.text, acknowledgement.uuid)}\n`).catch((error) => {
          // A write the pipe refused never entered the queue, so the input is provably
          // unsent and its owner may place it as ordinary queued work.
          settleAcknowledgement(acknowledgement, new SteeringNotSentError(
            `Claude Code did not accept this message: ${error instanceof Error ? error.message : String(error)}`,
          ));
          if (providerProducedResult) scheduleCloseAfterResult();
        });
      });
    });
  };
  const acknowledgeInitialPrompt = () => {
    if (initialPromptAcknowledged) return;
    initialPromptAcknowledged = true;
    input.onInputAcknowledged?.();
    reportStarted();
    maybeRegisterSteeringSender();
  };
  const acknowledgeFollowUp = (followUp: (typeof pendingAcknowledgements)[number]) => {
    if (followUp.settled) return;
    acceptedUserInputs.push(followUp.text);
    if (providerProducedResult) {
      // Claude picked up this follow-up after finishing the prior response, so that
      // response's completion and usage evidence no longer describe the live work.
      providerProducedResult = false;
      usageRejected = false;
      usageResetAt = null;
    }
    input.onProgress?.({ type: "steering", clientMessageId: followUp.clientMessageId });
    settleAcknowledgement(followUp);
  };
  // The message is shown the moment Claude records taking it. Waiting for the stdout echo
  // hid it until Claude's first output — 38 seconds for one request, while the session
  // visibly said Working. The row is published only after it matched a message this turn
  // sent, so the stream's current-input guard is not needed for it and stays for the rest.
  const publishPickedUpRow = (pickup: ClaudeTranscriptPickup) => {
    if (pickup.row && typeof pickup.row === "object") publishProviderRow(pickup.row as JsonValue);
  };
  const recordTranscriptPickup = (pickup: ClaudeTranscriptPickup) => {
    if (!initialPromptAcknowledged) {
      if (pickup.text === input.prompt) {
        acknowledgeInitialPrompt();
        publishPickedUpRow(pickup);
      }
      return;
    }
    const followUp = pendingAcknowledgementFor(pickup.uuid, pickup.text);
    if (!followUp) return;
    pickedUpAwaitingEcho.push({ text: followUp.text, uuid: followUp.uuid });
    acknowledgeFollowUp(followUp);
    publishPickedUpRow(pickup);
  };
  let stopTranscriptWatch = () => {};
  const startTranscriptWatch = (sessionUuid: string, fromStart: boolean) => {
    stopTranscriptWatch();
    stopTranscriptWatch = watchClaudeTranscript({
      sessionUuid, fromStart, environment: input.environment, onPickup: recordTranscriptPickup,
    });
  };
  const maybeRegisterCancellation = () => {
    if (cancellationRegistered || inputClosed || !writeInput) return;
    cancellationRegistered = true;
    input.onCancellationReady?.(async () => {
      if (cancellationReason || inputClosed || !writeInput) return;
      cancellationReason = new ProviderTurnCancelledError();
      reportProviderTerminal();
      const requestId = `concierge_stop_${++nextControlRequestId}`;
      await writeInput(`${claudeCodeInterruptRequest(requestId)}\n`);
      closeProviderInput(cancellationReason);
    });
  };
  const handleProtocolEvent = (event: JsonValue) => {
    if (!CLAUDE_PROTOCOL_EVENT_TYPES.has(String(event.type || ""))) return;
    recordProtocolActivity();
    if (!observedSessionUuid && event.type === "system" && event.subtype === "init"
      && typeof event.session_id === "string" && event.session_id) {
      observedSessionUuid = event.session_id;
      // A new or forked session's transcript is written by this process from its start.
      startTranscriptWatch(event.session_id, true);
    }
    if (event.type === "system" && event.subtype === "init" && !preferredModel && typeof event.model === "string" && event.model.trim()) {
      preferredModel = input.model || event.model.trim();
      input.onPreferredModel?.(preferredModel);
      // Scope and label travel together; the label names the model this scope is for.
      const observedAttempt = usageAttempt("claude-code", event.model.trim());
      currentUsageAttempt ??= { ...initialUsageAttempt, scope: observedAttempt.scope, label: observedAttempt.label };
      fallbackModels = claudeUsageFallbackModels(selectedModel ?? preferredModel);
    }
    if (event.type === "rate_limit_event") {
      usageRejected = event.rate_limit_info?.status === "rejected";
      usageResetAt = usageRejected ? resetEpochMilliseconds(event.rate_limit_info?.resetsAt) : null;
    }
    if (event.type === "assistant" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type !== "tool_use") continue;
        const toolName = String(block.name || "tool");
        const details = toolName === "WebSearch" ? webActivityDetails({ query: block.input?.query })
          : toolName === "WebFetch" ? webActivityDetails({ url: block.input?.url }) : undefined;
        input.onProgress?.({ type: "tool_use", toolName,
          ...(typeof block.id === "string" ? { itemId: block.id } : {}),
          ...(details ? { details } : {}),
        });
      }
    }
    if (event.type === "control_response") {
      const response = isRecord(event.response) ? event.response : null;
      const requestId = typeof response?.request_id === "string" ? response.request_id : null;
      if (modelSwitch && requestId === modelSwitch.requestId) {
        const nextAttempt = modelSwitch.attempt;
        clearTimeout(modelSwitch.deadline);
        modelSwitch.settle();
        modelSwitch = null;
        if (response?.subtype !== "success") {
          failModelSwitch(new Error(String(response?.error || "Claude Code rejected the fallback model switch.")));
        } else if (!inputClosed && writeInput && !cancellationReason) {
          currentUsageAttempt = nextAttempt;
          providerProducedResult = false;
          usageRejected = false;
          usageResetAt = null;
          pendingFallbackReplay = [USAGE_FALLBACK_CONTINUATION, ...acceptedUserInputs].join("\n\n");
          void writeInput(`${claudeCodeUserMessage(pendingFallbackReplay)}\n`).catch(failModelSwitch);
        }
        return;
      }
      return;
    }
    const sessionMatches = !observedSessionUuid || !event.session_id || event.session_id === observedSessionUuid;
    const userText = sessionMatches ? acknowledgedUserText(event) : null;
    if (userText !== null) {
      const initialEcho = !initialEchoObserved && userText === input.prompt;
      const followUp = initialPromptAcknowledged && !initialEcho ? pendingAcknowledgementFor(event.uuid, userText) : null;
      const pickedUpEcho = !initialEcho && !followUp && takePickedUpEcho(event.uuid, userText);
      const current = initialEcho || userText === pendingFallbackReplay || followUp !== null || pickedUpEcho;
      observedInputActive = current || (typeof event.uuid === "string" && event.uuid === observedInputUuid);
      if (current) observedInputUuid = typeof event.uuid === "string" ? event.uuid : null;
      if (userText === pendingFallbackReplay) {
        pendingFallbackReplay = null;
        publishProviderEvent(event);
        return;
      }
      if (initialEcho) {
        initialEchoObserved = true;
        acknowledgeInitialPrompt();
      } else if (followUp) {
        acknowledgeFollowUp(followUp);
      }
    }
    if (sessionMatches) publishProviderEvent(event);
    if (event.type === "result") {
      const terminalReason = typeof event.terminal_reason === "string" ? event.terminal_reason : "";
      if (terminalReason.startsWith("aborted_")) return;
      if (!initialPromptAcknowledged) {
        // A resumed CLI may finish a queued notification before echoing this request.
        usageRejected = false;
        usageResetAt = null;
        log("info", "claude_code_unowned_result_ignored", {
          session_uuid: typeof event.session_id === "string" ? event.session_id : input.sessionUUID,
          phase: "initial_input_acknowledgement", is_error: event.is_error === true,
        });
        return;
      }
      if (pendingFallbackReplay !== null) {
        failModelSwitch(new Error("Claude Code ended before acknowledging the fallback continuation."));
        return;
      }
      providerProducedResult = true;
      scheduleCloseAfterResult();
    }
  };
  function reportStarted() {
    if (reportedStarted) return;
    reportedStarted = true;
    input.onProgress?.({ type: "started" });
  }

  log("info", "claude_code_turn_started", {
    cwd: input.cwd,
    resume: !!input.sessionUUID,
    additional_dir_count: input.additionalDirs.length,
  });
  // Watching starts before Claude does, so only what this process writes is read.
  if (input.sessionUUID && !input.forkSession) startTranscriptWatch(input.sessionUUID, false);
  const outcome = await transport.run({
    args,
    cwd: input.cwd,
    environment: input.interactionPolicy === "consultation-only" ? claudeConsultationEnvironment() : providerOwnerEnvironment(input.environment),
    ...(input.interactionPolicy === "consultation-only" ? { inheritEnvironment: false } : {}),
    stdin: `${claudeCodeUserMessage(input.prompt)}\n`,
    onStdinReady: (write, close) => {
      closeInput = close;
      writeInput = write;
      if (inputClosed) {
        close();
        return;
      }
      maybeRegisterSteeringSender();
      maybeRegisterCancellation();
    },
    onProtocolActivityReady: (record) => {
      recordProtocolActivity = record;
    },
    onStdout: (chunk) => {
      stdout += chunk;
      eventBuffer += chunk;
      const lines = eventBuffer.split("\n");
      eventBuffer = lines.pop() || "";
      for (const line of lines) {
        const event = parseJson(line.trim());
        if (isRecord(event)) handleProtocolEvent(event);
      }
      const parsed = parseClaudeCodeOutput(stdout, input.sessionUUID, input.prompt);
      if (parsed.text && !parsed.isError && !modelSwitch) input.onProgress?.({ type: "narration", text: parsed.text });
    },
    onStderr: (chunk) => {
      stderr += chunk;
    },
  }).catch((error) => {
    stopTranscriptWatch();
    closeProviderInput();
    throw error;
  });
  stopTranscriptWatch();
  const finalBufferedEvent = parseJson(eventBuffer.trim());
  if (isRecord(finalBufferedEvent)) handleProtocolEvent(finalBufferedEvent);
  if (providerProducedResult) reportProviderTerminal();
  closeProviderInput();
  if (cancellationReason) throw cancellationReason;
  if (modelSwitchError) {
    const failed = parseClaudeCodeOutput(stdout, input.sessionUUID, input.prompt);
    throw new ProviderDispatchError({ message: modelSwitchError.message, terminalConfirmed: true,
      toolsUsed: failed.toolsUsed, providerSessionId: failed.sessionUUID });
  }
  if (!initialPromptAcknowledged) {
    throw new Error("Claude Code ended before acknowledging the initial user message.");
  }
  if (!providerProducedResult) {
    throw new Error("Claude Code ended before producing a terminal result.");
  }

  const parsed = parseClaudeCodeOutput(stdout, input.sessionUUID, input.prompt);
  log("info", "claude_code_turn_finished", {
    code: outcome.code,
    signal: outcome.signal,
    session_uuid: parsed.sessionUUID,
    tool_count: parsed.toolsUsed.length,
    is_error: parsed.isError,
  });

  if (parsed.isError) {
    const usageExhausted = usageRejected || isClaudeUsageExhaustion(parsed.text);
    if (usageExhausted && currentUsageAttempt) recordUsageExhaustion(currentUsageAttempt, usageResetAt);
    throw new ProviderDispatchError({
      message: usageExhausted
        ? `Claude usage is exhausted for this request after its configured fallbacks.${usageResetAt ? ` Usage resets at ${new Date(usageResetAt).toISOString()}.` : ''} This input will not retry automatically. ${parsed.text}`
        : parsed.text || stderr.slice(0, 800) || "claude-code returned an error",
      ...(usageExhausted ? { failureClass: "parked_terminal" as const } : {}),
      terminalConfirmed: true,
      toolsUsed: parsed.toolsUsed,
      providerSessionId: parsed.sessionUUID,
    });
  }
  if (currentUsageAttempt) recordUsageSuccess(currentUsageAttempt);
  input.onProgress?.({ type: "done", text: parsed.text });

  return {
    text: parsed.text || "(agent completed without a text reply)",
    sessionUUID: parsed.sessionUUID,
    toolsUsed: parsed.toolsUsed,
    ...(parsed.model ? { model: parsed.model } : {}),
    ...(parsed.durationMs !== undefined ? { durationMs: parsed.durationMs } : {}),
    ...(parsed.turnOutcome ? { turnOutcome: parsed.turnOutcome } : {}),
  };
}

export async function forkClaudeCodeSession(input: {
  sessionUUID: string;
  cwd: string;
  additionalDirs: string[];
  prompt?: string;
  transport?: ClaudeCodeTransport;
  interactionPolicy?: ProviderInteractionPolicy;
}): Promise<RunResult> {
  assertProviderForkPolicy(input.interactionPolicy);
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
