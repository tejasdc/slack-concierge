/**
 * When the system spends a banked allowance reset without being asked.
 *
 * Tejas reversed the earlier "nothing ever spends one for you" on 2026-09-23: "if you're
 * running low and I'm not awake and I'm asleep, or especially if both our accounts are
 * running low, feel free to use the usage. You don't have to wait for me to reset the
 * usage." So a reset is now spent to keep work moving, and the Accounts button stays for
 * when he wants to spend one himself.
 *
 * The rule lives here as a pure function so it can be read, and run, on its own — no
 * ledger, no provider, no clock. Everything it needs is passed in, which is also how it can
 * be exercised against real readings without spending a real grant.
 *
 * Three things decide it, and none of them is a guess about him:
 *
 * - **Work has actually stopped.** The trigger is a usage refusal that held accepted work,
 *   not a forecast that it might. That is observed fact rather than a prediction, and it is
 *   also the moment a reset is worth the most: spending one earlier throws away whatever is
 *   left in the window it replaces.
 * - **There is no cheaper way out.** If another account of the same provider still has
 *   room, the work has somewhere to go and a finite grant should not be burned. His
 *   "especially if both our accounts are running low" is exactly this condition failing.
 * - **The grant is still there.** Whether he has acted is never inferred, and neither is
 *   whether he is awake. The only thing read is whether a reset is still available at the
 *   instant work stopped. If he already spent it, there is nothing to spend; if he has not,
 *   waiting for him to wake up is the stall he asked us to end.
 */

export type ResetCandidate = Readonly<{ account: string; available: number; expiresAt: string | null }>;

export type ResetDecision =
  | Readonly<{ use: true; account: string; because: "work-stopped-and-no-account-has-room" }>
  | Readonly<{ use: false; because: "provider-grants-no-resets" | "no-reset-on-this-account"
      | "another-account-has-room" | "already-decided-this-episode" }>;

export type ResetSituation = Readonly<{
  /** Only Codex grants these; Claude publishes no per-account list of resets to spend. */
  provider: string;
  /** The account whose allowance refused the work. */
  blockedAccount: string | null;
  /** Other accounts of the same provider that could take the work instead. */
  accountsWithRoom: readonly string[];
  /** Resets readable right now, per account. */
  candidates: readonly ResetCandidate[];
  /** This exact hold episode has already been decided once. */
  alreadyDecided: boolean;
}>;

export function decideAutomaticReset(situation: ResetSituation): ResetDecision {
  if (situation.provider !== "codex") return { use: false, because: "provider-grants-no-resets" };
  if (situation.alreadyDecided) return { use: false, because: "already-decided-this-episode" };
  // Work that can move to another account should move rather than spend a grant that cannot
  // be got back. This is the condition his "both accounts running low" describes failing.
  if (situation.accountsWithRoom.length) return { use: false, because: "another-account-has-room" };
  const candidate = situation.blockedAccount
    && situation.candidates.find(entry => entry.account === situation.blockedAccount && entry.available > 0);
  // Only the blocked account's own reset can unblock it, so there is no choice to make
  // between accounts. Where that account holds several, the reader hands them over with the
  // soonest expiry first, which also retires the one most likely to be wasted.
  if (!candidate) return { use: false, because: "no-reset-on-this-account" };
  return { use: true, account: candidate.account, because: "work-stopped-and-no-account-has-room" };
}

/**
 * And when a grant is spent *before* it lapses, which the rule above never reaches.
 *
 * The rule above fires only when work has actually stopped. That is the right trigger for an
 * outage and useless against an expiry date: six Codex grants expire on 2026-10-22, and under
 * ordinary load most would simply vanish. Tejas, 2026-09-23: "at the very least we should not
 * let them go to waste", and 2026-10-08: "take advantage of like which one gives us the most
 * tokens".
 *
 * **A grant cannot be aimed at a window.** Read out of the Codex app server's own protocol:
 * the grant carries its own `reset_type`, the consume call validates only that a credit id is
 * present, and the response reports `windows_reset` after the fact. Both accounts' grants are
 * titled "Full reset". So "which one gives us the most tokens" has no lever at spend time —
 * the grant decides what it clears.
 *
 * Which leaves timing, and timing is the whole optimisation. If a grant is a full reset, what
 * it is worth is exactly how much allowance is already consumed at the moment it is spent:
 * spending at 40% throws away more than half of it, spending at 95% recovers nearly all. So
 * the rule is to wait as long as is safe and spend at the deepest consumption, which is the
 * opposite of spending one as soon as it looks spare.
 */
export type LapseAccount = Readonly<{
  account: string;
  /**
   * The most-spent window on this account, as a percentage, which is what a full reset would
   * recover. Null when this machine could not read the account, which is never spent against.
   */
  tightestUsedPercent: number | null;
  /** This account's grants, soonest expiry first. */
  grants: readonly ResetCandidate[];
}>;

export type LapseSituation = Readonly<{
  provider: string;
  nowMs: number;
  accounts: readonly LapseAccount[];
  /** A deliberate spend has already been decided in this window of consideration. */
  alreadyDecided: boolean;
}>;

export type LapseDecision =
  | Readonly<{ use: true; account: string; expiresAt: string; usedPercent: number;
      because: "last-chance-before-it-lapses" | "deepest-consumption-while-at-risk" }>
  | Readonly<{ use: false; because: "provider-grants-no-resets" | "already-decided"
      | "no-grant-at-risk" | "too-early-to-spend-well" | "nothing-to-recover-yet" }>;

/** A grant this far from expiry is at risk; inside this, spending beats hoping. */
export const GRANT_AT_RISK_MS = 72 * 60 * 60_000;
/** Inside this there is no later chance, so depth stops being a reason to wait. */
export const GRANT_LAST_CHANCE_MS = 8 * 60 * 60_000;
/** Below this, waiting recovers more than spending now does. */
export const WORTH_SPENDING_PERCENT = 60;
/** Below this a full reset returns almost nothing, so even a lapsing grant is not worth a call. */
export const FLOOR_PERCENT = 10;

export function decideLapsePreventingReset(situation: LapseSituation): LapseDecision {
  if (situation.provider !== "codex") return { use: false, because: "provider-grants-no-resets" };
  if (situation.alreadyDecided) return { use: false, because: "already-decided" };

  const considered = situation.accounts.flatMap(account => {
    if (account.tightestUsedPercent === null) return [];
    const grant = [...account.grants]
      .filter(entry => entry.available > 0 && entry.expiresAt)
      .sort((left, right) => Date.parse(left.expiresAt!) - Date.parse(right.expiresAt!))[0];
    if (!grant?.expiresAt) return [];
    const untilLapse = Date.parse(grant.expiresAt) - situation.nowMs;
    if (!Number.isFinite(untilLapse)) return [];
    return [{ account: account.account, usedPercent: account.tightestUsedPercent, expiresAt: grant.expiresAt, untilLapse }];
  });

  const atRisk = considered.filter(entry => entry.untilLapse <= GRANT_AT_RISK_MS);
  if (!atRisk.length) return { use: false, because: "no-grant-at-risk" };

  // Spending recovers consumption, so a nearly-fresh window gives a full reset almost nothing
  // to do. Below the floor the call is not worth making even on the last day.
  const worthwhile = atRisk.filter(entry => entry.usedPercent >= FLOOR_PERCENT);
  if (!worthwhile.length) return { use: false, because: "nothing-to-recover-yet" };

  const lastChance = worthwhile.filter(entry => entry.untilLapse <= GRANT_LAST_CHANCE_MS);
  const deepEnough = worthwhile.filter(entry => entry.usedPercent >= WORTH_SPENDING_PERCENT);
  const eligible = lastChance.length ? lastChance : deepEnough;
  if (!eligible.length) return { use: false, because: "too-early-to-spend-well" };

  // Most value first: the deepest consumption is the most allowance a full reset gives back.
  const best = eligible.reduce((left, right) => right.usedPercent > left.usedPercent ? right : left);
  return {
    use: true, account: best.account, expiresAt: best.expiresAt, usedPercent: best.usedPercent,
    because: lastChance.length ? "last-chance-before-it-lapses" : "deepest-consumption-while-at-risk",
  };
}

/** What he is told afterwards, in his words rather than the protocol's. */
export function resetUsedSentence(input: {
  account: string; remaining: number; nextExpiresAt: string | null; releasedInputs: number;
}): string {
  const left = input.remaining === 0 ? "That was the last one on this account."
    : `${input.remaining} left on this account`
      + (input.nextExpiresAt ? `, the next expiring ${input.nextExpiresAt.slice(0, 10)}.` : ".");
  const work = input.releasedInputs > 0
    ? `${input.releasedInputs} piece${input.releasedInputs === 1 ? "" : "s"} of work that had stopped can carry on.`
    : "Work that had stopped can carry on.";
  return `Used a free reset on ${input.account}: it had run out and no other account had room. ${work} ${left}`;
}
