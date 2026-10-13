/**
 * What an allowance reset actually does, and when using one is worth it.
 *
 * Tejas found the failure mode on 2026-10-13 (Mac capture, 12:52 PM ET): "I just reset one of
 * the accounts because we were running out, and the reset keeps the same timing. I thought the
 * reset would reset the timing, but apparently it doesn't. For that account, the weekly reset
 * was Wednesday 4 AM … now I need to use all of it today, by Wednesday 4 AM. So we have maybe
 * 15 hours to use a whole week's worth of usage." He asked for the facts to be written down
 * "not just for agents but for me to understand too", and for the best moment to reset to be
 * said on the provider record where he decides.
 *
 * The facts, from the providers' own words and this ledger's readings:
 *
 * - **Claude.** A limit reset ("Reset for free" in claude.ai Settings > Usage on the web or
 *   desktop app; not offered inside Claude Code) restores the five-hour or the weekly limit it
 *   was offered for back to full. "Your weekly limits still reset on their usual day and
 *   time." It cannot be undone, can be used before a limit is hit, and expires at the date on
 *   the offer (support.claude.com articles 17007452 and 11049741). This ledger's readings of
 *   tejastej.dc@gmail.com on 2026-10-13: at 16:50 UTC the weekly fell from 100% to 0% and the
 *   Fable-only weekly from 44% to 0%, and both kept their Oct 14 08:00 UTC end. Anthropic
 *   publishes no per-account list of these offers, so Concierge cannot see one; he can.
 * - **Codex.** A banked reset (OpenAI grants them occasionally; they lapse thirty days later)
 *   restores the account's limits at once; which windows it clears is recorded the first time
 *   one is spent (`windows_reset`). For a purchased weekly reset OpenAI says the weekly clock
 *   restarts with the first request afterwards, and the next weekly reset comes seven days
 *   later (help.openai.com article 20001507), which is the opposite of Claude's fixed end.
 *
 * So the value of a reset is the allowance it recovers multiplied by the time left to use it.
 * It is worth the most just after the week is spent and far from the weekly end, and worth the
 * least just before that end, when the same allowance is about to arrive for free. A five-hour
 * wall is never a reason by itself: that window refills within hours and the held work already
 * carries that instant. And a reset on an account that is not what blocks work recovers nothing
 * that was needed, because work moves to the account with room.
 *
 * Pure: no ledger, no clock, no provider, so it can be read and exercised on real readings.
 */

import type { UsageWindow } from "./provider-account-usage";

export type ResetWorth =
  /** The week is spent, the end is far, and nothing else would take the work: use one. */
  | "now"
  /** Something would be recovered, but less than a reset is worth; wait until it is spent. */
  | "later"
  /** The weekly end is so close that the same allowance arrives on its own first. */
  | "wait"
  /** Plenty of room with a near end: spend this account first, nothing to reset. */
  | "spend-first"
  /** Nothing to recover. */
  | "none";

export type ResetAdvice = Readonly<{ worth: ResetWorth; line: string }>;

/** Under this many hours to the weekly end, a weekly reset recovers a week that refills anyway. */
export const WEEKLY_END_TOO_CLOSE_HOURS = 24;
/** At or above this, the week counts as spent for the purpose of a reset. */
export const WEEKLY_SPENT_PERCENT = 95;
/** Below this with the end inside two days, the account is simply the one to spend first. */
export const WEEKLY_FRESH_PERCENT = 20;

const HOUR = 3_600_000;

export function spanWords(ms: number): string {
  const hours = Math.max(0, Math.round(ms / HOUR));
  if (hours < 1) return "under an hour";
  if (hours < 48) return `${hours} h`;
  const days = Math.floor(hours / 24), rest = hours % 24;
  return rest ? `${days} d ${rest} h` : `${days} d`;
}

/** The provider's weekly window, by the names the usage reader gives them. */
export function weeklyWindow(windows: readonly UsageWindow[]): UsageWindow | null {
  return windows.find(window => window.name === "Weekly") ?? null;
}

export function fiveHourWindow(windows: readonly UsageWindow[]): UsageWindow | null {
  return windows.find(window => window.name === "5-hour") ?? null;
}

/**
 * One sentence for the account row and for agents, in his time zone (`when` formats an instant).
 *
 * `othersWithRoom` is whether another account of the same provider can take the work now; a reset
 * is only worth spending on the account that actually blocks work.
 */
export function resetAdvice(input: {
  provider: "claude-code" | "codex" | "antigravity";
  windows: readonly UsageWindow[];
  nowMs: number;
  othersWithRoom: boolean;
  when: (ms: number) => string;
}): ResetAdvice | null {
  if (input.provider === "antigravity") return null;
  const weekly = weeklyWindow(input.windows);
  if (!weekly) return null;
  const endMs = weekly.resetsAt ? Date.parse(weekly.resetsAt) : NaN;
  if (!Number.isFinite(endMs)) return null;
  const left = endMs - input.nowMs;
  if (left <= 0) return null;
  const span = spanWords(left);
  const end = input.when(endMs);
  const used = Math.round(weekly.usedPercent);
  const fixedEnd = input.provider === "claude-code";
  // Codex: the end moves with the first request after a reset, so "until when" is a week from
  // then; what the reset recovers is still the spent part of this week.
  const recovers = `${used}% of the week`;
  const fiveHour = fiveHourWindow(input.windows);
  const fiveHourWall = !!fiveHour && fiveHour.usedPercent >= 100;

  if (used >= WEEKLY_SPENT_PERCENT) {
    if (fixedEnd && left < WEEKLY_END_TOO_CLOSE_HOURS * HOUR)
      return { worth: "wait", line: `A reset now would give a full week for only the ${span} until ${end}, when it refills anyway: wait.` };
    if (input.othersWithRoom)
      return { worth: "later", line: fixedEnd
        ? `A reset now gives a full week for ${span}, until ${end}; another account still has room, so it is worth it once this one is what blocks work.`
        : `A reset now gives a full week, and the weekly clock restarts with the first request after it; another account still has room, so it is worth it once this one is what blocks work.` };
    return { worth: "now", line: fixedEnd
      ? `A reset now gives a full week for ${span}, until ${end}: worth it.`
      : `A reset now gives a full week, and the weekly clock restarts with the first request after it: worth it.` };
  }
  if (used < WEEKLY_FRESH_PERCENT && fixedEnd && left < 2 * WEEKLY_END_TOO_CLOSE_HOURS * HOUR)
    return { worth: "spend-first", line: `${100 - used}% of the week is left and it ends ${end} (${span}): spend this account first; nothing to reset.` };
  if (fiveHourWall && fixedEnd)
    return { worth: "later", line: `A reset now would recover ${recovers}, still ending ${end}; the five-hour wall clears on its own at ${fiveHour!.resetsAt ? input.when(Date.parse(fiveHour!.resetsAt)) : "its refill"}: wait until the week is spent.` };
  if (used === 0) return { worth: "none", line: `Nothing to reset: the week is untouched and ends ${end}.` };
  return { worth: "later", line: fixedEnd
    ? `A reset now would recover ${recovers}, still ending ${end}: wait until the week is spent.`
    : `A reset now would recover ${recovers}: wait until the week is spent.` };
}

/** The standing facts, for the provider record and for agents' own reading. */
export const RESET_FACTS: Readonly<Record<"claude-code" | "codex", string>> = {
  "claude-code":
    "A Claude limit reset (Reset for free, in claude.ai Settings > Usage on the web or desktop; not inside Claude Code) "
    + "restores the five-hour or the weekly limit it was offered for back to full and keeps the usual weekly end: "
    + "a week reset 15 hours before its end is a week to use in 15 hours. It cannot be undone, works before a limit is hit, "
    + "and expires on the offer's date. Best just after the week is spent and far from its end; never for a five-hour wall "
    + "alone, which refills on its own; never while another account has room, because work moves there.",
  codex:
    "A Codex banked reset restores the account's limits at once (which windows, Concierge records the first time one is spent); "
    + "OpenAI says the weekly clock then restarts with the first request after it. Grants lapse thirty days after they are given. "
    + "Concierge spends one only when work has actually stopped, the week is spent and no other account has room.",
};
