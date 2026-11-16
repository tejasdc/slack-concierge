// Test isolation preload — runs BEFORE any test file imports state.ts.
// Every `bun test` invocation runs this via bunfig.toml's [test].preload.
//
// Why: state.ts defaults CONCIERGE_STATE_DIR to `${homedir()}/.local/state/concierge`,
// which on AX41 is the PRODUCTION database. Test files use
//     beforeEach(() => { db.query("DELETE FROM channels").run(); … })
// to isolate their state. Without this preload, running any test that
// imports state.ts wipes production. Happened 2026-08-07 — 63 rows lost.
//
// This file must NOT import anything from ../src/state or ../src/capture-state
// — the whole point is to set env vars BEFORE either module first loads.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "bun:test";

const scratchDir = mkdtempSync(join(tmpdir(), "concierge-test-"));
process.env.CONCIERGE_STATE_DIR = scratchDir;
process.env.CONCIERGE_CAPTURE_STATE_DIR = join(scratchDir, "capture");
process.env.CONCIERGE_TEST_MODE = "1";

// No test reaches Tejas's live thnkr.ing (thesaurus, to-dos, captures). Every Concierge call to
// it resolves its place from these variables (thinkering-capability-target.ts, the `thinkering`
// helper), so pointing the socket at a path nothing listens on and dropping the network entrance
// makes a forgotten stand-in fail closed instead of reading his live entries. Tests that need
// thnkr.ing answers pass their own stand-in socket explicitly. 2026-11-06 failure record:
// docs/incidents/2026-11-06-focused-tests-read-live-thesaurus.md.
process.env.THINKERING_SESSION_CAPABILITY_SOCKET = join(scratchDir, "no-thinkering.sock");
for (const key of ["CONCIERGE_THINKERING_CAPABILITY_URL", "CONCIERGE_THINKERING_TOKEN_FILE", "THINKERING_CAPABILITY_URL"])
  delete process.env[key];

afterAll(() => {
  try {
    rmSync(scratchDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup — leaves a tmp dir if OS blocks removal.
  }
});
