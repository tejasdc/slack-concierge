// Guardrail: proves that tests never touch the production concierge DB.
//
// This test would have caught the 2026-08-07 incident (Codex's `bun test`
// wiped 63 channel rows from ~/.local/state/concierge/state.db) if it had
// existed. Now, if anyone reintroduces a path where a test resolves to
// production, this test fails loudly.
//
// Checks use CANONICAL paths (realpath), not string prefixes, so a
// symlink under /tmp pointing at production would still fail the
// invariant. Codex adversarial review 2026-08-07 flagged the earlier
// string-prefix version as bypassable — this version fixes that.

import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { relative } from "node:path";
import { db } from "../src/state";

describe("state isolation invariants", () => {
  test("CONCIERGE_TEST_MODE is set by the preload", () => {
    expect(process.env.CONCIERGE_TEST_MODE).toBe("1");
  });

  test("CONCIERGE_STATE_DIR is set and canonical-resolves OUTSIDE home", () => {
    const raw = process.env.CONCIERGE_STATE_DIR || "";
    expect(raw.length).toBeGreaterThan(0);

    // realpath so a symlink that appears to be under /tmp can't hide a
    // home-directory target.
    const canonical = realpathSync(raw);
    const canonicalHome = realpathSync(homedir());

    const rel = relative(canonicalHome, canonical);
    // If canonical is inside home, rel starts with "" or a normal path.
    // If canonical is outside home, rel starts with ".." (goes up).
    // Anything not starting with ".." is a violation.
    expect(rel.startsWith("..")).toBe(true);
  });

  test("db.filename canonicalizes outside home too", () => {
    const filename = (db as any).filename ?? "";
    expect(filename.endsWith("state.db")).toBe(true);
    const canonical = realpathSync(filename);
    const canonicalHome = realpathSync(homedir());
    const rel = relative(canonicalHome, canonical);
    expect(rel.startsWith("..")).toBe(true);
  });

  test("db.filename does not resolve to the known production path", () => {
    const filename = (db as any).filename ?? "";
    const canonical = realpathSync(filename);
    // The concierge production DB on AX41 lives here. If we ever open it
    // from a test process, this assertion catches it regardless of how
    // we got there (env var, symlink, mount, etc).
    const productionCanonical = "/root/.local/state/concierge/state.db";
    expect(canonical).not.toBe(productionCanonical);
  });
});
