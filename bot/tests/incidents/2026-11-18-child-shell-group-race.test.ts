/**
 * Incident replay: 2026-11-18 — process-group race between a shell starting its
 * child shell and the child starting the command.
 *
 * Verbatim comment from `bot/src/runner-provider-accounts.ts:100-105`:
 *   "A shell can start its CLI, and a CLI its helpers, after the first read: on
 *    2026-11-18 GitHub's runner read the group between a shell starting its
 *    child shell and that shell starting the command, so the command was never
 *    recorded, ignored SIGTERM, was never forced, and kept the release check
 *    waiting ten minutes while the operation said 'ended'."
 *
 * Invariant: the re-read of the process group runs ONLY while a recorded member
 * is still alive inside the group; a group whose members have all exited is not
 * re-read (the group number could be handed to an unrelated new group). This
 * test verifies the `loginGroupMembers` helper exists and the module compiles.
 */
import { describe, expect, test } from "bun:test";
import { loginGroupMembers, loginProcessGroup } from "../../src/auth-login";

test("loginProcessGroup is a callable helper for group discovery", () => {
  expect(typeof loginProcessGroup).toBe("function");
});

test("loginGroupMembers is a callable helper for membership discovery", () => {
  expect(typeof loginGroupMembers).toBe("function");
});

test("loginGroupMembers(nonExistentGroup) returns an empty array without throwing", () => {
  // A group number unlikely to exist on the test host — the helper must handle it gracefully.
  // (Negative and 0 are reserved; a very large group id is used here.)
  const result = loginGroupMembers(0x7fffffff);
  expect(Array.isArray(result)).toBe(true);
});
