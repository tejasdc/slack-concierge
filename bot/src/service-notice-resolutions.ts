import type { Database } from "bun:sqlite";

/**
 * A host script (a server timer, a systemd hook) records a notice into the ledger from its own
 * process and cannot run the owner's thread logic. It also records "this is fixed now" here; the
 * running owner's service-notice pass (`startServiceNoticeUpkeep`) settles it in the notice's
 * thread: posts the resolution, closes the thread and takes the question off Needs attention.
 * A key resolved before its notice was ever recorded stays pending and harmless.
 */
const initialized = new WeakSet<Database>();
function ensureTable(db: Database): void {
  if (initialized.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS service_notice_resolutions (
    key TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    requested_at_ms INTEGER NOT NULL,
    settled_at_ms INTEGER
  )`);
  initialized.add(db);
}

/** Records one resolution request; false when this key already has one. */
export function recordServiceNoticeResolution(db: Database, input: { key: string; text: string }): boolean {
  ensureTable(db);
  return db.query("INSERT OR IGNORE INTO service_notice_resolutions(key,text,requested_at_ms) VALUES(?,?,?)")
    .run(input.key, input.text, Date.now()).changes === 1;
}

export function pendingServiceNoticeResolutions(db: Database): { key: string; text: string }[] {
  ensureTable(db);
  return db.query("SELECT key,text FROM service_notice_resolutions WHERE settled_at_ms IS NULL ORDER BY requested_at_ms,key")
    .all() as { key: string; text: string }[];
}

export function markServiceNoticeResolutionSettled(db: Database, key: string): void {
  db.query("UPDATE service_notice_resolutions SET settled_at_ms=? WHERE key=? AND settled_at_ms IS NULL").run(Date.now(), key);
}
