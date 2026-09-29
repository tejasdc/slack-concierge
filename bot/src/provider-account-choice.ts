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

/** Why a turn landed where it did. The only thing that knows what to say about it. */
export type AccountReason =
  | AccountBinding["reason"]
  | "stayed-on-its-account"
  | "moved-for-room"
  | "most-headroom";

export type AccountChoice = Readonly<
  | {
      account: string;
      home: string | null;
      because: AccountReason;
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

/**
 * What he reads about an account, and when he reads nothing at all.
 *
 * One function, because the sentence is a statement of fact about why this turn landed where it
 * did, and the only thing that knows that is the choice's own recorded reason. Two functions
 * chosen by the caller's own re-reading of the inputs is how both sentences came to assert
 * things that had not happened: a conversation that moved because Tejas picked another account
 * in Provider accounts was told the old one "had run out", and a conversation that landed on an
 * account by preference was told it had "the most room" (GPT-6 Sol, 2026-09-29).
 *
 * Null is the ordinary answer. He is told only about a departure from where his work runs:
 * anything else — a conversation starting where everything starts, or staying put — is not news,
 * and on 2026-09-29 he found 27 such announcements pinned across his conversations, every one of
 * them naming the account he had selected himself. "We did not change the accounts."
 */
export function accountNoticeSentence(input: {
  because: AccountReason;
  /** Where this turn is running. */
  to: string;
  /** The account this conversation last ran on, when it has run before. */
  from: string | null;
  /** Where new work runs on this machine: his Provider accounts selection, else the default login. */
  usual: string | null;
}): string | null {
  const continued = (why: string) => `Continued on ${input.to} — ${why}. Nothing was lost; this picks up where it left off.`;
  // A conversation that had run somewhere else is the only case where "continued" is true.
  const moved = input.from !== null && input.from !== input.to;
  if (input.because === "moved-for-room") return moved ? continued(`${input.from} was out of room`) : null;
  if (input.because === "stayed-on-its-account") {
    // It "stayed" on the account it was asked to prefer, which is not always the one it last ran
    // on: a newer Provider accounts selection becomes that preference. Then the conversation did
    // move, and the reason is his own choice, not an allowance.
    return moved ? continued("you selected it in Provider accounts") : null;
  }
  // Nothing was preferred and nothing had run here before, so this landed on the roomiest
  // account. That is worth a word only when it is not where his work normally runs.
  if (input.because === "most-headroom") {
    return input.usual && input.to !== input.usual
      ? `Started on ${input.to} — ${input.usual} had no room.`
      : null;
  }
  return null;
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
