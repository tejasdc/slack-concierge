import { forkCodexSession, ProgressCb, runCodexTurn, RunResult } from "./codex";
import { forkClaudeCodeSession, runClaudeCodeTurn, type ClaudeBackgroundWait } from "./claude-code";
import { providerSelectionFromText } from "./aliases";
import { ProviderId } from "./state";
import { SteeringSender } from "./steering";
import { assertProviderForkPolicy, ProviderCapabilityUnavailableError, type ProviderInteractionPolicy } from "./provider-policy";
import { forkClaudeHistory, readClaudeHistory, readClaudeHistoryDetail, readCodexHistory, readCodexHistoryDetail,
  type ProviderHistoryInput, type ProviderHistoryPage, type ProviderDetailInput } from "./provider-history";
import type { ProviderMessageCallback } from "./provider-history";

export type { ProviderInteractionPolicy } from "./provider-policy";
export type { ProviderHistoryInput, ProviderHistoryMessage, ProviderHistoryPage, ProviderDetailInput } from "./provider-history";

export interface ProviderCapabilities {
  send: boolean;
  stop: boolean;
  steer: boolean;
  consultation: boolean;
  history: boolean;
  fork: boolean;
  forkBoundary: "turn" | "message" | null;
  consultationFork: boolean;
  reason: string | null;
}

export interface AgentProvider {
  id: ProviderId;
  capabilities?: ProviderCapabilities;
  history?(input: ProviderHistoryInput): Promise<ProviderHistoryPage>;
  detail?(input: ProviderDetailInput): Promise<{ content: string }>;
  run(input: {
    prompt: string;
    cwd: string;
    additionalDirs: string[];
    sessionUUID: string | null;
    onProgress?: ProgressCb;
    onProviderMessage?: ProviderMessageCallback;
    systemPrompt?: string;
    clientUserMessageId?: string;
    environment?: Record<string, string>;
    interactionPolicy?: ProviderInteractionPolicy;
    model?: string;
    reasoning_effort?: string;
    onSteeringReady?: (sender: SteeringSender) => void;
    onCancellationReady?: (cancel: () => Promise<void>) => void;
    onProviderTerminal?: () => void;
    onBackgroundWait?: (wait: ClaudeBackgroundWait | null) => void;
    onInputAcknowledged?: () => void;
    onPreferredModel?: (model: string) => void;
    onProviderThreadStarted?: (providerThreadId: string) => void;
    onProviderTurnStarted?: (providerTurnId: string) => void;
  }): Promise<RunResult>;
  fork(input: {
    cwd: string;
    additionalDirs: string[];
    sessionUUID: string;
    lastTurnId?: string | null;
    threadSource?: string | null;
    interactionPolicy?: ProviderInteractionPolicy;
  }): Promise<RunResult>;
}

class CodexProvider implements AgentProvider {
  id: ProviderId = "codex";
  capabilities: ProviderCapabilities = { send: true, stop: true, steer: true, consultation: true,
    history: true, fork: true, forkBoundary: "turn", consultationFork: false, reason: null };
  history = readCodexHistory;
  detail = readCodexHistoryDetail;

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
  capabilities: ProviderCapabilities = { send: true, stop: true, steer: true, consultation: true,
    history: true, fork: true, forkBoundary: "message", consultationFork: false, reason: null };
  history = readClaudeHistory;
  detail = readClaudeHistoryDetail;

  async run(input: Parameters<AgentProvider["run"]>[0]): Promise<RunResult> {
    return runClaudeCodeTurn(input);
  }

  async fork(input: Parameters<AgentProvider["fork"]>[0]): Promise<RunResult> {
    assertProviderForkPolicy(input.interactionPolicy);
    if (input.lastTurnId) {
      return forkClaudeHistory({ sessionUuid: input.sessionUUID, cwd: input.cwd,
        boundary: input.lastTurnId, interactionPolicy: input.interactionPolicy });
    }
    return forkClaudeCodeSession({ ...input, prompt: "Fork this session for Slack Concierge." });
  }
}

class UnavailableChatGPTProvider implements AgentProvider {
  id: ProviderId = "chatgpt";
  capabilities: ProviderCapabilities = { send: false, stop: false, steer: false, consultation: false,
    history: false, fork: false, forkBoundary: null, consultationFork: false,
    reason: "The native ChatGPT capability adapter is not configured." };

  async run(): Promise<RunResult> {
    throw new ProviderCapabilityUnavailableError("send", this.capabilities.reason!);
  }

  async fork(): Promise<RunResult> {
    throw new ProviderCapabilityUnavailableError("fork", this.capabilities.reason!);
  }
}

export const providers: Record<ProviderId, AgentProvider> = {
  codex: new CodexProvider(),
  "claude-code": new ClaudeCodeProvider(),
  chatgpt: new UnavailableChatGPTProvider(),
};

export function providerFromText(
  text: string,
  fallback: ProviderId,
  opts: { topLevel?: boolean; claudeCodeBotUserId?: string | null } = {},
): ProviderId {
  return providerSelectionFromText(text, fallback, opts).provider;
}
