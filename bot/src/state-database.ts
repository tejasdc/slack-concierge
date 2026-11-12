import { Database } from "bun:sqlite";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { observedDatabase } from './storage-observation';
import { ledgerWriteResults } from './ledger-write-results';
import { ledgerAccess } from './ledger-access-policy';
import {CODEX_AUDIT_OFF_CODEX_TEST_AUTHORIZATION,PARKED_CODEX_FOLLOW_TEST_AUTHORIZATION,START_PACE_TEST_AUTHORIZATION,INBOX_HELD_DUPLICATE_TEST_AUTHORIZATION,HELD_RELEASE_PACING_TEST_AUTHORIZATION,HELD_WORK_MOVABILITY_TEST_AUTHORIZATION,INBOX_UNFILED_ACROSS_ROUTERS_TEST_AUTHORIZATION,INBOX_BOOKKEEPING_RECOVERY_TEST_AUTHORIZATION,LEGACY_TOPIC_COMPLETION_TEST_AUTHORIZATION} from './test-authorizations';

// Opening the ledger is separate from initializing application schema so the
// deployment migrator can reserve SQLite's writer before either schema owner runs.
const testInvocation = process.env.CONCIERGE_TEST_MODE === "1"
  || process.env.NODE_ENV === "test"
  || [...process.argv, Bun.main].some((argument) => argument === "test" || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(argument));
// The responsiveness implementation has its own explicit test authorization (Tejas's
// f6e938aa investigation and b1eed622 implementation request); production-path checks stay below.
// Tejas's phone-work repair (input e943db22) requires an isolated admission and cancellation check.
const authorizedTest = ["native-attribution-5eaa0768", "responsive-system-b1eed622", "foreground-isolation-5804d389", "quiet-bank-e943db22", "drain-withdraw-unclaimed-2026-11-05",
  "agent-attachment-attribution-ebced96a", LEGACY_TOPIC_COMPLETION_TEST_AUTHORIZATION,
  INBOX_BOOKKEEPING_RECOVERY_TEST_AUTHORIZATION, HELD_WORK_MOVABILITY_TEST_AUTHORIZATION, HELD_RELEASE_PACING_TEST_AUTHORIZATION, START_PACE_TEST_AUTHORIZATION, INBOX_HELD_DUPLICATE_TEST_AUTHORIZATION, INBOX_UNFILED_ACROSS_ROUTERS_TEST_AUTHORIZATION,
  PARKED_CODEX_FOLLOW_TEST_AUTHORIZATION, CODEX_AUDIT_OFF_CODEX_TEST_AUTHORIZATION].includes(process.env.CONCIERGE_TEST_AUTHORIZATION ?? "");
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
// The ledger can live on its own filesystem behind a link (docs/architecture/LEDGER-DURABILITY.md).
// A link whose file is missing means that filesystem is not the one that holds the ledger: opening
// it would create an empty ledger and fork history, so Concierge refuses to start instead.
const ledgerEntry = lstatSync(`${canonicalDir}/state.db`, { throwIfNoEntry: false });
if (ledgerEntry?.isSymbolicLink() && !existsSync(`${canonicalDir}/state.db`)) {
  throw new Error(`The ledger link ${canonicalDir}/state.db points at a missing file; its filesystem is not mounted. Refusing to create an empty ledger.`);
}
const access = ledgerAccess(canonicalDir, Bun.main, readWorker);
if (access.forbidControllerLedgerOpen) {
  throw new Error('Serving release commands cannot open the live ledger; use the owner socket.');
}
export const initializeLedgerSchema = access.schema;
export const ownerServedReleaseCommand = access.ownerServedReleaseCommand;
export const ownerServedDeploymentCommand = access.ownerServedDeploymentCommand;
// The lock wait is set by the opener before its first statement (journal_mode and even the
// first prepare need SQLite's locks). During an update restart the retiring coordinator can
// still hold the writer for a moment; after a crash the dying owner's helpers held it for
// more than five seconds (2026-11-11). The service's pre-start recovery runs while nothing
// is serving, so it waits longer rather than failing the start and costing a restart cycle.
const ledgerLockWaitMs = basename(Bun.main).replace(/\.[cm]?[jt]s$/, '') === 'recover-deployment' ? 30_000 : 5_000;
export const db = observedDatabase(ledgerWriteResults(new Database(`${canonicalDir}/state.db`, access.readonly ? { readonly: true } : { readwrite: true, create: !access.live || access.schema }), ledgerLockWaitMs));
if (access.readonly) db.exec("PRAGMA query_only = ON");
// On Linux the owner's checkpoint thread is the ledger's only checkpointer. With SQLite's default,
// the first commit by any short-lived writer (the update runner's state commands, release
// promotion) copied the whole log into the database and synced it, holding the owner's commits
// for seconds while builds loaded the disk (2026-10-12). See docs/architecture/LEDGER-DURABILITY.md.
if (process.platform === "linux") db.exec("PRAGMA wal_autocheckpoint = 0");
if (initializeLedgerSchema) db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
// Sorts and temporary tables stay in memory. On disk each one was a file created in /var/tmp and
// deleted again, about three a second on the owner's event loop, and every create and delete waited
// on the filesystem journal under agent disk load (2026-10-10). See docs/architecture/LEDGER-DURABILITY.md.
db.exec("PRAGMA temp_store = MEMORY");
// A serving start only needs the full foreign-key scan when its schema initialization
// actually changes the schema. The release controller separately verifies backups.
export const schemaVersionAtOpen = (db.query('PRAGMA schema_version').get() as { schema_version: number }).schema_version;
