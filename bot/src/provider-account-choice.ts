/**
 * Which account a turn runs on, chosen fresh at every dispatch.
 *
 * Tejas's rule, 2026-09-23: "never wait for a refill while another account has room" — and
 * the other half the same evening taught, which is that nothing may touch the credentials a
 * running process is using. The old design satisfied the first by violating the second: it
 * overwrote the one shared credential file, broke every live session, and turned seven turns
 * that were safely waiting into seven terminal failures. Switching was worse than doing
 * nothing.
 *
 * So nothing switches. Each account keeps its own configuration home, a turn is launched
 * against whichever home has room, and no credential is ever written. A conversation moves
 * between accounts only *between* turns, never during one.
 *
 * This is the rule on its own — no ledger, no provider, no clock, no file system — so it can
 * be read and exercised against real readings without launching anything. The wiring that
 * finds the homes and sets the environment lives with the launcher.
 */

export type AccountRoom = Readonly<{
  account: string;
  /**
   * The most-spent window on this account, as a percentage. 100 means it is out. Null when
   * this machine could not read the account at all, which is not the same as full.
   */
  tightestUsedPercent: number | null;
  /** A configuration home this machine holds for it, when it has one of its own. */
  home: string | null;
  /** True for the account the default login already uses, which needs no home. */
  isDefault: boolean;
  problem: string | null;
}>;

export type AccountChoice = Readonly<
  | { account: string; home: string | null; because: "stayed-on-this-session's-account" | "most-headroom" }
  | { account: null; home: null; because: "no-account-has-room" | "nothing-readable" }
>;

/**
 * An account is only a candidate if this machine can actually launch as it. An account with
 * no home of its own is selectable only when it is the default login, because reaching it
 * any other way would mean writing over the shared credential — the thing that broke.
 */
const launchable = (account: AccountRoom) =>
  !account.problem && account.tightestUsedPercent !== null && (account.home !== null || account.isDefault);

export function chooseAccountForTurn(input: {
  accounts: readonly AccountRoom[];
  /** The account this conversation's previous turn ran on, if any. */
  sessionAccount: string | null;
}): AccountChoice {
  const usable = input.accounts.filter(launchable);
  if (!usable.length) return { account: null, home: null, because: "nothing-readable" };

  const withRoom = usable.filter(account => account.tightestUsedPercent! < 100);
  if (!withRoom.length) return { account: null, home: null, because: "no-account-has-room" };

  // Stickiness first: a conversation stays where it was while that account can still carry
  // it. Moving a session between accounts costs the provider's own session continuity, and
  // whether a saved conversation resumes cleanly under another account is a question we
  // answer with evidence rather than assume, so it is not done for a marginal gain.
  const stayed = input.sessionAccount
    && withRoom.find(account => account.account === input.sessionAccount);
  if (stayed) return { account: stayed.account, home: stayed.home, because: "stayed-on-this-session's-account" };

  // Otherwise the account with the most room in its tightest window, so the next wall is as
  // far away as this machine can make it.
  const roomiest = withRoom.reduce((best, account) =>
    account.tightestUsedPercent! < best.tightestUsedPercent! ? account : best);
  return { account: roomiest.account, home: roomiest.home, because: "most-headroom" };
}

/** What he is told when a turn moves, in his words. Never per turn — once per move. */
export function accountMovedSentence(input: { from: string | null; to: string; usedPercent: number }): string {
  return input.from
    ? `Moved to ${input.to}: ${input.from} had run out, and this one is ${Math.round(input.usedPercent)}% through its tightest window.`
    : `Running on ${input.to}, ${Math.round(input.usedPercent)}% through its tightest window.`;
}
