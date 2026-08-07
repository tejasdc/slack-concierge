// Test isolation preload — runs BEFORE any test file imports state.ts.
// Every `bun test` invocation runs this via bunfig.toml's [test].preload.
//
// Why: state.ts defaults CONCIERGE_STATE_DIR to `${homedir()}/.local/state/concierge`,
// which on AX41 is the PRODUCTION database. Test files use
//     beforeEach(() => { db.query("DELETE FROM channels").run(); … })
// to isolate their state. Without this preload, running any test that
// imports state.ts wipes production. Happened 2026-08-07 — 63 rows lost.
//
// This file must NOT import anything from ../src/state — the whole point
// is to set env vars BEFORE that module first loads. Any import chain that
// pulls state.ts before this preload runs defeats the isolation.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "bun:test";

const scratchDir = mkdtempSync(join(tmpdir(), "concierge-test-"));
process.env.CONCIERGE_STATE_DIR = scratchDir;
process.env.CONCIERGE_TEST_MODE = "1";

afterAll(() => {
  try {
    rmSync(scratchDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup — leaves a tmp dir if OS blocks removal.
  }
});
