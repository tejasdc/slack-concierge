/**
 * Structured vs. synthetic rate-limit interpretation for the Claude CLI stream.
 *
 * The Claude Code CLI can emit two signals for the same turn:
 *   1. A structured `rate_limit_event` with `{ rate_limit_info: { status: 'allowed'|'rejected'|'warning', resetsAt } }`.
 *   2. An `assistant` row whose model is `<synthetic>` carrying "You've hit your weekly limit..." text.
 *
 * On 2026-11-19 the bot cached phantom "Nov 22" refusals when Anthropic returned both
 * `status:"allowed"` and a stale synthetic notice in the same stream. The terminal decision
 * at `bot/src/claude-code.ts:1549` read:
 *
 *   const usageExhausted = usageRejected || isClaudeUsageExhaustion(parsed.text);
 *
 * — which trusted the synthetic text even when the structured event said the turn was
 * allowed. See `docs/incidents/2026-11-19-opus-only-refusal-blocked-every-claude-turn.md`
 * (fault F4) and `docs/plans/2026-11-19-provider-account-rebuild-architecture.md` §6.
 *
 * This module owns the terminal rule. The parser latches `sawStructuredAllowed` /
 * `sawStructuredRejected` across the stream (so a late `allowed` doesn't erase an
 * earlier `rejected`) and the terminal verdict is:
 *
 *   sawStructuredRejected
 *     ? exhausted(structuredResetAtMs)
 *     : sawStructuredAllowed
 *         ? allowed()                            // structured beats synthetic
 *         : syntheticExhausted ? exhausted(syntheticResetAtMs) : allowed();
 *
 * The parser still runs the `<synthetic>` filter at `claude-code.ts:316-320` for its
 * original purpose (a synthetic row never flips `agentSpoke`); the signal object here
 * is the only thing that decides whether the terminal should cache a refusal.
 */

export type RateLimitEventPayload = {
  readonly rate_limit_info?: {
    readonly status?: string;
    readonly resetsAt?: string | number | null;
    readonly resetAt?: string | number | null;
    readonly rateLimitType?: string;
    readonly utilization?: number;
  };
};

export type RateLimitSignals = {
  sawStructuredAllowed: boolean;
  sawStructuredRejected: boolean;
  structuredResetAtMs: number | null;
  syntheticExhausted: boolean;
  syntheticResetAtMs: number | null;
  conflict: ConflictNote | null;
  observations: SignalObservation[];
};

export type ConflictNote = {
  readonly kind: 'synthetic-overrides-structured' | 'reset-mismatch';
  readonly detail: string;
};

export type SignalObservation = {
  readonly kind: 'structured' | 'synthetic' | 'clear';
  readonly status?: string;
  readonly resetAtMs?: number | null;
  readonly excerpt?: string;
};

export type TerminalVerdict = {
  readonly usageExhausted: boolean;
  readonly resetAtMs: number | null;
  readonly reason: 'structured-rejected' | 'structured-allowed' | 'synthetic-only' | 'no-signal';
  readonly conflict: ConflictNote | null;
};

export function emptySignals(): RateLimitSignals {
  return {
    sawStructuredAllowed: false,
    sawStructuredRejected: false,
    structuredResetAtMs: null,
    syntheticExhausted: false,
    syntheticResetAtMs: null,
    conflict: null,
    observations: [],
  };
}

/**
 * Called on every `rate_limit_event` from the stream. Latches both flags across
 * the whole turn — once rejected, always rejected until `clearSignals`.
 */
export function observeRateLimitEvent(signals: RateLimitSignals, event: RateLimitEventPayload): void {
  const status = event.rate_limit_info?.status;
  if (typeof status !== 'string') return;
  const resetAtMs = parseResetField(event.rate_limit_info?.resetsAt ?? event.rate_limit_info?.resetAt ?? null);
  if (status === 'rejected') {
    signals.sawStructuredRejected = true;
    if (resetAtMs !== null) signals.structuredResetAtMs = resetAtMs;
  } else if (status === 'allowed' || status === 'warning' || status === 'allowed_warning' || status === 'allow') {
    signals.sawStructuredAllowed = true;
  }
  signals.observations.push({ kind: 'structured', status, resetAtMs });
  updateConflict(signals);
}

/**
 * Called when a `<synthetic>` assistant row's text is seen. The text matcher is passed in
 * so that callers can keep their existing `isClaudeUsageExhaustion` locality; this module
 * does not own the regex.
 */
export function observeSyntheticText(
  signals: RateLimitSignals,
  text: string,
  matchesExhaustion: (text: string) => boolean,
  parseResetFromText: (text: string) => number | null = () => null,
): void {
  if (!text.trim()) return;
  if (!matchesExhaustion(text)) return;
  signals.syntheticExhausted = true;
  const resetAtMs = parseResetFromText(text);
  if (resetAtMs !== null) signals.syntheticResetAtMs = resetAtMs;
  signals.observations.push({ kind: 'synthetic', resetAtMs, excerpt: text.slice(0, 200) });
  updateConflict(signals);
}

/**
 * Reset the signals when the parser switches to a new model mid-turn (or a successor
 * subprocess takes over). Keeps `observations` for diagnostics; starts the latch anew.
 */
export function clearSignals(signals: RateLimitSignals): void {
  signals.sawStructuredAllowed = false;
  signals.sawStructuredRejected = false;
  signals.structuredResetAtMs = null;
  signals.syntheticExhausted = false;
  signals.syntheticResetAtMs = null;
  signals.conflict = null;
  signals.observations.push({ kind: 'clear' });
}

/**
 * Terminal decision. Structured beats synthetic; synthetic is a signal only when no
 * structured event arrived.
 */
export function terminalVerdict(signals: RateLimitSignals): TerminalVerdict {
  if (signals.sawStructuredRejected) {
    return { usageExhausted: true, resetAtMs: signals.structuredResetAtMs, reason: 'structured-rejected', conflict: signals.conflict };
  }
  if (signals.sawStructuredAllowed) {
    return { usageExhausted: false, resetAtMs: null, reason: 'structured-allowed', conflict: signals.conflict };
  }
  if (signals.syntheticExhausted) {
    return { usageExhausted: true, resetAtMs: signals.syntheticResetAtMs, reason: 'synthetic-only', conflict: signals.conflict };
  }
  return { usageExhausted: false, resetAtMs: null, reason: 'no-signal', conflict: null };
}

function parseResetField(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    // A plain integer reset could be epoch milliseconds or epoch seconds. Anthropic's
    // schema uses seconds but Concierge long normalized to ms. Distinguish by size.
    return value > 10_000_000_000 ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function updateConflict(signals: RateLimitSignals): void {
  if (signals.sawStructuredAllowed && signals.syntheticExhausted) {
    signals.conflict = {
      kind: 'synthetic-overrides-structured',
      detail: 'rate_limit_event said allowed; synthetic assistant row claimed exhaustion',
    };
    return;
  }
  if (signals.sawStructuredRejected && signals.structuredResetAtMs !== null && signals.syntheticResetAtMs !== null) {
    if (Math.abs(signals.structuredResetAtMs - signals.syntheticResetAtMs) > 60_000) {
      signals.conflict = {
        kind: 'reset-mismatch',
        detail: `structured reset ${signals.structuredResetAtMs} ms, synthetic reset ${signals.syntheticResetAtMs} ms`,
      };
    }
  }
}
