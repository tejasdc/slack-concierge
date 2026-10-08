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

/**
 * A grant is only ever spent against a spent **weekly** allowance.
 *
 * Tejas, 2026-10-08, cancelling the pre-expiry spend built earlier that day: "Obviously
 * we're gonna reset only after we completely consume the entire fucking thing. We're not
 * resetting before hundred percent dude … we only use actual resets for the whole weekly
 * consumption … please do not build any sort of spending reset on whatever before it
 * expires at all."
 *
 * So a five-hour wall never spends one. It does not need to: a five-hour window refills on
 * its own within hours, and held work already carries that instant and resumes when it
 * arrives. Spending a finite grant to skip a few hours would trade something irreplaceable
 * for something that was coming anyway.
 *
 * The one exception is his: "if the five hour limit has been exceeded and we have almost
 * exhausted the weekly reset, then it makes sense for us to do the reset". A full reset
 * clears both windows, so at that point almost the whole week comes back with it and nearly
 * nothing is wasted. **"Almost" is 95%** — deliberately conservative, because the cost of
 * being wrong is a grant that cannot be got back: at 95% a reset forfeits at most a
 * twentieth of the week, while at 90% it would throw away a tenth, which is most of a day's
 * allowance.
 */
export const WEEKLY_ALMOST_EXHAUSTED_PERCENT = 95;

/**
 * The windows of the account whose allowance refused the work, as the reading gives them.
 *
 * Null means this machine could not identify that window in the reading — the five-hour one
 * is often absent entirely — and an unidentifiable window never argues for spending. The
 * refusal direction is the safe one: when the weekly state cannot be established, no grant
 * is spent.
 */
export type BlockedWindows = Readonly<{ weeklyUsedPercent: number | null; fiveHourUsedPercent: number | null }>;

export type ResetDecision =
  | Readonly<{ use: true; account: string;
      because: "weekly-allowance-spent-and-no-account-has-room" | "five-hour-wall-with-the-week-almost-gone" }>
  | Readonly<{ use: false; because: "provider-grants-no-resets" | "no-reset-on-this-account"
      | "another-account-has-room" | "already-decided-this-episode"
      | "weekly-allowance-not-spent" | "weekly-allowance-not-readable" }>;

export type ResetSituation = Readonly<{
  /** Only Codex grants these; Claude publishes no per-account list of resets to spend. */
  provider: string;
  /** The account whose allowance refused the work. */
  blockedAccount: string | null;
  /** Other accounts of the same provider that could take the work instead. */
  accountsWithRoom: readonly string[];
  /** Resets readable right now, per account. */
  candidates: readonly ResetCandidate[];
  /** The blocked account's own windows; a grant is spent only against a spent weekly one. */
  windows: BlockedWindows;
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
  // The weekly allowance decides. A five-hour wall refills on its own within hours and the
  // held work already carries that instant, so spending a grant there would trade something
  // that cannot be replaced for something that was arriving anyway.
  const weekly = situation.windows.weeklyUsedPercent, fiveHour = situation.windows.fiveHourUsedPercent;
  if (weekly === null) return { use: false, because: "weekly-allowance-not-readable" };
  const weeklyGone = weekly >= 100;
  const hisException = fiveHour !== null && fiveHour >= 100 && weekly >= WEEKLY_ALMOST_EXHAUSTED_PERCENT;
  if (!weeklyGone && !hisException) return { use: false, because: "weekly-allowance-not-spent" };
  return { use: true, account: candidate.account,
    because: weeklyGone ? "weekly-allowance-spent-and-no-account-has-room" : "five-hour-wall-with-the-week-almost-gone" };
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
