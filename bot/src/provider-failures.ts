import { retryDelayMs } from './retry';
import { RETRY_POLICIES } from './retry-policies';

export type ProviderDispatchFailureClass = "retryable" | "parked_access" | "parked_terminal";

export function isClaudeUsageExhaustion(message: string) {
  return /^(?:you(?:'|’)re out of usage credits\b|you(?:'|’)ve hit your (?:(?:weekly|daily|monthly|session|usage|extra usage) )?limit\b)/i.test(message);
}

/**
 * Claude refusing a turn because the conversation no longer fits its window. Compaction
 * fixes exactly this, so it is the one refusal worth recovering from in place rather than
 * showing him. His own two-sentence message hit it at 979k of a 1M window on 2026-09-22.
 */
export function isContextOverflowRefusal(message: string) {
  return /\bprompt is too long\b|\bconversation is too long\b|\bcontext (?:window )?(?:limit )?exceeded\b/i.test(message);
}

export class ProviderTurnCancelledError extends Error {
  constructor(message = "Turn stopped from Slack.") {
    super(message);
    this.name = "ProviderTurnCancelledError";
  }
}

export class ProviderDispatchError extends Error {
  readonly failureClass: ProviderDispatchFailureClass;
  readonly terminalConfirmed: boolean;
  readonly toolsUsed: string[];
  /** Whether the provider produced assistant content, even if its turn later failed. */
  readonly assistantOutput: boolean;
  readonly providerSessionId: string | null;
  readonly providerTurnId: string | null;
  /** Retry at once: he chose another model for a message stuck in a provider outage. */
  readonly immediateRetry: boolean;
  /**
   * The instant this refusal's own condition is known to clear, when the provider stated
   * one — a usage allowance reset. Set it only where nothing was sent or the provider
   * confirmed it did nothing, because it is what turns a refusal into a wait instead of a
   * death: the input keeps its place and is tried again then. Null means unknown, and an
   * unknown clearance is never guessed.
   */
  readonly clearsAtMs: number | null;

  constructor(input: {
    message: string;
    failureClass?: ProviderDispatchFailureClass;
    terminalConfirmed: boolean;
    toolsUsed?: string[];
    assistantOutput?: boolean;
    providerSessionId?: string | null;
    providerTurnId?: string | null;
    immediateRetry?: boolean;
    clearsAtMs?: number | null;
  }) {
    super(input.message);
    this.name = "ProviderDispatchError";
    this.failureClass = input.failureClass || classifyProviderDispatchFailure(input.message);
    this.terminalConfirmed = input.terminalConfirmed;
    this.toolsUsed = input.toolsUsed || [];
    this.assistantOutput = input.assistantOutput === true;
    this.providerSessionId = input.providerSessionId || null;
    this.providerTurnId = input.providerTurnId || null;
    this.immediateRetry = input.immediateRetry === true;
    const clears = input.clearsAtMs;
    this.clearsAtMs = typeof clears === "number" && Number.isSafeInteger(clears) && clears > Date.now() ? clears : null;
  }
}

export function classifyProviderDispatchFailure(message: string): ProviderDispatchFailureClass {
  const normalized = message.toLowerCase();
  if (
    /\b429\b|\b5\d\d\b/.test(normalized)
    || /rate[ -]?limit|overload|temporar(?:y|ily)|service unavailable|gateway timeout|internal server error/.test(normalized)
  ) {
    return "retryable";
  }
  if (
    /disabled .*subscription|subscription access|api key|unauthori[sz]ed|forbidden|not logged in|permission denied|entitlement|billing/.test(normalized)
  ) {
    return "parked_access";
  }
  return "parked_terminal";
}

// True only for auth failures a fresh interactive login can actually repair.
// Entitlement, billing, and admin-disabled-subscription failures are excluded:
// re-authenticating the same account cannot restore access that was withdrawn.
export function isRefreshableAuthFailure(message: string): boolean {
  const normalized = message.toLowerCase();
  const entitlement = /disabled .*subscription|subscription access|entitlement|billing|ask your admin|use an? .*api key/.test(normalized);
  if (entitlement) return false;
  return /authenticat|oauth|not logged in|\blog[ -]?in\b|unauthori[sz]ed|\b401\b|session expired|credential|token expired/.test(normalized);
}

export type ProviderRefusalContinuationReason={kind:'provider_refused';refusal:'usage'|'rate_limit'|'sign_in';
  detail:string;waitUntilMs?:number|null};

/** Shared by live failure handling and the one-time recent-backlog pass. */
export function providerRefusalContinuationReason(message:string,clearsAtMs:number|null,
  failedAtMs:number,attempt:number):ProviderRefusalContinuationReason|null {
  const detail=message.slice(0,500);
  if(isRefreshableAuthFailure(message))return {kind:'provider_refused',refusal:'sign_in',detail};
  if(isClaudeUsageExhaustion(message)||/usage.*exhaust|out of usage|you(?:'|’)ve hit your .*limit|usage credits/i.test(message))
    return {kind:'provider_refused',refusal:'usage',detail,waitUntilMs:clearsAtMs};
  if(/\b429\b|rate[ -]?limit|too many requests/i.test(message))return {kind:'provider_refused',
    refusal:'rate_limit',detail,waitUntilMs:failedAtMs+providerRetryDelayMs(attempt)};
  return null;
}

export function providerRetryDelayMs(dispatchAttempt: number) {
  return retryDelayMs(RETRY_POLICIES.providerRequest, dispatchAttempt);
}

export function providerDispatchError(error: unknown): ProviderDispatchError | null {
  return error instanceof ProviderDispatchError ? error : null;
}
