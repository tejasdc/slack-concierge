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
