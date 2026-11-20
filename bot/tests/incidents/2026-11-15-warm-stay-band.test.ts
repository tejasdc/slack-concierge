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
import { WARM_STAY_BAND, chooseAccountForTurn, lapsePressure, shouldStayWarm } from "../../src/provider-account-choice";

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
  // Warm account has 20% used, 80% room; roomiest has 10% used, 90% room.
  // Both end a week out — symmetric pressure. Crossing probability for warm
  // is small (plenty of room, 1 hour), roomiestOccupancy = 10/100 = 0.1.
  // crossing=0.0X ≤ 0.1 → shouldStayWarm = true.
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

test("Item 1: derivation returns different answer than fixed 2× for asymmetric pressures", () => {
  const now = Date.parse("2026-11-19T00:00:00Z");
  // Warm account has 1% room ending in 1 hour: lapsePressure = 1 room/hour.
  // Crossing probability = 1*1/1 = 1 — it will cross in the next reading window.
  // Roomiest has 50% room ending in a week: roomiestOccupancy = 50/100 = 0.5.
  // Derivation says: 1 > 0.5 → move (shouldStayWarm = false).
  // Fixed-2× would say: warm.pressure (1.0) * 2 >= roomiest.pressure (0.3) → STAY.
  // The derivation diverges from the hand-tuned ratio on this matrix.
  const warm = { account: "warm", tightestUsedPercent: 99,
    weeklyUsedPercent: 99, weeklyResetsAtMs: now + 1 * 60 * 60 * 1000,
    home: "/w", isDefault: false, problem: null };
  const roomiest = { account: "room", tightestUsedPercent: 50,
    weeklyUsedPercent: 50, weeklyResetsAtMs: now + 7 * 24 * 60 * 60 * 1000,
    home: "/r", isDefault: false, problem: null };
  // Hand-tuned: warm.pressure * 2 >= roomiest.pressure?
  //   warm.pressure = 1; roomiest.pressure = 50/168 ≈ 0.3. 2 ≥ 0.3 → fixed-2× STAYS.
  // Derivation: shouldStayWarm = false (will cross).
  expect(shouldStayWarm(warm, roomiest, now)).toBe(false);
});
