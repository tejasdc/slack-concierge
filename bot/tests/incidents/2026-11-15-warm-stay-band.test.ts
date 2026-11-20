/**
 * Incident replay: 2026-11-15 — "warm account stays while its own pressure is at
 * least half the best one's."
 *
 * Verbatim comment from `bot/src/provider-account-choice.ts:95-98`:
 *   "How much more lapse pressure another account needs before a warm conversation
 *    leaves its account. Two: the warm account stays while its own pressure is at
 *    least half the best one's."
 *
 * Invariant the 2026-11-15 change encoded: an unconditional stay-on-warm let the
 * week ending Sunday be spent while the week ending Wednesday kept its room. The
 * fix made the warm stay gated on `pressure(warm) * WARM_STAY_BAND >= pressure(roomiest)`.
 */
import { describe, expect, test } from "bun:test";
import { WARM_STAY_BAND, chooseAccountForTurn, lapsePressure } from "../../src/provider-account-choice";

test("WARM_STAY_BAND is a positive integer >= 2 (preserves the Nov-15 ratio)", () => {
  expect(WARM_STAY_BAND).toBeGreaterThanOrEqual(2);
  expect(Number.isInteger(WARM_STAY_BAND)).toBe(true);
});

test("lapsePressure is higher for a room-rich account whose week ends sooner", () => {
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const now = Date.parse("2026-11-19T00:00:00Z");
  const ending_sunday  = { account: "hey@tejas.nyc", tightestUsedPercent: 20,
    weeklyUsedPercent: 20, weeklyResetsAtMs: now + 3 * 24 * 60 * 60 * 1000,
    home: "/x", isDefault: false, problem: null };
  const ending_wednesday = { account: "tejas@chann.app", tightestUsedPercent: 10,
    weeklyUsedPercent: 10, weeklyResetsAtMs: now + 7 * 24 * 60 * 60 * 1000,
    home: "/y", isDefault: false, problem: null };
  // Both accounts have room; the one ending sooner has higher pressure.
  expect(lapsePressure(ending_sunday, now)).toBeGreaterThan(lapsePressure(ending_wednesday, now));
  void WEEK_MS;
});

test("chooseAccountForTurn with warm ratio keeps the warm account when within band", () => {
  const now = Date.parse("2026-11-19T00:00:00Z");
  // Warm account has 20% used, 40% room; roomiest has 10% used, 45% room.
  // warm pressure * 2 (band) >= roomiest pressure → stay on warm.
  const warm = { account: "hey@tejas.nyc", tightestUsedPercent: 20,
    weeklyUsedPercent: 20, weeklyResetsAtMs: now + 7 * 24 * 60 * 60 * 1000,
    home: "/x", isDefault: false, problem: null };
  const roomiest = { account: "tejas@chann.app", tightestUsedPercent: 10,
    weeklyUsedPercent: 10, weeklyResetsAtMs: now + 7 * 24 * 60 * 60 * 1000,
    home: "/y", isDefault: false, problem: null };
  const choice = chooseAccountForTurn({
    accounts: [warm, roomiest], bound: null, prefer: "hey@tejas.nyc",
    warmCacheAccount: "hey@tejas.nyc", nowMs: now,
  });
  expect(choice.account).toBe("hey@tejas.nyc");
});
