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
 * Measurement briefly made that stricter: a conversation could not change accounts at all,
 * because its transcript lived only inside the home it started in and a resume elsewhere did
 * not lose context, it failed to start. Sharing one history directory between the homes lifted
 * that, proven on the Mac on 2026-09-23 — session 74077648 started under one account and
 * resumed under the other, recalling the token planted in its first turn, with both
 * credentials untouched. So the choice is made fresh at every dispatch again, and the only
 * thing that cannot move is work banked to spend one account's expiring allowance.
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

/**
 * A turn that belongs to one particular account, and why. There are two ways a turn can be
 * bound, and they want identical treatment, so they share one concept rather than a branch
 * each: a conversation that has already run somewhere cannot move (its transcript lives in
 * that home), and a banked release exists to spend one named account's window before it
 * lapses. In both cases running anywhere else is not a lesser outcome, it is the opposite of
 * the point — so both must wait rather than fall through to whichever account is roomiest.
 *
 * Which window a banked release is saving is the releaser's business, not this rule's; it
 * only needs to know which account was named.
 */
export type AccountBinding = Readonly<{
  account: string;
  reason: "spending-this-window";
}>;

export type AccountChoice = Readonly<
  | {
      account: string;
      home: string | null;
      because: AccountBinding["reason"] | "stayed-on-its-account" | "moved-for-room" | "most-headroom";
    }
  | {
      account: null;
      home: null;
      because: "no-account-has-room" | "nothing-readable" | "bound-account-has-no-room";
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
  /** An account this turn must run on or wait for. Only a banked release binds. */
  bound: AccountBinding | null;
  /** The account this conversation last ran on. A preference, not a requirement. */
  prefer: string | null;
}): AccountChoice {
  const usable = input.accounts.filter(launchable);
  if (!usable.length) return { account: null, home: null, because: "nothing-readable" };

  // Only a banked release binds. It exists to spend one account's allowance before it lapses,
  // so landing on a different account spends the wrong subscription and lets the allowance
  // lapse anyway — not a degraded outcome but the opposite of the one it was released for. It
  // waits instead. This is the *first dispatch* of that turn, not the moment it was banked: a
  // banked item has no turns until release, so the window needing spent is known by then.
  if (input.bound) {
    const its = usable.find(account => account.account === input.bound!.account);
    if (!its) return { account: null, home: null, because: "nothing-readable" };
    return its.tightestUsedPercent! < 100
      ? { account: its.account, home: its.home, because: input.bound.reason }
      : { account: null, home: null, because: "bound-account-has-no-room" };
  }

  const withRoom = usable.filter(account => account.tightestUsedPercent! < 100);
  if (!withRoom.length) return { account: null, home: null, because: "no-account-has-room" };

  // A conversation prefers the account it last ran on and keeps it while that account has
  // room: staying is free, and a conversation that hops accounts for no reason makes his
  // usage harder to read. It is only a preference. When its account is spent it moves and
  // continues there with its context, which is the whole point of sharing one history —
  // proven on the Mac, 2026-09-23: session 74077648 was started under one account and
  // resumed under the other, which recalled the token planted in the first turn. Before that
  // was proven this branch returned a refusal, because a conversation genuinely could not
  // move; "never wait for a refill while another account has room" is now the behaviour
  // rather than the goal.
  const stayed = input.prefer && withRoom.find(account => account.account === input.prefer);
  if (stayed) return { account: stayed.account, home: stayed.home, because: "stayed-on-its-account" };

  const roomiest = withRoom.reduce((best, account) =>
    account.tightestUsedPercent! < best.tightestUsedPercent! ? account : best);
  return {
    account: roomiest.account,
    home: roomiest.home,
    because: input.prefer ? "moved-for-room" : "most-headroom",
  };
}

/** What he reads when a conversation starts somewhere. Once, not per turn. */
export function accountChosenSentence(input: { account: string; usedPercent: number; alternatives: number }): string {
  const room = `${Math.round(input.usedPercent)}% through its tightest window`;
  return input.alternatives > 0
    ? `Running on ${input.account}, which had the most room (${room}).`
    : `Running on ${input.account}, ${room}.`;
}

/**
 * And when a conversation moves. Once per move, never per turn — the move is the news, and
 * the part he actually needs is that nothing was lost, because the obvious fear on reading
 * that your conversation changed accounts is that it started over.
 */
export function accountMovedSentence(input: { from: string; to: string; usedPercent: number }): string {
  return `Continued on ${input.to} — ${input.from} had run out. Nothing was lost; this picks up where it left off.`;
}

/**
 * And what he reads when work stops anyway. Only banked work can be stuck now: a conversation
 * moves to whichever account has room, so if it is waiting, nothing has any.
 */
export function accountWaitingSentence(input: {
  account: string;
  othersWithRoom: readonly string[];
}): string {
  const head = `Waiting for ${input.account} to refill.`;
  if (!input.othersWithRoom.length) return head;
  const others = `${input.othersWithRoom.join(" and ")} still ${input.othersWithRoom.length > 1 ? "have" : "has"} room`;
  return `${head} ${others}, but this was held back to use ${input.account}'s allowance before it expires, and running it elsewhere would waste the thing it was saved for.`;
}
