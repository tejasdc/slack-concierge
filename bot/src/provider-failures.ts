export type ProviderDispatchFailureClass = "retryable" | "parked_access" | "parked_terminal";

export class ProviderDispatchError extends Error {
  readonly failureClass: ProviderDispatchFailureClass;
  readonly terminalConfirmed: boolean;
  readonly toolsUsed: string[];
  readonly providerSessionId: string | null;
  readonly providerTurnId: string | null;

  constructor(input: {
    message: string;
    failureClass?: ProviderDispatchFailureClass;
    terminalConfirmed: boolean;
    toolsUsed?: string[];
    providerSessionId?: string | null;
    providerTurnId?: string | null;
  }) {
    super(input.message);
    this.name = "ProviderDispatchError";
    this.failureClass = input.failureClass || classifyProviderDispatchFailure(input.message);
    this.terminalConfirmed = input.terminalConfirmed;
    this.toolsUsed = input.toolsUsed || [];
    this.providerSessionId = input.providerSessionId || null;
    this.providerTurnId = input.providerTurnId || null;
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

export function providerRetryDelayMs(dispatchAttempt: number) {
  return Math.min(30 * 60_000, 15_000 * 2 ** Math.max(0, dispatchAttempt - 1));
}

export function providerDispatchError(error: unknown): ProviderDispatchError | null {
  return error instanceof ProviderDispatchError ? error : null;
}
