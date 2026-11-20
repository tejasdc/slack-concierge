/**
 * Incident replay: 2026-11-06 — Codex refusal held every turn while account read 7%.
 *
 * Verbatim comment from `bot/src/provider-usage.ts:181-187` (original Codex-only rule):
 *   "A Codex refusal is retired by a later reading of the same account that shows every
 *    window with room and no window still ending at the refused reset time: the window
 *    that refused has been replaced (a reset spent elsewhere, or on another machine
 *    sharing the login). Without this, only a reset Concierge spent itself cleared the
 *    mark, and on 2026-11-06 a Nov 3 refusal of tejas@chann.app (cached until Nov 9 19:36
 *    UTC) held every Codex turn while the account read 7% used with its week ending Nov 12."
 *
 * In the rebuild this is the GENERIC rule in `account-refusal-cache.ts`:
 * `retireRefusalSupersededByReading` is provider-agnostic and applies to Claude too
 * (closing fault F2 from 2026-11-19).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  cachedRefusal, clearAll, openWrite, recordRefusal, retireRefusalSupersededByReading,
} from "../../src/account-refusal-cache";

const ACCOUNT = "tejas@chann.app";

beforeEach(() => clearAll("codex"));
afterEach(() => clearAll("codex"));

test("a Nov 3 refusal held every turn is retired when a reading at 7% shows a week ending later", () => {
  // Shift the dates so they're in the future relative to the test run.
  const refusedReset = Date.now() + 5 * 24 * 60 * 60 * 1000;      // "Nov 9 19:36 UTC" shifted
  const freshReset = Date.now() + 8 * 24 * 60 * 60 * 1000;         // "Nov 12 UTC" shifted
  const token = openWrite("codex", ACCOUNT, null);
  recordRefusal(token, refusedReset);
  const windows = [{ usedPercent: 7, resetsAt: new Date(freshReset).toISOString() }];
  const retired = retireRefusalSupersededByReading("codex", ACCOUNT, null, windows, Date.now() + 1_000);
  expect(retired).toBe(true);
  expect(cachedRefusal("codex", ACCOUNT, null)).toBeNull();
});

test("the cache stays when a window still ends within 60s of the refused reset", () => {
  const refusedReset = Date.now() + 5 * 24 * 60 * 60 * 1000;
  const token = openWrite("codex", ACCOUNT, null);
  recordRefusal(token, refusedReset);
  const windows = [{ usedPercent: 7, resetsAt: new Date(refusedReset - 30_000).toISOString() }];
  const retired = retireRefusalSupersededByReading("codex", ACCOUNT, null, windows, Date.now() + 1_000);
  expect(retired).toBe(false);
  expect(cachedRefusal("codex", ACCOUNT, null)).not.toBeNull();
});
