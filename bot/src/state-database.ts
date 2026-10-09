import { Database } from "bun:sqlite";
import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { observedDatabase } from './storage-observation';
import { ledgerWriteResults } from './ledger-write-results';

// Opening the ledger is separate from initializing application schema so the
// deployment migrator can reserve SQLite's writer before either schema owner runs.
const testInvocation = process.env.CONCIERGE_TEST_MODE === "1"
  || process.env.NODE_ENV === "test"
  || [...process.argv, Bun.main].some((argument) => argument === "test" || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(argument));
// The responsiveness implementation has its own explicit test authorization (Tejas's
// f6e938aa investigation and b1eed622 implementation request); production-path checks stay below.
const authorizedTest = ["native-attribution-5eaa0768", "responsive-system-b1eed622", "foreground-isolation-5804d389"].includes(process.env.CONCIERGE_TEST_AUTHORIZATION ?? "");
if (testInvocation && !authorizedTest) {
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

if (process.env.CONCIERGE_READ_WORKER !== "1") mkdirSync(configuredDir, { recursive: true });
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

const readWorker = process.env.CONCIERGE_READ_WORKER === "1";
export const db = observedDatabase(ledgerWriteResults(new Database(`${canonicalDir}/state.db`, readWorker ? { readonly: true } : { create: true })));
if (readWorker) db.exec("PRAGMA query_only = ON");
// Set the wait before journal_mode: that pragma itself needs SQLite's writer lock. During an
// update restart, the retiring coordinator can still hold that lock for a moment; configuring
// the timeout afterwards made the recovery preflight fail immediately instead of waiting.
db.exec("PRAGMA busy_timeout = 5000");
if (!readWorker) db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
