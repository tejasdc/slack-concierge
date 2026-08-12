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
    onProgress?: ProgressCb;
    systemPrompt?: string;
    model?: string;
    reasoning_effort?: string;
    onSteeringReady?: (sender: SteeringSender) => void;
    onProviderTerminal?: () => void;
  }): Promise<RunResult>;
  fork(input: {
    cwd: string;
    additionalDirs: string[];
    sessionUUID: string;
    atMessageIdx?: number;
  }): Promise<RunResult>;
}

class CodexProvider implements AgentProvider {
  id: ProviderId = "codex";

  run(input: Parameters<AgentProvider["run"]>[0]) {
    const prompt = input.systemPrompt ? `${input.systemPrompt}\n\n${input.prompt}` : input.prompt;
    return runCodexTurn({ ...input, prompt });
  }

  fork(input: Parameters<AgentProvider["fork"]>[0]) {
    const suffix = input.atMessageIdx == null ? "" : ` Fork from Slack message index ${input.atMessageIdx}.`;
    return forkCodexSession({ ...input, prompt: `Fork this session for Slack Concierge.${suffix}` });
  }
}

class ClaudeCodeProvider implements AgentProvider {
  id: ProviderId = "claude-code";

  async run(input: Parameters<AgentProvider["run"]>[0]): Promise<RunResult> {
    const prompt = input.systemPrompt ? `${input.systemPrompt}\n\n${input.prompt}` : input.prompt;
    return runClaudeCodeTurn({ ...input, prompt });
  }

  async fork(input: Parameters<AgentProvider["fork"]>[0]): Promise<RunResult> {
    const suffix = input.atMessageIdx == null ? "" : ` Fork from Slack message index ${input.atMessageIdx}.`;
    return forkClaudeCodeSession({ ...input, prompt: `Fork this session for Slack Concierge.${suffix}` });
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
