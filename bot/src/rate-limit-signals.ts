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
    /**
     * Anthropic's structured reason the refusal cannot be bypassed by paid credits.
     * `out_of_credits`: paid credits exhausted — operator action is "buy more".
     * `org_level_disabled`: org admin turned overage off — operator action is to enable.
     * `hard_limit_reached`: account at its billing-plan hard cap.
     * `null`/absent: refusal clears at `resetsAt`, no overage story.
     */
    readonly overageDisabledReason?: string | null;
  };
};

export type OverageReason = 'out_of_credits' | 'org_level_disabled' | 'hard_limit_reached' | 'other' | null;

export type RateLimitSignals = {
  sawStructuredAllowed: boolean;
  sawStructuredRejected: boolean;
  /**
   * M2 (2026-11-19): true for ANY structured `rate_limit_event`, regardless of the
   * `status` enum value. If Anthropic ships a new status ("throttled", "degraded",
   * anything), stale synthetic text must not win — the fact that the provider
   * spoke at all is what beats synthetic text. Only `sawStructuredRejected` with
   * a known status enters the "yes it refused" terminal branch; `sawStructured`
   * alone is enough to suppress a stale synthetic verdict.
   */
  sawStructured: boolean;
  structuredResetAtMs: number | null;
  /** The provider's rate_limit_type on the most recent rejected event ("seven_day", "five_hour", "daily", …). */
  structuredRateLimitType: string | null;
  /** The provider's overageDisabledReason on the most recent rejected event, normalized. */
  overageReason: OverageReason;
  syntheticExhausted: boolean;
  syntheticResetAtMs: number | null;
  conflict: ConflictNote | null;
  observations: SignalObservation[];
};

export type ConflictNote = {
  readonly kind: 'synthetic-overrides-structured' | 'reset-mismatch' | 'rate_limit_event_account_mismatch';
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
  readonly rateLimitType: string | null;
  readonly overageReason: OverageReason;
};

/**
 * A fresh account reading summary — just the resets the labeled account's windows
 * actually reported. Used by `detectAccountMismatch` to spot a refusal whose resetsAt
 * matches no window of the labeled account (strong signal of a wrong-home binding).
 */
export type AccountWindowResets = {
  readonly accountLabel: string;
  readonly windowResetAtMs: readonly number[];
};

/**
 * Detect `rate_limit_event_account_mismatch`: a refusal with a known resetAtMs whose
 * value matches NO window in the fresh reading for the labeled account. The 2026-11-19
 * incident revealed this when chann.app's Nov-22 reset came back from an API call the
 * dispatcher labeled as hey@tejas.nyc's; hey's windows ended Nov-19, nowhere near Nov-22.
 *
 * Returns `null` when no mismatch is detectable (no structured reset, no reading, or any
 * window within 60 seconds of the structured reset). Returns a conflict note otherwise.
 */
export function detectAccountMismatch(
  signals: RateLimitSignals,
  reading: AccountWindowResets | null,
): ConflictNote | null {
  if (!signals.sawStructuredRejected) return null;
  if (signals.structuredResetAtMs === null) return null;
  if (!reading || reading.windowResetAtMs.length === 0) return null;
  const withinWindow = reading.windowResetAtMs.some(ms => Math.abs(ms - signals.structuredResetAtMs!) < 60_000);
  if (withinWindow) return null;
  return {
    kind: 'rate_limit_event_account_mismatch',
    detail: `rate_limit_event resetsAt ${new Date(signals.structuredResetAtMs).toISOString()} matches no window of account "${reading.accountLabel}"; refusal likely belongs to a different account`,
  };
}

export function emptySignals(): RateLimitSignals {
  return {
    sawStructuredAllowed: false,
    sawStructuredRejected: false,
    sawStructured: false,
    structuredResetAtMs: null,
    structuredRateLimitType: null,
    overageReason: null,
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
  // M2 (2026-11-19): record that the provider SPOKE, regardless of whether we
  // recognize the status enum. A future "throttled" or "degraded" must still
  // beat stale synthetic text.
  signals.sawStructured = true;
  const resetAtMs = parseResetField(event.rate_limit_info?.resetsAt ?? event.rate_limit_info?.resetAt ?? null);
  if (status === 'rejected') {
    signals.sawStructuredRejected = true;
    if (resetAtMs !== null) signals.structuredResetAtMs = resetAtMs;
    const rateLimitType = event.rate_limit_info?.rateLimitType;
    if (typeof rateLimitType === 'string' && rateLimitType) signals.structuredRateLimitType = rateLimitType;
    signals.overageReason = normalizeOverageReason(event.rate_limit_info?.overageDisabledReason ?? null);
  } else if (status === 'allowed' || status === 'warning' || status === 'allowed_warning' || status === 'allow') {
    signals.sawStructuredAllowed = true;
  }
  // Any other known-to-us status (new/unknown) still sets sawStructured but
  // not sawStructuredAllowed / sawStructuredRejected — the terminal rule
  // treats it as "not exhausted" (no explicit refusal) while still suppressing
  // the synthetic-only branch.
  signals.observations.push({ kind: 'structured', status, resetAtMs });
  updateConflict(signals);
}

function normalizeOverageReason(raw: string | null | undefined): OverageReason {
  if (raw === null || raw === undefined) return null;
  const lowered = String(raw).toLowerCase();
  if (lowered === 'out_of_credits') return 'out_of_credits';
  if (lowered === 'org_level_disabled') return 'org_level_disabled';
  if (lowered === 'hard_limit_reached') return 'hard_limit_reached';
  return 'other';
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
  signals.sawStructured = false;
  signals.structuredResetAtMs = null;
  signals.structuredRateLimitType = null;
  signals.overageReason = null;
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
    return { usageExhausted: true, resetAtMs: signals.structuredResetAtMs, reason: 'structured-rejected',
      conflict: signals.conflict, rateLimitType: signals.structuredRateLimitType, overageReason: signals.overageReason };
  }
  if (signals.sawStructuredAllowed) {
    return { usageExhausted: false, resetAtMs: null, reason: 'structured-allowed',
      conflict: signals.conflict, rateLimitType: null, overageReason: null };
  }
  // M2: a structured event with an unknown status (e.g. future "throttled") still
  // suppresses synthetic-only exhaustion. The provider spoke; the synthetic string
  // is stale CLI notice text we should not trust against it.
  if (signals.sawStructured) {
    return { usageExhausted: false, resetAtMs: null, reason: 'structured-allowed',
      conflict: signals.conflict, rateLimitType: signals.structuredRateLimitType, overageReason: null };
  }
  if (signals.syntheticExhausted) {
    return { usageExhausted: true, resetAtMs: signals.syntheticResetAtMs, reason: 'synthetic-only',
      conflict: signals.conflict, rateLimitType: null, overageReason: null };
  }
  return { usageExhausted: false, resetAtMs: null, reason: 'no-signal', conflict: null,
    rateLimitType: null, overageReason: null };
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
