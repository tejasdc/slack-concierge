/**
 * The agent of an outside request (`sessions ask --outside`): the Codex command line, `codex exec`,
 * running in its own execution host unit. Concierge starts it and reads what it says from the host's
 * record, but never writes to it, never times it out and never pauses it; only Stop on its session
 * signals it. So a Concierge restart, update, Pause all or a fault in Concierge's own turn handling
 * cannot cut it off, which is what an agent repairing Concierge needs (Tejas, 2026-10-14: "All of
 * this outside-agents thing should work like a regular request").
 *
 * Everything else is the ordinary request: the session is a normal Codex session bound to the CLI's
 * thread, so its replies use `sessions reply` from this exact run, the managed Codex Stop hook finds
 * the run by that thread and sends the agent back if it owes a reply, its history is Codex's own
 * rollout, and a restart takes it back through the same host adoption as a Claude run.
 *
 * Why the command line and not the shared App Server: an App Server turn is driven by Concierge
 * (steering, interrupt, its inactivity limit), so a fault in Concierge reaches it. Why it is safe to
 * share the machine's Codex login with the App Server: Codex 0.162 reloads `auth.json` before it
 * renews and skips the renewal when another process already renewed ("Skipping token refresh because
 * auth changed after guarded reload"), so two processes on one file do not spend each other's token.
 * The logins lost on 2026-09-22 and 09-29 were separate copies of the file, which this never makes.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentProvider } from "./providers";
import type { ClaudeCodeTransport } from "./claude-code";
import type { RunResult } from "./codex";
import { splitTurnOutcomeMarker } from "./turn-outcome-marker";
import { ProviderDispatchError, ProviderTurnCancelledError, isCodexThreadWriterConflict, isModelCapacityRefusal } from "./provider-failures";
import { ProviderCapabilityUnavailableError } from "./provider-policy";
import { providerOwnerEnvironment } from "./provider-owner-environment";

export type OutsideRun = Parameters<AgentProvider["run"]>[0] & {
  /** The execution host that owns the process; a launch writes the prompt file first. */
  transport?: ClaudeCodeTransport;
  /** Taken back from a predecessor's host: its record replays and nothing is started again. */
  adopted?: boolean;
  /** Where the opening words are written for the CLI to read as its standard input. */
  promptFile: string;
  codexExecutable: string;
};

/**
 * Said to every outside agent, before its instructions, because it is the one thing that differs
 * from an agent inside Concierge: Concierge may be down while it works, and its reply is still owed.
 */
export const OUTSIDE_RUN_NOTE = "This run is outside Concierge's own process: Concierge started you and watches you, and a Concierge restart or update does not stop you. You still close your request with sessions reply like any agent, and you cannot end your turn while you owe it. If a router-actions.sh command answers that Concierge is unavailable or restarting, wait a minute and run the same command again with the same --action-id; do not end your turn until your final reply is accepted.";

type CodexEvent = {
  type?: string;
  thread_id?: string;
  item?: { id?: string; type?: string; text?: string; command?: string };
  error?: { message?: string };
  message?: string;
};

const MAX_PROTOCOL_LINE = 8 * 1024 * 1024;
const MAX_ERROR_TEXT = 1_000;
/**
 * Item kinds that are the agent talking or thinking, not using a tool. An `error` item is the
 * CLI reporting trouble (a 503 reconnect, a transport fallback); counting it as a tool made a
 * run that did nothing look worked-on, so its refusal could never be retried.
 */
const NOT_TOOLS = new Set(["agent_message", "reasoning", "error"]);

export async function runOutsideCodexTurn(input: OutsideRun): Promise<RunResult> {
  if (input.interactionPolicy === "consultation-only")
    throw new ProviderCapabilityUnavailableError("consultation", "An outside run has no information-only policy.");
  if (!input.transport)
    throw new ProviderCapabilityUnavailableError("execution", "An outside run needs an execution host on this machine.");

  const content = [input.systemPrompt, OUTSIDE_RUN_NOTE, input.prompt].filter(Boolean).join("\n\n");
  if (!input.adopted) {
    mkdirSync(dirname(input.promptFile), { recursive: true, mode: 0o700 });
    writeFileSync(input.promptFile, content, { mode: 0o600 });
  }
  // `sh` hands the prompt file to Codex as its standard input, so the CLI reads its opening words to
  // the end and the host's own input pipe (which stays open for its whole life) is never needed.
  const codexArgs = ["exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-C", input.cwd,
    ...(input.model ? ["-m", input.model] : []),
    ...(input.reasoning_effort ? ["-c", `model_reasoning_effort="${input.reasoning_effort}"`] : []),
    ...input.additionalDirs.flatMap(directory => ["--add-dir", directory]),
    ...(input.sessionUUID ? ["resume", input.sessionUUID] : []), "-"];
  const args = ["-c", 'exec "$@" < "$0"', input.promptFile, input.codexExecutable, ...codexArgs];

  let buffer = "";
  let threadId = input.sessionUUID ?? null;
  let finalText = "";
  let completed = false;
  let failure: string | null = null;
  let observedOutput = false;
  let acknowledged = false;
  let cancelRequested = false;
  let stderrTail = "";
  let interrupt: (() => Promise<void>) | null = null;
  const toolsUsed = new Set<string>();
  const startedAt = Date.now();

  const bind = (id: unknown) => {
    if (typeof id !== "string" || !id) return;
    if (threadId && threadId !== id)
      throw new ProviderDispatchError({ message: "Codex answered on a different conversation from the bound session.",
        terminalConfirmed: false, assistantOutput: observedOutput, providerSessionId: threadId });
    if (!threadId) { threadId = id; input.onProviderThreadStarted?.(id); }
  };
  const handle = (event: CodexEvent) => {
    if (event.type === "thread.started") { bind(event.thread_id); return; }
    if (event.type === "turn.started") {
      if (!acknowledged) { acknowledged = true; input.onInputAcknowledged?.(); }
      input.onProgress?.({ type: "started" });
      return;
    }
    const item = event.item;
    if ((event.type === "item.started" || event.type === "item.completed") && item?.type && !NOT_TOOLS.has(item.type)) {
      const itemId = item.id ?? item.type;
      if (event.type === "item.started") { toolsUsed.add(item.type); input.onProgress?.({ type: "tool_started", toolName: item.type, itemId }); }
      else { toolsUsed.add(item.type); input.onProgress?.({ type: "tool_finished", toolName: item.type, itemId }); }
      return;
    }
    if (event.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") {
      observedOutput = true;
      finalText = item.text;
      input.onProgress?.({ type: "commentary", text: item.text });
      return;
    }
    if (event.type === "turn.completed") { completed = true; return; }
    if (event.type === "turn.failed") { failure = event.error?.message ?? "Codex reported the turn failed."; return; }
    if (event.type === "error" && typeof event.message === "string") failure = event.message;
  };

  try {
    const exit = await input.transport.run({
      args, cwd: input.cwd,
      environment: providerOwnerEnvironment(input.environment),
      stdin: "",
      onStdout: chunk => {
        buffer += chunk;
        if (buffer.length > MAX_PROTOCOL_LINE)
          throw new ProviderDispatchError({ message: "Codex's structured output exceeded the supported line size.",
            terminalConfirmed: false, assistantOutput: observedOutput, providerSessionId: threadId });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          // The CLI writes a few plain lines (warnings) among its events; they are not the protocol.
          let event: CodexEvent;
          try { event = JSON.parse(line) as CodexEvent; } catch { continue; }
          handle(event);
        }
      },
      // Not copied into a visible error: the CLI controls it and may name local machine details.
      onStderr: chunk => { stderrTail = (stderrTail + chunk).slice(-MAX_ERROR_TEXT); },
      onInterruptReady: ready => {
        interrupt = ready;
        input.onCancellationReady?.(async () => { cancelRequested = true; await interrupt!(); });
      },
    });
    input.onProviderTerminal?.();
    if (cancelRequested && !completed) throw new ProviderTurnCancelledError("The outside Codex run was stopped.");
    if (!completed) {
      const signedOut = /401 Unauthorized|token_expired|refresh_token_reused|sign in again|not logged in/i.test(`${failure ?? ""} ${stderrTail}`);
      const threadWriterConflict = isCodexThreadWriterConflict(`${failure ?? ""} ${stderrTail}`);
      // A capacity refusal the CLI printed only on stderr (a resumed run's remote compaction died
      // on one on 2026-10-16 with no error event, so the run read as "ended with code 1").
      const capacityOnStderr = failure === null && isModelCapacityRefusal(stderrTail)
        ? "Selected model is at capacity. Please try a different model." : null;
      throw new ProviderDispatchError({
        message: (threadWriterConflict ? "This Codex conversation is already held by another writer."
          : failure ?? capacityOnStderr ?? (signedOut ? "Codex is signed out on this machine."
          : `Codex ended ${exit.signal ? `on signal ${exit.signal}` : `with code ${exit.code}`} before finishing its turn.`)).slice(0, MAX_ERROR_TEXT),
        // The process has exited, so the turn is over. It is known to have done nothing when it
        // never began a turn, or when the CLI itself reported the failure (turn.failed, an error
        // event, or a capacity refusal on stderr) and no output or tool item ever appeared.
        terminalConfirmed: (!acknowledged || failure !== null || capacityOnStderr !== null || threadWriterConflict) && !observedOutput && toolsUsed.size === 0,
        threadWriterConflict,
        assistantOutput: observedOutput, providerSessionId: threadId, toolsUsed: [...toolsUsed] });
    }
    if (!threadId)
      throw new ProviderDispatchError({ message: "Codex answered without a conversation ID, so this session cannot continue it.",
        terminalConfirmed: true, assistantOutput: observedOutput, toolsUsed: [...toolsUsed] });
    const { text, mark: turnOutcome } = splitTurnOutcomeMarker(finalText);
    input.onProgress?.({ type: "done", text });
    return { text, sessionUUID: threadId, model: input.model, toolsUsed: [...toolsUsed],
      durationMs: Date.now() - startedAt, ...(turnOutcome ? { turnOutcome } : {}) };
  } finally {
    rmSync(input.promptFile, { force: true });
  }
}
