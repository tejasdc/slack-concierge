import { forkCodexSession, ProgressCb, runCodexTurn, RunResult } from "./codex";
import { forkClaudeCodeSession, runClaudeCodeTurn } from "./claude-code";
import { providerSelectionFromText } from "./aliases";
import { ProviderId } from "./state";
import { SteeringSender } from "./steering";

export interface AgentProvider {
  id: ProviderId;
  run(input: {
    prompt: string;
    cwd: string;
    additionalDirs: string[];
    sessionUUID: string | null;
    sessionBindingToken?: string | null;
    onProgress?: ProgressCb;
    systemPrompt?: string;
    clientUserMessageId?: string;
    environment?: Record<string, string>;
    model?: string;
    reasoning_effort?: string;
    onSteeringReady?: (sender: SteeringSender) => void;
    onCancellationReady?: (cancel: () => Promise<void>) => void;
    onProviderTerminal?: () => void;
    onProviderThreadStarted?: (providerThreadId: string, providerBindingToken?: string | null) => void;
    onProviderTurnStarted?: (providerTurnId: string) => void;
  }): Promise<RunResult>;
  fork(input: {
    cwd: string;
    additionalDirs: string[];
    sessionUUID: string;
    sessionBindingToken?: string | null;
    lastTurnId?: string | null;
    threadSource?: string | null;
  }): Promise<RunResult>;
}

class CodexProvider implements AgentProvider {
  id: ProviderId = "codex";

  run(input: Parameters<AgentProvider["run"]>[0]) {
    return runCodexTurn({
      ...input,
      applicationInstructions: input.systemPrompt,
    });
  }

  fork(input: Parameters<AgentProvider["fork"]>[0]) {
    return forkCodexSession(input);
  }
}

class ClaudeCodeProvider implements AgentProvider {
  id: ProviderId = "claude-code";

  async run(input: Parameters<AgentProvider["run"]>[0]): Promise<RunResult> {
    return runClaudeCodeTurn(input);
  }

  async fork(input: Parameters<AgentProvider["fork"]>[0]): Promise<RunResult> {
    if (input.lastTurnId) {
      throw new Error("Claude Code does not expose a point-in-time fork boundary; use the latest-session /fork command instead.");
    }
    return forkClaudeCodeSession({ ...input, prompt: "Fork this session for Slack Concierge." });
  }
}

export const providers: Record<ProviderId, AgentProvider> = {
  codex: new CodexProvider(),
  "claude-code": new ClaudeCodeProvider(),
};

export function providerFromText(
  text: string,
  fallback: ProviderId,
  opts: { topLevel?: boolean; claudeCodeBotUserId?: string | null } = {},
): ProviderId {
  return providerSelectionFromText(text, fallback, opts).provider;
}
