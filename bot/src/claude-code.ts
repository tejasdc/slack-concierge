import { spawn } from "node:child_process";
import { log } from "./log";
import { ProgressCb, RunResult } from "./codex";
import { SteeringNotSentError, SteeringSender } from "./steering";
import { BrokeredClaudeCodeTransport, providerBrokerEnabled } from "./provider-broker-client";

type JsonValue = Record<string, any>;

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
    stdin: string;
    onStdout: (chunk: string) => void;
    onStderr: (chunk: string) => void;
    onStdinReady?: (write: (input: string) => Promise<void>, close: () => void) => void;
    onProtocolActivityReady?: (record: () => void) => void;
    broker?: {
      prompt: string;
      sessionUuid: string | null;
      forkSession?: boolean;
      model?: string;
      systemPrompt?: string;
      additionalDirs: string[];
    };
  }): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export class SubprocessClaudeCodeTransport implements ClaudeCodeTransport {
  constructor(
    private readonly executable = "claude",
    private readonly timeouts: { inactivityMs?: number; shutdownGraceMs?: number } = {},
  ) {}

  run(input: {
    args: string[];
    cwd: string;
    environment?: Record<string, string>;
    stdin: string;
    onStdout: (chunk: string) => void;
    onStderr: (chunk: string) => void;
    onStdinReady?: (write: (input: string) => Promise<void>, close: () => void) => void;
    onProtocolActivityReady?: (record: () => void) => void;
  }): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    const proc = spawn(this.executable, input.args, {
      cwd: input.cwd,
      env: { ...process.env, ...input.environment },
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
  let sawReplayedUserInput = false;

  for (const ev of events) {
    if (ev.type === "user" && ev.isReplay === true) {
      if (sawReplayedUserInput) {
        // Every accepted stdin user message starts a new visible response
        // segment. This covers interrupted tools, interrupted streaming, and
        // the race where the prior response completes before interrupt ack.
        messageParts.length = 0;
        finalResult = "";
        isError = false;
      }
      sawReplayedUserInput = true;
    }
    if (typeof ev.session_id === "string") sessionUUID = ev.session_id;
    if (ev.type === "system" && ev.subtype === "init" && typeof ev.session_id === "string") {
      sessionUUID = ev.session_id;
    }
    if (ev.type === "result") {
      if (typeof ev.session_id === "string") sessionUUID = ev.session_id;
      if (typeof ev.result === "string") finalResult = ev.result;
      isError = ev.is_error === true;
      if (typeof ev.terminal_reason === "string" && ev.terminal_reason.startsWith("aborted_")) {
        messageParts.length = 0;
        finalResult = "";
      }
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

  const text = finalResult.trim() || messageParts.join("\n\n").trim() || (events.length === 0 ? stdout.trim() : "");
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

export function claudeCodeUserMessage(text: string): string {
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text }],
    },
  });
}

export function claudeCodeInterruptRequest(requestId: string): string {
  return JSON.stringify({
    type: "control_request",
    request_id: requestId,
    request: { subtype: "interrupt" },
  });
}

function replayedUserText(event: JsonValue): string | null {
  if (event.type !== "user" || event.isReplay !== true) return null;
  const content = Array.isArray(event.message?.content) ? event.message.content : [];
  const text = content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("\n");
  return text || null;
}

export function claudeCodeArgs(input: {
  prompt: string;
  additionalDirs: string[];
  sessionUUID: string | null;
  forkSession?: boolean;
  model?: string;
  systemPrompt?: string;
}) {
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
    ...(input.systemPrompt ? ["--append-system-prompt", input.systemPrompt] : []),
  ];

  // Claude variadic flags consume following args, so keep them at the end.
  for (const dir of input.additionalDirs) args.push("--add-dir", dir);
  return args;
}

export async function runClaudeCodeTurn(input: {
  prompt: string;
  cwd: string;
  additionalDirs: string[];
  sessionUUID: string | null;
  sessionBindingToken?: string | null;
  forkSession?: boolean;
  model?: string;
  systemPrompt?: string;
  environment?: Record<string, string>;
  onProgress?: ProgressCb;
  onSteeringReady?: (sender: SteeringSender) => void;
  onProviderTerminal?: () => void;
  steeringAcknowledgementGraceMs?: number;
  steeringAcknowledgementTimeoutMs?: number;
  transport?: ClaudeCodeTransport;
}): Promise<RunResult> {
  const ownedBrokerTransport = !input.transport && providerBrokerEnabled()
    ? new BrokeredClaudeCodeTransport(input.sessionBindingToken)
    : null;
  const transport = input.transport || ownedBrokerTransport || new SubprocessClaudeCodeTransport();
  const args = claudeCodeArgs(input);
  let stdout = "";
  let stderr = "";
  let reportedToolCount = 0;
  let reportedStarted = false;
  let closeInput = () => {};
  let writeInput: ((value: string) => Promise<void>) | null = null;
  let inputClosed = false;
  let initialPromptAcknowledged = false;
  let steeringSenderRegistered = false;
  let eventBuffer = "";
  let providerProducedResult = false;
  let providerTerminalReported = false;
  let steeringReplayCorrelationLost = false;
  let recordProtocolActivity = () => {};
  let closeCheckScheduled = false;
  let acknowledgementDeadline: ReturnType<typeof setTimeout> | null = null;
  let nextControlRequestId = 0;
  const pendingAcknowledgements: Array<{
    text: string;
    requestId: string;
    phase: "interrupt" | "message";
    controlDeadline: ReturnType<typeof setTimeout> | null;
    settled: boolean;
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];
  const settleAcknowledgement = (
    acknowledgement: (typeof pendingAcknowledgements)[number],
    error?: Error,
  ) => {
    if (acknowledgement.settled) return;
    acknowledgement.settled = true;
    if (acknowledgement.controlDeadline) clearTimeout(acknowledgement.controlDeadline);
    acknowledgement.controlDeadline = null;
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
    if (acknowledgementDeadline) {
      clearTimeout(acknowledgementDeadline);
      acknowledgementDeadline = null;
    }
    failPendingAcknowledgements(reason);
    closeInput();
  };
  const scheduleCloseAfterResult = () => {
    if (closeCheckScheduled || inputClosed) return;
    closeCheckScheduled = true;
    queueMicrotask(() => {
      closeCheckScheduled = false;
      if (inputClosed) return;
      if (!providerProducedResult) return;
      if (pendingAcknowledgements.length === 0) {
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
    input.onSteeringReady?.((steering) => new Promise<void>((resolve, reject) => {
      if (inputClosed || !writeInput) {
        reject(new SteeringNotSentError("Claude Code completed before the steering message arrived."));
        return;
      }
      if (steeringReplayCorrelationLost) {
        reject(new SteeringNotSentError(
          "Claude Code cannot accept more steering because a prior guidance replay was not correlated.",
        ));
        return;
      }
      const requestId = `concierge_steer_${++nextControlRequestId}`;
      const acknowledgement = {
        text: steering.text,
        requestId,
        phase: "interrupt" as const,
        controlDeadline: null as ReturnType<typeof setTimeout> | null,
        settled: false,
        resolve,
        reject,
      };
      pendingAcknowledgements.push(acknowledgement);
      acknowledgement.controlDeadline = setTimeout(() => {
        settleAcknowledgement(
          acknowledgement,
          new Error("Claude Code did not acknowledge the steering interrupt."),
        );
        if (providerProducedResult) scheduleCloseAfterResult();
      }, input.steeringAcknowledgementTimeoutMs ?? 10_000);
      void writeInput(`${claudeCodeInterruptRequest(requestId)}\n`).catch((error) => {
        settleAcknowledgement(
          acknowledgement,
          error instanceof Error ? error : new Error(String(error)),
        );
        if (providerProducedResult) scheduleCloseAfterResult();
      });
    }));
  };
  const handleProtocolEvent = (event: JsonValue) => {
    if (!CLAUDE_PROTOCOL_EVENT_TYPES.has(String(event.type || ""))) return;
    recordProtocolActivity();
    if (event.type === "control_response") {
      const response = isRecord(event.response) ? event.response : null;
      const requestId = typeof response?.request_id === "string" ? response.request_id : null;
      const acknowledgement = pendingAcknowledgements.find((pending) => pending.requestId === requestId);
      if (acknowledgement && acknowledgement.phase === "interrupt") {
        if (acknowledgement.controlDeadline) clearTimeout(acknowledgement.controlDeadline);
        acknowledgement.controlDeadline = null;
        if (response?.subtype !== "success") {
          settleAcknowledgement(
            acknowledgement,
            new Error(String(response?.error || "Claude Code rejected the steering interrupt.")),
          );
          if (providerProducedResult) scheduleCloseAfterResult();
        } else if (!inputClosed && writeInput) {
          acknowledgement.phase = "message";
          void writeInput(`${claudeCodeUserMessage(acknowledgement.text)}\n`)
            .then(() => {
              if (acknowledgement.settled || acknowledgement.phase !== "message") return;
              acknowledgement.controlDeadline = setTimeout(() => {
                steeringReplayCorrelationLost = true;
                settleAcknowledgement(
                  acknowledgement,
                  new Error("Claude Code did not acknowledge the steering guidance."),
                );
                if (providerProducedResult) scheduleCloseAfterResult();
              }, input.steeringAcknowledgementTimeoutMs ?? 10_000);
            })
            .catch((error) => {
              steeringReplayCorrelationLost = true;
              settleAcknowledgement(
                acknowledgement,
                error instanceof Error ? error : new Error(String(error)),
              );
              if (providerProducedResult) scheduleCloseAfterResult();
            });
        } else {
          settleAcknowledgement(
            acknowledgement,
            new Error("Claude Code completed after accepting the steering interrupt but before receiving its guidance."),
          );
          if (providerProducedResult) scheduleCloseAfterResult();
        }
      }
      return;
    }
    const userText = replayedUserText(event);
    if (userText !== null) {
      if (!initialPromptAcknowledged && userText === input.prompt) {
        initialPromptAcknowledged = true;
        reportStarted();
        maybeRegisterSteeringSender();
      } else {
        const acknowledgement = pendingAcknowledgements[0];
        if (acknowledgement && acknowledgement.phase === "message" && acknowledgement.text === userText) {
          const continuingAfterCompletedResult = providerProducedResult;
          if (continuingAfterCompletedResult) providerProducedResult = false;
          settleAcknowledgement(acknowledgement);
        }
      }
    }
    if (event.type === "result") {
      const terminalReason = typeof event.terminal_reason === "string" ? event.terminal_reason : "";
      if (terminalReason.startsWith("aborted_")) return;
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
  const outcome = await transport.run({
    args,
    cwd: input.cwd,
    environment: input.environment,
    stdin: `${claudeCodeUserMessage(input.prompt)}\n`,
    broker: ownedBrokerTransport ? {
      prompt: input.prompt,
      sessionUuid: input.sessionUUID,
      forkSession: input.forkSession,
      model: input.model,
      systemPrompt: input.systemPrompt,
      additionalDirs: input.additionalDirs,
    } : undefined,
    onStdinReady: (write, close) => {
      closeInput = close;
      writeInput = write;
      if (inputClosed) {
        close();
        return;
      }
      maybeRegisterSteeringSender();
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
  const finalBufferedEvent = parseJson(eventBuffer.trim());
  if (isRecord(finalBufferedEvent)) handleProtocolEvent(finalBufferedEvent);
  if (providerProducedResult) reportProviderTerminal();
  closeProviderInput();
  if (!initialPromptAcknowledged) {
    throw new Error("Claude Code ended before acknowledging the initial user message.");
  }
  if (!providerProducedResult) {
    throw new Error("Claude Code ended before producing a terminal result.");
  }

  const parsed = parseClaudeCodeOutput(stdout, input.sessionUUID);
  log("info", "claude_code_turn_finished", {
    code: outcome.code,
    signal: outcome.signal,
    session_uuid: parsed.sessionUUID,
    tool_count: parsed.toolsUsed.length,
    is_error: parsed.isError,
  });

  if (parsed.isError) throw new Error(parsed.text || stderr.slice(0, 800) || "claude-code returned an error");
  input.onProgress?.({ type: "done", text: parsed.text });

  return {
    text: parsed.text || "(agent completed without a text reply)",
    sessionUUID: parsed.sessionUUID,
    ...(ownedBrokerTransport?.bindingToken() || input.sessionBindingToken
      ? { providerBindingToken: ownedBrokerTransport?.bindingToken() || input.sessionBindingToken }
      : {}),
    toolsUsed: parsed.toolsUsed,
  };
}

export async function forkClaudeCodeSession(input: {
  sessionUUID: string;
  sessionBindingToken?: string | null;
  cwd: string;
  additionalDirs: string[];
  prompt?: string;
  transport?: ClaudeCodeTransport;
}): Promise<RunResult> {
  const result = await runClaudeCodeTurn({
    cwd: input.cwd,
    additionalDirs: input.additionalDirs,
    sessionUUID: input.sessionUUID,
    sessionBindingToken: input.sessionBindingToken,
    forkSession: true,
    prompt: input.prompt || "Fork this Claude Code session for Slack Concierge. Reply with a short confirmation.",
    transport: input.transport,
  });
  if (!result.sessionUUID || result.sessionUUID === input.sessionUUID) {
    throw new Error("claude-code fork did not return a new session id");
  }
  return result;
}
