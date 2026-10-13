import type { AgentProvider } from "./providers";
import type { ClaudeCodeTransport } from "./claude-code";
import type { RunResult } from "./codex";
import { splitTurnOutcomeMarker } from "./turn-outcome-marker";
import { ProviderDispatchError, ProviderTurnCancelledError } from "./provider-failures";
import { ProviderCapabilityUnavailableError } from "./provider-policy";
import { providerOwnerEnvironment } from "./provider-owner-environment";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { SteeringNotSentError } from "./steering";
import { WriteOutcomeUnknownError } from "./execution-host-client";

/** Execution hosts have a supervisor PATH, so resolve the CLI on the owner before launch. */
export function antigravityExecutable(): string {
  // The subscription has a separate paid-credit pool. A change to the CLI setting must
  // never make Concierge silently buy more work after the included quota is spent.
  try {
    const settings = JSON.parse(readFileSync(join(homedir(), ".gemini/antigravity-cli/settings.json"), "utf8"));
    if (settings?.useG1Credits === true) throw new ProviderCapabilityUnavailableError(
      "execution", "Google AI credit overages are enabled; subscription-only dispatch is paused.");
  } catch (error) {
    if (error instanceof ProviderCapabilityUnavailableError) throw error;
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw new ProviderCapabilityUnavailableError(
      "execution", "Google's credit setting could not be verified.");
  }
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
  /** Taken back from a predecessor's host: its record replays before any decision acts. */
  adopted?: boolean;
};

type AntigravityEvent = {
  event?: string;
  conversation_id?: string;
  init?: { cwd?: string; permission_mode?: string };
  step_update?: { step_index?: number; step_type?: string; state?: string; text_delta?: string;
    tool_name?: string; tool_info?: { error?: { type?: string; message?: string } } };
  result?: {
    conversation_id?: string;
    status?: string;
    response?: string;
    error?: string;
    num_turns?: number;
    usage?: { total_tokens?: number };
  };
};

const MAX_PROTOCOL_LINE = 8 * 1024 * 1024;
const MAX_ERROR_TEXT = 1_000;
/** How long after a result a message already written may take to be picked up before the run ends. */
const STEERING_PICKUP_GRACE_MS = 15_000;

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
  let cancelRequested = false;
  let sawInit = false;
  let permissionDenied = false;
  let stderrTail = "";
  let closeInput: (() => void) | null = null;
  let writeInput: ((line: string, meta?: { kind: "steering"; clientMessageId: string; commandId: string }) => Promise<void>) | null = null;
  let interruptInput: (() => Promise<void>) | null = null;
  // Steering: the headless CLI reads one message per stdin line and runs a turn for each, in order,
  // in this same process. A message written while a turn runs is picked up (its `user_input` step
  // DONE) as soon as that turn's result is out; it cannot join the turn already running. So the
  // run's input stays open until every written message has been picked up and answered, and each
  // pickup acknowledges exactly the oldest written message (FIFO).
  type Written = { clientMessageId: string | null; resolve?: () => void; reject?: (error: Error) => void };
  const written: Written[] = [];
  let pickups = 0;
  let replaying = !!input.adopted;
  let inputClosed = false;
  let closeOwed = false;
  let pickupGrace: ReturnType<typeof setTimeout> | null = null;
  let steeringRegistered = false;
  const toolsUsed = new Set<string>();
  const startedAt = Date.now();

  const acknowledge = () => {
    if (acknowledged) return;
    acknowledged = true;
    input.onInputAcknowledged?.();
  };
  const endInput = (reason: Error) => {
    if (replaying) { closeOwed = true; return; }
    if (inputClosed) return;
    inputClosed = true;
    if (pickupGrace) { clearTimeout(pickupGrace); pickupGrace = null; }
    // Written but never picked up: it reached the CLI's input, so it is uncertain, never resent.
    for (const entry of written.splice(0)) entry.reject?.(reason);
    closeInput?.();
  };
  const afterResult = () => {
    if (written.length === 0) { endInput(new Error("Gemini finished before reading this message.")); return; }
    if (replaying || pickupGrace) return;
    pickupGrace = setTimeout(() => {
      pickupGrace = null;
      if (written.length) endInput(new Error("Gemini did not pick up this message after finishing its answer."));
    }, STEERING_PICKUP_GRACE_MS);
  };
  const registerSteering = () => {
    if (steeringRegistered || replaying || inputClosed || !writeInput || !acknowledged) return;
    steeringRegistered = true;
    input.onSteeringReady?.(steering => new Promise<void>((resolve, reject) => {
      if (inputClosed || !writeInput) {
        reject(new SteeringNotSentError("Gemini finished before this message arrived."));
        return;
      }
      const entry: Written = { clientMessageId: steering.clientMessageId, resolve, reject };
      written.push(entry);
      void writeInput(JSON.stringify({ event: "user", message: { content: steering.text } }) + "\n",
        { kind: "steering", clientMessageId: steering.clientMessageId, commandId: `steer-${steering.clientMessageId}` })
        .catch(error => {
          const index = written.indexOf(entry);
          if (index >= 0) written.splice(index, 1);
          // A write the pipe refused never reached Gemini, so the owner may queue it as ordinary
          // work; a write whose outcome the host could not confirm stays uncertain.
          reject(error instanceof WriteOutcomeUnknownError ? error : new SteeringNotSentError(
            `Gemini did not accept this message: ${error instanceof Error ? error.message : String(error)}`));
          if (terminal) afterResult();
        });
    }));
  };
  const pickedUp = () => {
    pickups += 1;
    if (pickups === 1) { acknowledge(); registerSteering(); return; }
    // A new turn began in this run for the oldest written message; the previous result no longer
    // describes the live work.
    terminal = null;
    if (pickupGrace) { clearTimeout(pickupGrace); pickupGrace = null; }
    const entry = written.shift();
    if (entry?.clientMessageId) input.onProgress?.({ type: "steering", clientMessageId: entry.clientMessageId });
    entry?.resolve?.();
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
      sawInit = true;
      // The headless CLI otherwise soft-denies shell actions and may still return SUCCESS.
      // The flag is our requested policy; the init event is proof of the effective policy.
      if (event.init?.permission_mode !== "always-proceed") {
        throw new ProviderDispatchError({ message: "Google did not activate the required unattended tool permissions.",
          terminalConfirmed: false, providerSessionId: conversationId });
      }
      input.onProgress?.({ type: "started" });
      return;
    }
    if (event.event === "step_update" && event.step_update) {
      const step = event.step_update;
      if (step.step_type === "user_input" && step.state === "DONE") pickedUp();
      if (step.step_type === "agent_response" && step.text_delta) {
        observedOutput = true;
        input.onProgress?.({ type: "commentary", text: step.text_delta });
      } else if (step.step_type && !["agent_response", "user_input"].includes(step.step_type)) {
        const toolName = step.tool_name || step.step_type;
        if (step.step_type === "tool") {
          toolsUsed.add(toolName);
          const problem = `${step.tool_info?.error?.type ?? ""} ${step.tool_info?.error?.message ?? ""}`;
          if (/permission|approv|denied|forbidden/i.test(problem)) permissionDenied = true;
        }
        if (step.state === "DONE") input.onProgress?.({ type: "tool_use", toolName });
      }
      return;
    }
    if (event.event === "result" && event.result) {
      bind(event.result.conversation_id);
      terminal = event.result;
      if (Number.isSafeInteger(event.result.num_turns) && event.result.num_turns! > 0)
        input.onProviderTurnStarted?.(String(event.result.num_turns));
      if (event.result.status === "SUCCESS") acknowledge();
      // An answer followed by a steered message's turn is shown as its own message now; the run's
      // final result is the last answer.
      if (written.length && conversationId && event.result.response?.trim()) {
        const answer = splitTurnOutcomeMarker(event.result.response).text;
        if (answer.trim()) input.onProviderMessage?.({ id: `${conversationId}:${event.result.num_turns ?? createHash("sha256").update(answer).digest("hex").slice(0, 16)}:assistant`,
          turnId: String(event.result.num_turns ?? ""), role: "assistant", content: answer, tool: null, phase: null,
          ...(input.model ? { model: input.model, modelSource: "run" as const } : {}) });
      }
      afterResult();
    }
  };

  const exit = await input.transport.run({
    args, cwd: input.cwd,
    environment: { ...providerOwnerEnvironment(input.environment), AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
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
    onStderr: chunk => {
      stderrTail = (stderrTail + chunk).slice(-MAX_ERROR_TEXT);
      if (/soft.denied|permission.{0,30}denied|approval.{0,30}(?:denied|unavailable)|requires.{0,30}approval/i.test(stderrTail))
        permissionDenied = true;
    },
    onInterruptReady: interrupt => { interruptInput = interrupt; },
    // A predecessor's steering write: it holds the input open until Gemini picks it up.
    onReplayedInput: (_line, meta) => { if (meta?.kind === "steering") written.push({ clientMessageId: meta.clientMessageId ?? null }); },
    onReplayEnd: () => {
      replaying = false;
      if (closeOwed || (terminal && written.length === 0)) endInput(new Error("Gemini finished before reading this message."));
      else { if (terminal) afterResult(); registerSteering(); }
    },
    onStdinReady: (write, close) => {
      closeInput = close;
      writeInput = write;
      registerSteering();
      input.onCancellationReady?.(async () => {
        if (!interruptInput) throw new Error("The Google process cannot be interrupted yet.");
        cancelRequested = true;
        await interruptInput();
      });
    },
  });
  input.onProviderTerminal?.();
  if (pickupGrace) clearTimeout(pickupGrace);
  for (const entry of written.splice(0)) entry.reject?.(new Error("Gemini's process ended before reading this message."));
  if (cancelRequested && (terminal?.status === "CANCELED" || terminal?.status === "INTERRUPTED"))
    throw new ProviderTurnCancelledError("The Google turn was stopped.");
  const needsSignIn = /authentication required|please sign in|not logged in|oauth.*expired/i.test(
    `${terminal?.error ?? ""} ${stderrTail}`);
  // The CLI can reject a model before emitting init. Its structured result proves
  // zero turns and zero tokens in that case; treating every missing init as an
  // ambiguous run left the request waiting after a definite failed start.
  const refusedBeforeStart = !sawInit && terminal?.status === "ERROR"
    && terminal.num_turns === 0 && terminal.usage?.total_tokens === 0
    && !observedOutput && toolsUsed.size === 0 && !needsSignIn;
  if (!terminal) {
    throw new ProviderDispatchError({ message: needsSignIn ? "Google authentication required on this machine."
      : exit.code === 0
      ? "Google exited without a final structured result."
      : "Google exited before confirming a final result.",
      terminalConfirmed: needsSignIn && !sawInit && !observedOutput,
      assistantOutput: observedOutput, providerSessionId: conversationId,
      toolsUsed: [...toolsUsed] });
  }
  if ((!sawInit && !refusedBeforeStart) || permissionDenied) {
    throw new ProviderDispatchError({ message: needsSignIn && !sawInit
      ? "Google authentication required on this machine."
      : !sawInit
      ? "Google returned no structured start event; its tool policy could not be verified."
      : "Google denied a requested tool during the run, so its answer cannot be marked complete.",
      terminalConfirmed: needsSignIn && !sawInit && !observedOutput,
      assistantOutput: observedOutput, providerSessionId: conversationId,
      toolsUsed: [...toolsUsed] });
  }
  // The CLI's terminal result is the turn outcome. Closing its streaming stdin can make the
  // host stop an otherwise idle process after that result; its later process code is not a
  // second verdict on work the provider already marked successful.
  if (terminal.status !== "SUCCESS") {
    // ERROR says the run ended, not that it had no effects. Only zero-turn refusals are
    // replay-safe; an error after Google began a turn stays unconfirmed for inspection.
    const beforeTurn = terminal.num_turns === 0 && terminal.usage?.total_tokens === 0
      && !observedOutput && toolsUsed.size === 0;
    const quotaRefusal = /RESOURCE_EXHAUSTED|individual quota reached|quota exhausted/i.test(terminal.error ?? "");
    let clearsAtMs: number | null = null;
    if (quotaRefusal && beforeTurn) {
      // The error's prose may contain a duration, but only Google's fresh structured quota
      // reply can name a reset we may queue against.
      const { scheduleProviderAccountUsageRefresh, providerAccountUsage } = await import("./provider-account-usage");
      await scheduleProviderAccountUsageRefresh().catch(() => {});
      const usage = providerAccountUsage("antigravity");
      const account = usage?.accounts.find(item => item.current && !item.problem);
      if (!usage?.problem && account) {
        const spent = account.windows.filter(window => window.usedPercent >= 100)
          .map(window => Date.parse(window.resetsAt ?? "")).filter(Number.isFinite);
        if (spent.length) clearsAtMs = Math.max(...spent);
      }
    }
    throw new ProviderDispatchError({ message: (terminal.error || `Google ended with ${terminal.status ?? "unknown status"}.`).slice(0, MAX_ERROR_TEXT),
      terminalConfirmed: beforeTurn, assistantOutput: observedOutput, providerSessionId: conversationId,
      clearsAtMs, toolsUsed: [...toolsUsed] });
  }
  if (!conversationId) {
    throw new ProviderDispatchError({ message: "Google answered without a conversation ID, so this session cannot preserve continuity.",
      terminalConfirmed: true, assistantOutput: true, toolsUsed: [...toolsUsed] });
  }
  const fullText = terminal.response ?? "";
  // A bounded historical run returned SUCCESS at its time limit with no reply after
  // editing files. Those effects cannot be summarized as a completed turn.
  if (!fullText.trim()) {
    throw new ProviderDispatchError({ message: "Google ended without a final reply, so the work outcome is unconfirmed.",
      terminalConfirmed: false, assistantOutput: observedOutput, providerSessionId: conversationId,
      toolsUsed: [...toolsUsed] });
  }
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
