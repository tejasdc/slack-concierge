import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { isProcessIdentityAlive, processIdentity, type ProcessIdentity } from "./runtime-identity";
import { captureAttachmentSnapshot, type CaptureAttachment } from "./capture-attachments";

const configuredCaptureStateDir = process.env.CONCIERGE_CAPTURE_STATE_DIR;
if (!configuredCaptureStateDir) {
  throw new Error("capture-state.ts requires CONCIERGE_CAPTURE_STATE_DIR to be set.");
}
mkdirSync(configuredCaptureStateDir, { recursive: true });
const canonicalCaptureStateDir = realpathSync(configuredCaptureStateDir);
if (process.env.CONCIERGE_TEST_MODE === "1") {
  const canonicalHome = realpathSync(homedir());
  const statePath = resolve(canonicalCaptureStateDir);
  if (statePath === canonicalHome || statePath.startsWith(`${canonicalHome}/`)) {
    throw new Error(`Capture tests cannot use a state directory inside home: ${canonicalCaptureStateDir}`);
  }
}

export const captureDb = new Database(`${canonicalCaptureStateDir}/state.db`, { create: true, strict: true });
captureDb.exec("PRAGMA journal_mode = WAL");
captureDb.exec("PRAGMA busy_timeout = 5000");

captureDb.exec(`
CREATE TABLE IF NOT EXISTS capture_events (
  event_id             TEXT PRIMARY KEY,
  route_id             TEXT NOT NULL,
  destination_channel  TEXT NOT NULL,
  message_text         TEXT NOT NULL,
  recorded_at_ms       INTEGER NOT NULL,
  source_client        TEXT NOT NULL,
  client_msg_id        TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending'
                         CHECK(status IN ('pending', 'sending', 'delivered', 'parked')),
  delivery_attempts    INTEGER NOT NULL DEFAULT 0,
  delivery_error       TEXT,
  next_attempt_ms      INTEGER,
  slack_message_ts     TEXT,
  delivery_claim_id          TEXT,
  delivery_owner_pid         INTEGER,
  delivery_owner_boot_id     TEXT,
  delivery_owner_start_ticks TEXT,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivered_at         DATETIME,
  parked_at            DATETIME
);

CREATE INDEX IF NOT EXISTS capture_events_delivery_queue
ON capture_events(status, next_attempt_ms, created_at);

CREATE TABLE IF NOT EXISTS capture_delivery_gate (
  singleton           INTEGER PRIMARY KEY CHECK (singleton=1),
  token               TEXT NOT NULL,
  owner_pid           INTEGER NOT NULL,
  owner_boot_id       TEXT NOT NULL,
  owner_start_ticks   TEXT NOT NULL,
  mode                TEXT NOT NULL DEFAULT 'live'
                        CHECK(mode IN ('live', 'held')),
  claimed_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

function addColumnIfMissing(table: string, column: string, declaration: string) {
  const columns = captureDb.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((candidate) => candidate.name === column)) {
    captureDb.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
  }
}

addColumnIfMissing("capture_events", "delivery_owner_pid", "INTEGER");
addColumnIfMissing("capture_events", "delivery_owner_boot_id", "TEXT");
addColumnIfMissing("capture_events", "delivery_owner_start_ticks", "TEXT");
addColumnIfMissing("capture_events", "delivery_claim_id", "TEXT");
addColumnIfMissing("capture_events", "source_trigger", "TEXT");
addColumnIfMissing("capture_events", "source_webhook_version", "TEXT");
addColumnIfMissing("capture_events", "delivery_kind", "TEXT NOT NULL DEFAULT 'slack' CHECK(delivery_kind IN ('slack', 'journal', 'session'))");
addColumnIfMissing("capture_events", "journal_sink", "TEXT");
addColumnIfMissing("capture_events", "journal_file_path", "TEXT");
addColumnIfMissing("capture_events", "attachment_snapshot_json", "TEXT");
addColumnIfMissing("capture_events", "source_snapshot_json", "TEXT");
addColumnIfMissing("capture_events", "session_id", "TEXT");
addColumnIfMissing("capture_events", "session_input_id", "TEXT");
const captureTable = captureDb.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='capture_events'").get() as { sql: string };
if (captureTable.sql.includes("CHECK(delivery_kind IN ('slack', 'journal'))")) {
  // SQLite cannot extend a column CHECK in place; preserve every retained column and index.
  captureDb.transaction(() => {
    const indexes = captureDb.query("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='capture_events' AND sql IS NOT NULL").all() as Array<{ sql: string }>;
    captureDb.exec(captureTable.sql.replace(/CREATE TABLE\s+capture_events/i, "CREATE TABLE capture_events_native")
      .replace("CHECK(delivery_kind IN ('slack', 'journal'))", "CHECK(delivery_kind IN ('slack', 'journal', 'session'))"));
    captureDb.exec("INSERT INTO capture_events_native SELECT * FROM capture_events");
    captureDb.exec("DROP TABLE capture_events");
    captureDb.exec("ALTER TABLE capture_events_native RENAME TO capture_events");
    for (const index of indexes) captureDb.exec(index.sql);
  }).immediate();
}
addColumnIfMissing("capture_delivery_gate", "mode", "TEXT NOT NULL DEFAULT 'live' CHECK(mode IN ('live', 'held'))");
captureDb.exec("CREATE UNIQUE INDEX IF NOT EXISTS capture_events_delivery_claim ON capture_events(delivery_claim_id) WHERE delivery_claim_id IS NOT NULL");
captureDb.exec(`
DROP TRIGGER IF EXISTS capture_events_validate_insert;
DROP TRIGGER IF EXISTS capture_events_validate_update;
CREATE TRIGGER capture_events_validate_insert
BEFORE INSERT ON capture_events
WHEN NOT (
  (NEW.delivery_kind='session' OR (NEW.source_trigger IS NULL AND NEW.source_webhook_version IS NULL)
    OR (COALESCE(LENGTH(NEW.source_trigger), 0) > 0
      AND COALESCE(LENGTH(NEW.source_webhook_version), 0) > 0))
  AND (
    (NEW.delivery_kind='slack'
      AND LENGTH(NEW.destination_channel) > 0
      AND NEW.journal_sink IS NULL
      AND NEW.journal_file_path IS NULL
      AND ((NEW.status='delivered' AND COALESCE(LENGTH(NEW.slack_message_ts), 0) > 0)
        OR (NEW.status<>'delivered' AND NEW.slack_message_ts IS NULL)))
    OR
    (NEW.delivery_kind='journal'
      AND NEW.destination_channel=''
      AND COALESCE(LENGTH(NEW.journal_sink), 0) > 0
      AND NEW.slack_message_ts IS NULL
      AND ((NEW.status='delivered'
          AND NEW.journal_file_path=('pebble-' || NEW.event_id || '.md'))
        OR (NEW.status<>'delivered' AND NEW.journal_file_path IS NULL)))
    OR
    (NEW.delivery_kind='session'
      AND NEW.destination_channel='' AND NEW.journal_sink IS NULL
      AND NEW.journal_file_path IS NULL AND NEW.slack_message_ts IS NULL
      AND NEW.source_snapshot_json IS NOT NULL
      AND ((NEW.status='delivered' AND COALESCE(LENGTH(NEW.session_id), 0)>0
          AND COALESCE(LENGTH(NEW.session_input_id), 0)>0)
        OR (NEW.status<>'delivered' AND NEW.session_id IS NULL AND NEW.session_input_id IS NULL)))
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid capture event field combination');
END;

CREATE TRIGGER capture_events_validate_update
BEFORE UPDATE ON capture_events
WHEN NOT (
  (NEW.delivery_kind='session' OR (NEW.source_trigger IS NULL AND NEW.source_webhook_version IS NULL)
    OR (COALESCE(LENGTH(NEW.source_trigger), 0) > 0
      AND COALESCE(LENGTH(NEW.source_webhook_version), 0) > 0))
  AND (
    (NEW.delivery_kind='slack'
      AND LENGTH(NEW.destination_channel) > 0
      AND NEW.journal_sink IS NULL
      AND NEW.journal_file_path IS NULL
      AND ((NEW.status='delivered' AND COALESCE(LENGTH(NEW.slack_message_ts), 0) > 0)
        OR (NEW.status<>'delivered' AND NEW.slack_message_ts IS NULL)))
    OR
    (NEW.delivery_kind='journal'
      AND NEW.destination_channel=''
      AND COALESCE(LENGTH(NEW.journal_sink), 0) > 0
      AND NEW.slack_message_ts IS NULL
      AND ((NEW.status='delivered'
          AND NEW.journal_file_path=('pebble-' || NEW.event_id || '.md'))
        OR (NEW.status<>'delivered' AND NEW.journal_file_path IS NULL)))
    OR
    (NEW.delivery_kind='session'
      AND NEW.destination_channel='' AND NEW.journal_sink IS NULL
      AND NEW.journal_file_path IS NULL AND NEW.slack_message_ts IS NULL
      AND NEW.source_snapshot_json IS NOT NULL
      AND ((NEW.status='delivered' AND COALESCE(LENGTH(NEW.session_id), 0)>0
          AND COALESCE(LENGTH(NEW.session_input_id), 0)>0)
        OR (NEW.status<>'delivered' AND NEW.session_id IS NULL AND NEW.session_input_id IS NULL)))
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid capture event field combination');
END;
`);

export type CaptureEventStatus = "pending" | "sending" | "delivered" | "parked";
export type CaptureDeliveryKind = "slack" | "journal" | "session";

export interface CaptureSource {
  kind: "pebble" | "thinkering" | "monologue";
  id: string;
  recordedAt: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface CaptureEventRow {
  event_id: string;
  route_id: string;
  destination_channel: string;
  message_text: string;
  attachment_snapshot_json?: string | null;
  source_snapshot_json?: string | null;
  session_id: string | null;
  session_input_id: string | null;
  recorded_at_ms: number;
  source_client: string;
  source_trigger: string | null;
  source_webhook_version: string | null;
  client_msg_id: string;
  delivery_kind: CaptureDeliveryKind;
  journal_sink: string | null;
  journal_file_path: string | null;
  status: CaptureEventStatus;
  delivery_attempts: number;
  delivery_error: string | null;
  next_attempt_ms: number | null;
  slack_message_ts: string | null;
  delivery_claim_id: string | null;
  delivery_owner_pid: number | null;
  delivery_owner_boot_id: string | null;
  delivery_owner_start_ticks: string | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
  parked_at: string | null;
}

export function createCaptureEvent(input: {
  eventId: string;
  routeId: string;
  destinationChannel: string;
  messageText: string;
  attachments?: CaptureAttachment[];
  source?: CaptureSource;
  recordedAtMs: number;
  sourceClient: string;
  sourceTrigger?: string | null;
  sourceWebhookVersion?: string | null;
  clientMessageId: string;
  deliveryKind?: CaptureDeliveryKind;
  journalSink?: string | null;
}): { created: boolean; event: CaptureEventRow } {
  const deliveryKind = input.deliveryKind || "slack";
  const sourceTrigger = input.sourceTrigger ?? null;
  const sourceWebhookVersion = input.sourceWebhookVersion ?? null;
  const journalSink = input.journalSink ?? null;
  const hasCompleteSourceHeaders = deliveryKind === "session" || (sourceTrigger === null && sourceWebhookVersion === null)
    || (Boolean(sourceTrigger) && Boolean(sourceWebhookVersion));
  const hasValidDestination = deliveryKind === "slack"
    ? Boolean(input.destinationChannel) && journalSink === null
    : deliveryKind === "journal"
      ? input.destinationChannel === "" && Boolean(journalSink)
      : input.destinationChannel === "" && journalSink === null && Boolean(input.source);
  if (!hasCompleteSourceHeaders || !hasValidDestination) {
    throw new Error("Invalid capture event field combination.");
  }
  const result = captureDb.query(`
    INSERT OR IGNORE INTO capture_events (
      event_id, route_id, destination_channel, message_text,
      recorded_at_ms, source_client, source_trigger, source_webhook_version,
      client_msg_id, delivery_kind, journal_sink, attachment_snapshot_json, source_snapshot_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.eventId,
    input.routeId,
    input.destinationChannel,
    input.messageText,
    input.recordedAtMs,
    input.sourceClient,
    sourceTrigger,
    sourceWebhookVersion,
    input.clientMessageId,
    deliveryKind,
    journalSink,
    captureAttachmentSnapshot(input.attachments),
    input.source ? JSON.stringify(input.source) : null,
  );
  return {
    created: result.changes === 1,
    event: getCaptureEvent(input.eventId)!,
  };
}

export function getCaptureEvent(eventId: string): CaptureEventRow | null {
  return (captureDb.query("SELECT * FROM capture_events WHERE event_id=?").get(eventId) as CaptureEventRow | null) || null;
}

export function listRecoverableCaptureEvents(): CaptureEventRow[] {
  return captureDb.query(`
    SELECT * FROM capture_events
    WHERE status='pending'
    ORDER BY COALESCE(next_attempt_ms, 0), created_at, event_id
  `).all() as CaptureEventRow[];
}

export function captureDeliveryIsDraining(): boolean {
  const gate = captureDb.query("SELECT * FROM capture_delivery_gate WHERE singleton=1").get() as any;
  if (!gate) return false;
  if (gate.mode !== "held" && !isProcessIdentityAlive({ pid: gate.owner_pid, bootId: gate.owner_boot_id, startTicks: gate.owner_start_ticks })) {
    captureDb.query("DELETE FROM capture_delivery_gate WHERE singleton=1 AND token=?").run(gate.token);
    return false;
  }
  return true;
}

export function recoverInterruptedCaptureDeliveries(): number {
  const interrupted = captureDb.query(`
    SELECT * FROM capture_events
    WHERE status='sending'
      AND delivery_owner_pid IS NOT NULL
      AND delivery_owner_boot_id IS NOT NULL
      AND delivery_owner_start_ticks IS NOT NULL
  `).all() as CaptureEventRow[];
  let recovered = 0;
  for (const event of interrupted) {
    const owner = {
      pid: event.delivery_owner_pid!,
      bootId: event.delivery_owner_boot_id!,
      startTicks: event.delivery_owner_start_ticks!,
    };
    if (isProcessIdentityAlive(owner)) continue;
    recovered += captureDb.query(`
      UPDATE capture_events
      SET status=CASE WHEN route_id='thinkering' AND delivery_kind='slack' THEN 'parked' ELSE 'pending' END,
          parked_at=CASE WHEN route_id='thinkering' AND delivery_kind='slack' THEN CURRENT_TIMESTAMP ELSE parked_at END,
          next_attempt_ms=NULL,
          delivery_error=CASE WHEN route_id='thinkering' AND delivery_kind='slack' THEN 'Thinkering delivery owner died; Slack outcome requires inspection'
            ELSE COALESCE(delivery_error, 'delivery interrupted by service restart') END,
          delivery_claim_id=NULL,
          delivery_owner_pid=NULL, delivery_owner_boot_id=NULL,
          delivery_owner_start_ticks=NULL, updated_at=CURRENT_TIMESTAMP
      WHERE event_id=? AND status='sending'
        AND delivery_owner_pid=? AND delivery_owner_boot_id=?
        AND delivery_owner_start_ticks=?
    `).run(event.event_id, owner.pid, owner.bootId, owner.startTicks).changes;
  }
  return recovered;
}

export function claimCaptureEvent(
  eventId: string,
  nowMs = Date.now(),
  owner: ProcessIdentity = processIdentity(process.pid),
  claimId = randomUUID(),
): CaptureEventRow | null {
  const claim = captureDb.transaction(() => {
    const existing = captureDb.query(`
      SELECT * FROM capture_events
      WHERE delivery_claim_id=? AND status='sending'
        AND delivery_owner_pid=? AND delivery_owner_boot_id=?
        AND delivery_owner_start_ticks=?
    `).get(claimId, owner.pid, owner.bootId, owner.startTicks) as CaptureEventRow | null;
    if (existing) return existing;
    const claimed = captureDb.query(`
      UPDATE capture_events
      SET status='sending', delivery_attempts=delivery_attempts+1,
          delivery_error=NULL, next_attempt_ms=NULL,
          delivery_claim_id=?, delivery_owner_pid=?, delivery_owner_boot_id=?,
          delivery_owner_start_ticks=?, updated_at=CURRENT_TIMESTAMP
      WHERE event_id=? AND status='pending'
        AND (next_attempt_ms IS NULL OR next_attempt_ms<=?)
        AND NOT EXISTS (SELECT 1 FROM capture_delivery_gate WHERE singleton=1)
    `).run(claimId, owner.pid, owner.bootId, owner.startTicks, eventId, nowMs);
    return claimed.changes === 1 ? getCaptureEvent(eventId) : null;
  });
  return claim.immediate();
}

export function claimNextCaptureEvent(
  claimId: string,
  owner: ProcessIdentity,
  nowMs = Date.now(),
): CaptureEventRow | null {
  const claim = captureDb.transaction(() => {
    const existing = captureDb.query(`
      SELECT * FROM capture_events
      WHERE delivery_claim_id=? AND status='sending'
        AND delivery_owner_pid=? AND delivery_owner_boot_id=?
        AND delivery_owner_start_ticks=?
    `).get(claimId, owner.pid, owner.bootId, owner.startTicks) as CaptureEventRow | null;
    if (existing) return existing;
    const candidate = captureDb.query(`
      SELECT event_id FROM capture_events
      WHERE status='pending' AND (next_attempt_ms IS NULL OR next_attempt_ms<=?)
        AND NOT EXISTS (SELECT 1 FROM capture_delivery_gate WHERE singleton=1)
      ORDER BY COALESCE(next_attempt_ms, 0), created_at, event_id
      LIMIT 1
    `).get(nowMs) as { event_id: string } | null;
    if (!candidate) return null;
    const claimed = captureDb.query(`
      UPDATE capture_events
      SET status='sending', delivery_attempts=delivery_attempts+1,
          delivery_error=NULL, next_attempt_ms=NULL,
          delivery_claim_id=?, delivery_owner_pid=?, delivery_owner_boot_id=?,
          delivery_owner_start_ticks=?, updated_at=CURRENT_TIMESTAMP
      WHERE event_id=? AND status='pending'
        AND (next_attempt_ms IS NULL OR next_attempt_ms<=?)
        AND NOT EXISTS (SELECT 1 FROM capture_delivery_gate WHERE singleton=1)
    `).run(claimId, owner.pid, owner.bootId, owner.startTicks, candidate.event_id, nowMs);
    return claimed.changes === 1 ? getCaptureEvent(candidate.event_id) : null;
  });
  return claim.immediate();
}

export interface CaptureClaimProof {
  eventId: string;
  claimId: string;
  owner: ProcessIdentity;
}

export interface CaptureTransitionResult {
  outcome: "applied" | "already_applied";
  event: CaptureEventRow;
}

function sameClaim(event: CaptureEventRow, claim: CaptureClaimProof): boolean {
  return event.delivery_claim_id === claim.claimId
    && event.delivery_owner_pid === claim.owner.pid
    && event.delivery_owner_boot_id === claim.owner.bootId
    && event.delivery_owner_start_ticks === claim.owner.startTicks;
}

function transitionCaptureEvent(input: {
  claim: CaptureClaimProof;
  targetStatus: "pending" | "delivered" | "parked";
  update: () => number;
}): CaptureTransitionResult | null {
  const transition = captureDb.transaction(() => {
    const current = getCaptureEvent(input.claim.eventId);
    if (!current || !sameClaim(current, input.claim)) return null;
    if (current.status === input.targetStatus) return { outcome: "already_applied" as const, event: current };
    if (current.status !== "sending" || input.update() !== 1) return null;
    return { outcome: "applied" as const, event: getCaptureEvent(input.claim.eventId)! };
  });
  return transition.immediate();
}

export type CaptureDeliveryReceipt =
  | { kind: "slack"; slackMessageTs: string }
  | { kind: "journal"; journalFilePath: string }
  | { kind: "session"; sessionId: string; inputId: string };

function receiptMatches(event: CaptureEventRow, receipt: CaptureDeliveryReceipt): boolean {
  if (receipt.kind === "session") return event.delivery_kind === "session"
    && event.session_id === receipt.sessionId && event.session_input_id === receipt.inputId;
  return receipt.kind === "slack"
    ? event.delivery_kind === "slack"
      && event.slack_message_ts === receipt.slackMessageTs
      && event.journal_file_path === null
    : event.delivery_kind === "journal"
      && event.journal_file_path === receipt.journalFilePath
      && event.slack_message_ts === null;
}

export function markCaptureEventDelivered(
  claim: CaptureClaimProof,
  receipt: CaptureDeliveryReceipt,
): CaptureTransitionResult | null {
  if ((receipt.kind === "slack" && !receipt.slackMessageTs)
    || (receipt.kind === "journal" && !receipt.journalFilePath)
    || (receipt.kind === "session" && (!receipt.sessionId || !receipt.inputId))) {
    throw new Error("Capture delivery receipt must be non-empty.");
  }
  const transition = captureDb.transaction(() => {
    const current = getCaptureEvent(claim.eventId);
    if (!current || !sameClaim(current, claim)) return null;
    if (current.delivery_kind !== receipt.kind) {
      throw new Error("Capture delivery receipt kind does not match its durable destination.");
    }
    if (receipt.kind === "journal" && receipt.journalFilePath !== `pebble-${current.event_id}.md`) {
      throw new Error("Capture journal receipt does not match its durable event identity.");
    }
    if (current.status === "delivered") {
      return receiptMatches(current, receipt)
        ? { outcome: "already_applied" as const, event: current }
        : null;
    }
    if (current.status !== "sending") return null;
    const updated = captureDb.query(`
      UPDATE capture_events
      SET status='delivered', slack_message_ts=?, journal_file_path=?, session_id=?, session_input_id=?,
          delivery_error=NULL, next_attempt_ms=NULL,
          delivered_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
      WHERE event_id=? AND status='sending' AND delivery_claim_id=?
        AND delivery_owner_pid=? AND delivery_owner_boot_id=?
        AND delivery_owner_start_ticks=?
    `).run(
      receipt.kind === "slack" ? receipt.slackMessageTs : null,
      receipt.kind === "journal" ? receipt.journalFilePath : null,
      receipt.kind === "session" ? receipt.sessionId : null,
      receipt.kind === "session" ? receipt.inputId : null,
      claim.eventId,
      claim.claimId,
      claim.owner.pid,
      claim.owner.bootId,
      claim.owner.startTicks,
    );
    return updated.changes === 1
      ? { outcome: "applied" as const, event: getCaptureEvent(claim.eventId)! }
      : null;
  });
  return transition.immediate();
}

export function markCaptureEventRetry(
  claim: CaptureClaimProof,
  error: string,
  nextAttemptMs: number,
): CaptureTransitionResult | null {
  return transitionCaptureEvent({
    claim,
    targetStatus: "pending",
    update: () => captureDb.query(`
      UPDATE capture_events
      SET status='pending', delivery_error=?, next_attempt_ms=?, updated_at=CURRENT_TIMESTAMP
      WHERE event_id=? AND status='sending' AND delivery_claim_id=?
        AND delivery_owner_pid=? AND delivery_owner_boot_id=?
        AND delivery_owner_start_ticks=?
    `).run(
      error,
      nextAttemptMs,
      claim.eventId,
      claim.claimId,
      claim.owner.pid,
      claim.owner.bootId,
      claim.owner.startTicks,
    ).changes,
  });
}

export function parkCaptureEvent(
  claim: CaptureClaimProof,
  error: string,
): CaptureTransitionResult | null {
  return transitionCaptureEvent({
    claim,
    targetStatus: "parked",
    update: () => captureDb.query(`
      UPDATE capture_events
      SET status='parked', delivery_error=?, next_attempt_ms=NULL,
          parked_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
      WHERE event_id=? AND status='sending' AND delivery_claim_id=?
        AND delivery_owner_pid=? AND delivery_owner_boot_id=?
        AND delivery_owner_start_ticks=?
    `).run(
      error,
      claim.eventId,
      claim.claimId,
      claim.owner.pid,
      claim.owner.bootId,
      claim.owner.startTicks,
    ).changes,
  });
}
