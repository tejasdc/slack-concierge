import type { Database } from "bun:sqlite";

/**
 * Health notices go to the repair agent first, never straight to Tejas (2026-10-08 [decision:
 * repair-agent-before-tejas]): "I should not be interfacing or like looking at any of these
 * notifications … These are things that you should work on. The repair agent should look into."
 * A crash, a freeze, stuck work or a dependency that stopped retrying is recorded here and handed
 * to one standing repair session, which investigates, fixes what it can, and reaches him only by
 * declaring needs_you, which the owner already limits to what only he can do.
 *
 * The record lives in the ledger because the writers include processes outside Concierge (a
 * systemd failure hook, the outside monitor) that run while Concierge is down; the running owner
 * delivers whatever is pending when it can.
 */
export const REPAIR_FIRST_KINDS: ReadonlySet<string> = new Set([
  "service_failure", "owner_unresponsive", "stuck_work", "retry_stopped",
]);

export const REPAIR_AGENT_TITLE = "Repair agent";
export const REPAIR_AGENT_PROJECT = "slack-concierge";
export const REPAIR_AGENT_PROVIDER = "cc-opus";

function ensureTable(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS repair_notices (
    key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    delivered_input_id TEXT
  )`);
}

/** Records one health notice for the repair agent; false when this key was already recorded. */
export function recordRepairNotice(db: Database, input: { key: string; kind: string; text: string }): boolean {
  ensureTable(db);
  return db.query("INSERT OR IGNORE INTO repair_notices(key,kind,text,created_at_ms) VALUES(?,?,?,?)")
    .run(input.key, input.kind, input.text, Date.now()).changes === 1;
}

export type PendingRepairNotice = { key: string; kind: string; text: string; created_at_ms: number };

export function pendingRepairNotices(db: Database): PendingRepairNotice[] {
  ensureTable(db);
  return db.query("SELECT key,kind,text,created_at_ms FROM repair_notices WHERE delivered_input_id IS NULL ORDER BY created_at_ms,key")
    .all() as PendingRepairNotice[];
}

export function markRepairNoticesDelivered(db: Database, keys: string[], inputId: string): void {
  const mark = db.query("UPDATE repair_notices SET delivered_input_id=? WHERE key=? AND delivered_input_id IS NULL");
  db.transaction(() => { for (const key of keys) mark.run(inputId, key); })();
}

/** What the repair agent reads: the notices themselves and where its standing instructions are. */
export function repairNoticeText(notices: PendingRepairNotice[], when: (ms: number) => string): string {
  const items = notices.map((notice, index) => `${index + 1}. [${notice.kind}, ${when(notice.created_at_ms)}] ${notice.text}`);
  return `Health notices for the repair agent (Tejas has not seen these):\n\n${items.join("\n\n")}\n\n`
    + "Follow docs/runbooks/REPAIR-AGENT.md in slack-concierge: find the cause from recorded evidence, fix what an agent can, "
    + "and reach Tejas only with sessions outcome needs_you for what only he can do. No reply is owed to this notice.";
}

/**
 * Delivers pending notices now and then once a minute. Writers outside Concierge (a failure hook,
 * the outside monitor) record while it is down; the first pass after it starts hands them over.
 */
export function startRepairNoticeDelivery(deliver: () => number, log: (level: "info" | "error", event: string, fields: Record<string, unknown>) => void): () => void {
  const pass = () => {
    try {
      const delivered = deliver();
      if (delivered) log("info", "repair_notices_delivered", { count: delivered });
    } catch (error) {
      log("error", "repair_notice_delivery_failed", { error: String(error) });
    }
  };
  pass();
  const timer = setInterval(pass, 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
