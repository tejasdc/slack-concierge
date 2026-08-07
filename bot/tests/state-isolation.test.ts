// Guardrail: proves that tests never touch the production concierge DB.
//
// This test would have caught the 2026-08-07 incident (Codex's `bun test`
// wiped 63 channel rows from ~/.local/state/concierge/state.db) if it had
// existed. Now, if anyone reintroduces a path where a test resolves to the
// production DB, this test fails loudly.

import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { db } from "../src/state";

describe("state isolation", () => {
  test("CONCIERGE_TEST_MODE is set by the preload", () => {
    expect(process.env.CONCIERGE_TEST_MODE).toBe("1");
  });

  test("CONCIERGE_STATE_DIR points at a scratch dir under /tmp, never at production", () => {
    const dir = process.env.CONCIERGE_STATE_DIR || "";
    const home = homedir();

    // Must be set at all.
    expect(dir.length).toBeGreaterThan(0);

    // Must NOT resolve inside the user's home dir where production state lives.
    expect(dir.startsWith(home)).toBe(false);

    // Must be under /tmp (or the OS tmpdir prefix on darwin: /var/folders/…).
    // Both are acceptable — the invariant is "not a persistent user path".
    const isTmp = dir.startsWith("/tmp/") || dir.startsWith("/var/folders/") || dir.startsWith("/private/tmp/") || dir.startsWith("/private/var/");
    expect(isTmp).toBe(true);
  });

  test("the loaded db is anchored at the scratch dir, not production", () => {
    const filename = (db as any).filename ?? "";
    const home = homedir();
    expect(filename.startsWith(home)).toBe(false);
    expect(filename.endsWith("state.db")).toBe(true);
  });
});
