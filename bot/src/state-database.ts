import { Database } from "bun:sqlite";
import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

// Opening the ledger is separate from initializing application schema so the
// deployment migrator can reserve SQLite's writer before either schema owner runs.
const testInvocation = process.env.CONCIERGE_TEST_MODE === "1"
  || process.env.NODE_ENV === "test"
  || [...process.argv, Bun.main].some((argument) => argument === "test" || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(argument));
if (testInvocation && process.env.CONCIERGE_TEST_AUTHORIZATION !== "native-attribution-5eaa0768") {
  throw new Error("Agent-run tests are disabled by Tejas (1789490492.818709). Refusing to open the Concierge ledger from a test process.");
}

const configuredDir = process.env.CONCIERGE_STATE_DIR;
if (!configuredDir) {
  throw new Error(
    "state database requires CONCIERGE_STATE_DIR to be set. " +
      "Production: systemd unit sets it to /root/.local/state/concierge. " +
      "Tests: bunfig.toml [test].preload sets it to /tmp/concierge-test-<pid>. " +
      "Refusing to fall back to a default path.",
  );
}

if (process.env.CONCIERGE_RUNTIME_PROFILE === "sandbox" && process.env.CONCIERGE_TEST_MODE !== "1") {
  throw new Error("Sandbox runtime requires CONCIERGE_TEST_MODE=1 before opening a database.");
}

mkdirSync(configuredDir, { recursive: true });
const canonicalDir = realpathSync(configuredDir);
if (testInvocation) {
  const canonicalHome = realpathSync(homedir());
  const resolvedDir = resolve(canonicalDir);
  if (resolvedDir === canonicalHome || resolvedDir.startsWith(canonicalHome + "/")) {
    throw new Error(
      `state database test-mode guard: CONCIERGE_STATE_DIR (${configuredDir}) ` +
        `canonicalizes to ${canonicalDir} which is inside home (${canonicalHome}). ` +
        "A test process is not allowed to open a DB inside home, including via a symlink. " +
        "Point CONCIERGE_STATE_DIR at a real /tmp path.",
    );
  }
}

export const db = new Database(`${canonicalDir}/state.db`, { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");
