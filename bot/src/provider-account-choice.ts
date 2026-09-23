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
 * So nothing switches. Each account keeps its own configuration home, a conversation is
 * launched against the home that has room, and no credential is ever written.
 *
 * Measurement then made that stricter than intended. A conversation cannot change accounts at
 * all, in either direction: its transcript is stored inside its configuration home, so a
 * resume under another account does not merely lose context, it fails to start. The account
 * is therefore chosen once, at creation, and every later turn either runs there or waits.
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
  | { account: string; home: string | null; because: "this-session's-account" | "most-headroom" }
  | {
      account: null;
      home: null;
      because: "no-account-has-room" | "nothing-readable" | "this-session's-account-has-no-room";
    }
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

  // A conversation cannot change accounts at all. Its transcript is written inside the
  // configuration home it was started in, so resuming it anywhere else does not degrade —
  // it fails outright: measured on the Mac, 2026-09-23, `--resume` under the second home
  // answered `No conversation found with session ID: 802095ed-…` and exited 1. So the
  // account is decided once, when the conversation is created, and after that this function
  // only reports whether that one account can carry the next turn. Choosing another would
  // turn work that is safely waiting into work that cannot run — the exact trade the whole
  // design exists to avoid.
  if (input.sessionAccount) {
    const its = usable.find(account => account.account === input.sessionAccount);
    if (!its) return { account: null, home: null, because: "nothing-readable" };
    return its.tightestUsedPercent! < 100
      ? { account: its.account, home: its.home, because: "this-session's-account" }
      : { account: null, home: null, because: "this-session's-account-has-no-room" };
  }

  const withRoom = usable.filter(account => account.tightestUsedPercent! < 100);
  if (!withRoom.length) return { account: null, home: null, because: "no-account-has-room" };

  // A new conversation goes to the account with the most room in its tightest window, so the
  // next wall is as far away as this machine can make it — and, because this is the only
  // moment the choice can be made, as far away as it will ever be for this conversation.
  const roomiest = withRoom.reduce((best, account) =>
    account.tightestUsedPercent! < best.tightestUsedPercent! ? account : best);
  return { account: roomiest.account, home: roomiest.home, because: "most-headroom" };
}

/**
 * What he reads about a conversation's account. Once, when it is created — there is no
 * later move to announce, and a line per turn would be noise.
 */
export function accountChosenSentence(input: { account: string; usedPercent: number; alternatives: number }): string {
  const room = `${Math.round(input.usedPercent)}% through its tightest window`;
  return input.alternatives > 0
    ? `This conversation runs on ${input.account}, which had the most room (${room}). It stays on that account for good.`
    : `This conversation runs on ${input.account}, ${room}.`;
}

/**
 * And what he reads when it stops: naming the account matters here, because the reason it is
 * waiting rather than moving is that this conversation belongs to that one account.
 */
export function accountWaitingSentence(input: { account: string; othersWithRoom: readonly string[] }): string {
  const head = `Waiting for ${input.account} to refill.`;
  return input.othersWithRoom.length
    ? `${head} ${input.othersWithRoom.join(" and ")} still ${input.othersWithRoom.length > 1 ? "have" : "has"} room, but a conversation cannot change accounts — its history lives with the one it started on. New work goes there.`
    : head;
}
