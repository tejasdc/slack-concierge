import type { AgentProvider } from "./providers";
import type { ClaudeCodeTransport } from "./claude-code";
import type { RunResult } from "./codex";
import { splitTurnOutcomeMarker } from "./turn-outcome-marker";
import { ProviderDispatchError, ProviderTurnCancelledError } from "./provider-failures";
import { ProviderCapabilityUnavailableError } from "./provider-policy";
import { providerOwnerEnvironment } from "./provider-owner-environment";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";

/** Execution hosts have a supervisor PATH, so resolve the CLI on the owner before launch. */
export function antigravityExecutable(): string {
  const configured = process.env.CONCIERGE_ANTIGRAVITY_EXECUTABLE || "agy";
  const found = configured.includes("/") ? configured
    : Bun.which(configured) || (existsSync(join(homedir(), ".local/bin", configured))
      ? join(homedir(), ".local/bin", configured) : null);
  if (!found || !isAbsolute(found) || !existsSync(found)) throw new ProviderCapabilityUnavailableError("execution", "The Google agent CLI is not installed on this machine.");
  return found;
}

export function antigravityInstalled(): boolean {
  try { antigravityExecutable(); return true; } catch { return false; }
}

type AntigravityRun = Parameters<AgentProvider["run"]>[0] & {
  /** The execution host owns the process and replays its exact output after an owner restart. */
  transport?: ClaudeCodeTransport;
};

type AntigravityEvent = {
  event?: string;
  conversation_id?: string;
  init?: { cwd?: string };
  step_update?: { step_index?: number; step_type?: string; state?: string; text_delta?: string };
  result?: {
    conversation_id?: string;
    status?: string;
    response?: string;
    error?: string;
    num_turns?: number;
  };
};

const MAX_PROTOCOL_LINE = 8 * 1024 * 1024;
const MAX_ERROR_TEXT = 1_000;

/** A Google conversation is named by its exact CLI ID, never by the most recent local project. */
export async function runAntigravityTurn(input: AntigravityRun): Promise<RunResult> {
  if (input.interactionPolicy === "consultation-only") {
    throw new ProviderCapabilityUnavailableError("consultation", "Antigravity has no verified information-only tool policy.");
  }
  if (!input.transport) {
    throw new ProviderCapabilityUnavailableError("execution", "Antigravity requires a durable execution host before it can receive work.");
  }
  if (input.sessionUUID && !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(input.sessionUUID)) {
    throw new ProviderCapabilityUnavailableError("conversation", "The bound Google conversation ID is invalid.");
  }

  const args = ["--input-format", "stream-json", "--output-format", "stream-json",
    "--print-timeout", "0", "--dangerously-skip-permissions", "--disable-slash-commands"];
  if (input.sessionUUID) args.push("--conversation", input.sessionUUID);
  if (input.model) args.push("--model", input.model);
  if (input.reasoning_effort) args.push("--effort", input.reasoning_effort);
  for (const directory of input.additionalDirs) args.push("--add-dir", directory);

  // Antigravity has no system-prompt flag. The owner-supplied instructions are the first text
  // of this admitted input, and the provider run record retains the exact combined prompt.
  const content = input.systemPrompt ? `${input.systemPrompt}\n\n${input.prompt}` : input.prompt;
  const initialInput = JSON.stringify({ event: "user", message: { content } }) + "\n";
  let buffer = "";
  let conversationId = input.sessionUUID ?? null;
  let terminal: NonNullable<AntigravityEvent["result"]> | null = null;
  let observedOutput = false;
  let acknowledged = false;
  let cancelled = false;
  let closeInput: (() => void) | null = null;
  const toolsUsed = new Set<string>();
  const startedAt = Date.now();

  const acknowledge = () => {
    if (acknowledged) return;
    acknowledged = true;
    input.onInputAcknowledged?.();
  };
  const bind = (id: unknown) => {
    if (typeof id !== "string" || !id) return;
    if (conversationId && conversationId !== id) {
      throw new ProviderDispatchError({ message: "Google returned a different conversation from the bound session.",
        terminalConfirmed: false, assistantOutput: observedOutput, providerSessionId: conversationId });
    }
    if (!conversationId) {
      conversationId = id;
      input.onProviderThreadStarted?.(id);
    }
  };
  const handle = (event: AntigravityEvent) => {
    if (event.event === "init") {
      bind(event.conversation_id);
      input.onProgress?.({ type: "started" });
      return;
    }
    if (event.event === "step_update" && event.step_update) {
      const step = event.step_update;
      if (step.step_type === "user_input" && step.state === "DONE") acknowledge();
      if (step.step_type === "agent_response" && step.text_delta) {
        observedOutput = true;
        input.onProgress?.({ type: "commentary", text: step.text_delta });
      } else if (step.step_type && !["agent_response", "user_input"].includes(step.step_type)) {
        toolsUsed.add(step.step_type);
        if (step.state === "DONE") input.onProgress?.({ type: "tool_use", toolName: step.step_type });
      }
      return;
    }
    if (event.event === "result" && event.result) {
      bind(event.result.conversation_id);
      terminal = event.result;
      if (Number.isSafeInteger(event.result.num_turns) && event.result.num_turns! > 0)
        input.onProviderTurnStarted?.(String(event.result.num_turns));
      if (event.result.status === "SUCCESS") acknowledge();
      closeInput?.();
    }
  };

  const exit = await input.transport.run({
    args, cwd: input.cwd,
    environment: providerOwnerEnvironment(input.environment),
    stdin: initialInput,
    onStdout: chunk => {
      buffer += chunk;
      if (buffer.length > MAX_PROTOCOL_LINE) {
        throw new ProviderDispatchError({ message: "Google's structured response exceeded the supported line size.",
          terminalConfirmed: false, assistantOutput: observedOutput, providerSessionId: conversationId });
      }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let event: AntigravityEvent;
        try { event = JSON.parse(line) as AntigravityEvent; }
        catch { throw new ProviderDispatchError({ message: "Google emitted an invalid structured response.",
          terminalConfirmed: false, assistantOutput: observedOutput, providerSessionId: conversationId }); }
        handle(event);
      }
    },
    // stderr is deliberately not copied into a user-visible error: the CLI controls its
    // contents and could include account or local machine details.
    onStderr: () => {},
    onStdinReady: (_write, close) => {
      closeInput = close;
      input.onCancellationReady?.(async () => { cancelled = true; close(); });
    },
  });
  input.onProviderTerminal?.();
  if (cancelled) throw new ProviderTurnCancelledError("The Google turn was stopped.");
  if (!terminal) {
    throw new ProviderDispatchError({ message: exit.code === 0
      ? "Google exited without a final structured result."
      : "Google exited before confirming a final result.",
      terminalConfirmed: false, assistantOutput: observedOutput, providerSessionId: conversationId,
      toolsUsed: [...toolsUsed] });
  }
  // The CLI's terminal result is the turn outcome. Closing its streaming stdin can make the
  // host stop an otherwise idle process after that result; its later process code is not a
  // second verdict on work the provider already marked successful.
  if (terminal.status !== "SUCCESS") {
    // ERROR says the run ended, not that it had no effects. Only zero-turn refusals are
    // replay-safe; an error after Google began a turn stays unconfirmed for inspection.
    const beforeTurn = terminal.num_turns === 0 && !observedOutput && toolsUsed.size === 0;
    throw new ProviderDispatchError({ message: (terminal.error || `Google ended with ${terminal.status ?? "unknown status"}.`).slice(0, MAX_ERROR_TEXT),
      terminalConfirmed: beforeTurn, assistantOutput: observedOutput, providerSessionId: conversationId,
      toolsUsed: [...toolsUsed] });
  }
  if (!conversationId) {
    throw new ProviderDispatchError({ message: "Google answered without a conversation ID, so this session cannot preserve continuity.",
      terminalConfirmed: true, assistantOutput: true, toolsUsed: [...toolsUsed] });
  }
  const fullText = terminal.response ?? "";
  const { text, mark: turnOutcome } = splitTurnOutcomeMarker(fullText);
  const responseId = Number.isSafeInteger(terminal.num_turns) && terminal.num_turns! > 0
    ? String(terminal.num_turns) : createHash("sha256").update(fullText).digest("hex").slice(0, 16);
  if (text.trim()) input.onProviderMessage?.({ id: `${conversationId}:${responseId}:assistant`,
    turnId: responseId, role: "assistant", content: text, tool: null, phase: null,
    ...(input.model ? { model: input.model, modelSource: "run" as const } : {}) });
  input.onProgress?.({ type: "done", text });
  return { text, sessionUUID: conversationId, model: input.model, toolsUsed: [...toolsUsed],
    durationMs: Date.now() - startedAt, ...(turnOutcome ? { turnOutcome } : {}) };
}
