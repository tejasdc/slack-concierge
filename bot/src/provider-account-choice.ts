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
 * Claude dispatch launches against the home that has room, without rewriting a live
 * credential. Codex dispatch uses the account already signed in to the shared App Server;
 * Accounts switching is a separate operation that waits for running Codex turns.
 *
 * Measurement briefly made that stricter: a conversation could not change accounts at all,
 * because its transcript lived only inside the home it started in and a resume elsewhere did
 * not lose context, it failed to start. Sharing one history directory between the homes lifted
 * that, proven on the Mac on 2026-09-23 — session 74077648 started under one account and
 * resumed under the other, recalling the token planted in its first turn, with both
 * credentials untouched. So Claude's choice is made fresh at every dispatch again, while
 * Codex banked work is limited to the shared server's current account.
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
  /** The primary weekly allowance, when known. This ranks eligible Claude accounts without
   * spending a nearly exhausted week merely because another account's short window is fuller. */
  weeklyUsedPercent?: number | null;
  /**
   * When that weekly allowance ends, if known. Room that ends sooner is spent first: an
   * allowance is lost at its end, so the one with the least time to be used is the one at
   * risk. A week reset 15 hours before its end (Tejas, 2026-10-13) is the extreme case.
   */
  weeklyResetsAtMs?: number | null;
  /** A configuration home this machine holds for it, when it has one of its own. */
  home: string | null;
  /** True for the account the default login already uses, which needs no home. */
  isDefault: boolean;
  problem: string | null;
}>;

/**
 * A banked release belongs to one particular account's window. Running elsewhere would
 * spend the wrong allowance, so it waits rather than falling through to another account.
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
  | "stayed-for-warm-cache"
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

const WEEK_HOURS = 7 * 24;

/**
 * Historical hand-tuned ratio: the warm account stayed while its own pressure was at least
 * half the best one's. Kept as a reference value — `warm-stay-band.test.ts` reads it — but
 * the actual stay/move decision is now derived per-turn by `shouldStayWarm` below.
 *
 * Item 1 (2026-11-20): the derivation computes the warm account's crossing probability in
 * the next reading window vs. the roomiest's room fraction. The invariant: never stay warm
 * when moving is strictly safer on both axes.
 */
export const WARM_STAY_BAND = 2;

/** The reading-window horizon we project against: how far ahead the dispatcher looks when
 *  deciding whether a warm stay would cross its allowance before the next reading lands. */
export const WARM_STAY_READING_WINDOW_HOURS = 1;

/**
 * Percent of weekly room per hour left to use it: the rate at which this account's room has to
 * be spent before it lapses. Higher means more at risk of being wasted, so it is spent first.
 */
export function lapsePressure(account: AccountRoom, nowMs: number): number {
  const used = account.weeklyUsedPercent ?? account.tightestUsedPercent ?? 100;
  const room = Math.max(0, 100 - used);
  const end = account.weeklyResetsAtMs ?? null;
  const hoursLeft = end !== null && end > nowMs ? Math.max(1, (end - nowMs) / 3_600_000) : WEEK_HOURS;
  return room / hoursLeft;
}

/**
 * Item 1 (2026-11-20): derived warm-stay decision. The warm account's crossing probability in
 * the next reading window is `pressure * windowHours / room` (approximately: the fraction of
 * remaining room that would be burned at current pressure over the window). We move if that
 * probability exceeds `1 - roomiestRoom/100`, i.e., the roomiest's non-room fraction. When
 * the two accounts' pressures are symmetric, the derivation collapses to the WARM_STAY_BAND
 * heuristic at the median; it diverges for asymmetric pressure matrices.
 */
export function shouldStayWarm(warm: AccountRoom, roomiest: AccountRoom, nowMs: number): boolean {
  const warmPressure = lapsePressure(warm, nowMs);
  const warmUsed = warm.weeklyUsedPercent ?? warm.tightestUsedPercent ?? 100;
  const warmRoom = Math.max(0, 100 - warmUsed);
  const roomiestUsed = roomiest.weeklyUsedPercent ?? roomiest.tightestUsedPercent ?? 100;
  const roomiestRoom = Math.max(0, 100 - roomiestUsed);
  if (warmRoom === 0) return false;  // warm has no room; must move
  const crossing = Math.min(1, (warmPressure * WARM_STAY_READING_WINDOW_HOURS) / warmRoom);
  const roomiestOccupancy = 1 - (roomiestRoom / 100);
  return crossing <= roomiestOccupancy;
}

export function chooseAccountForTurn(input: {
  accounts: readonly AccountRoom[];
  /** An account this turn must run on or wait for. Only a banked release binds. */
  bound: AccountBinding | null;
  /** The account this conversation last ran on, used to break equal-room ties. */
  prefer: string | null;
  /** A fresh Accounts selection wins once, before ordinary room-based dispatch resumes. */
  newlySelected?: boolean;
  /** A recent provider call on this conversation left a reusable prefix on this account. */
  warmCacheAccount?: string | null;
  /** The instant the choice is made; the rule takes it so it can be run on past readings. */
  nowMs?: number;
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

  // A fresh manual choice applies to the next turn. A reusable conversation prefix then
  // stays on its account while that account has room: another subscription cannot read it.
  // Once the prefix is cold, rank eligible accounts by allowance lapse pressure. That avoids
  // spending the last 13% of one week while another has 83% (Inbox, 2026-10-10).
  const preferred = input.prefer && withRoom.find(account => account.account === input.prefer);
  if (input.newlySelected && preferred)
    return { account: preferred.account, home: preferred.home, because: "stayed-on-its-account" };

  // Work is ranked by how fast room has to be spent before it lapses: the percent left divided by
  // the hours until that weekly allowance ends. A full week with 15 hours to its end outranks a
  // half week with five days (6.7 against 0.4 points an hour), and the 2026-10-10 case still
  // holds — 13% with two days left (0.3) loses to 83% with five (0.7). An unknown end counts as
  // a whole week away, the least urgent reading, so it never jumps the queue on a missing date.
  const pressure = (account: AccountRoom) => lapsePressure(account, input.nowMs ?? Date.now());
  const roomiest = withRoom.reduce((best, account) =>
    pressure(account) > pressure(best)
      || (pressure(account) === pressure(best) && account.account === input.prefer)
      ? account : best);

  // A warm prefix keeps its account only while that account is not clearly the wrong week to
  // spend. From 2026-10-23 the warm stay came before the ranking, so a conversation active every
  // hour never left its account: on 2026-11-13 the ledger recorded 159 warm stays against 48
  // moves for room, and the week ending Sunday was spent while a week ending Wednesday kept its
  // room (Tejas, 2026-11-15: "we should not be changing only when they're expiring, but actually
  // based on what weekly windows are happening"). The band is hysteresis, not a cost model: a
  // move pays one rewrite of the prefix and then the new account is warm, so staying is only
  // worth it while the accounts are close; beyond twice the pressure the room that would lapse
  // outweighs that rewrite, and two accounts cannot ping-pong unless their pressures swing fourfold.
  const warm = input.warmCacheAccount && withRoom.find(account => account.account === input.warmCacheAccount);
  // Item 1 (2026-11-20): the warm-stay decision is derived per-turn via `shouldStayWarm` so
  // it adapts to asymmetric pressure matrices. The pre-2026-11-20 fixed `WARM_STAY_BAND`
  // heuristic is preserved as a reference; see that export's doc comment.
  if (warm && shouldStayWarm(warm, roomiest, input.nowMs ?? Date.now()))
    return { account: warm.account, home: warm.home, because: "stayed-for-warm-cache" };
  if (roomiest.account === input.prefer)
    return { account: roomiest.account, home: roomiest.home, because: "stayed-on-its-account" };
  return {
    account: roomiest.account,
    home: roomiest.home,
    because: input.prefer ? "moved-for-room" : "most-headroom",
  };
}

/**
 * Nothing is said to him about which account a turn runs on. Not when a conversation starts, not
 * when it moves, not when an account runs out and it continues elsewhere.
 *
 * Two rounds got this wrong by degrees. The first announced the account a conversation started on
 * — which was the account he had selected himself, 27 of them pinned across his conversations
 * ("We did not change the accounts"). The second still spoke when his own new selection moved a
 * conversation ("I'm the one who fucking selected that. Haven't I? So why are you notifying me
 * that? Am I a fucking idiot?"). Then he removed the category:
 *
 * > "And why is anything, any other notifications even here too? What the fuck does it matter for
 * > me if you ran on one account or not? What matters for me is actually you continue to make sure
 * > everything is working and like we never face an issue of an user is running out. That's what
 * > fucking matters. I don't fucking care what the fuck you're running in."
 * > (Tejas, 2026-09-29.)
 *
 * He is right that this was never news: choosing the account with room is the whole job of the
 * rule above, and a rule doing its job is not an event. The choice is still recorded on the turn
 * for diagnosis — which account, and why — and that record has no words in it for him.
 */

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
