import type { Database } from "bun:sqlite";

/** The scope every service notice input carries; the one mark that says "nobody's turn wrote this". */
export const SERVICE_NOTICE_SCOPE = "service:provider-free-notice";

/**
 * A moment as Tejas reads it: his own time zone, the one the saved-work settings hold, never
 * an ISO stamp ("September 24, 11:03 PM ET"). A notice is read by him, not by a log reader.
 */
export function noticeTime(db: Database, ms: number): string {
  let timeZone = "America/New_York";
  try {
    const row = db.query("SELECT time_zone FROM saved_work_settings WHERE singleton=1").get() as { time_zone: string } | null;
    if (row?.time_zone) timeZone = row.time_zone;
  } catch {}
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "shortGeneric" }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

/**
 * Publish one service-authored Inbox message and reading notice without starting a provider.
 * The notice has no turn behind it, so nothing would ever file it into a thread; the owner files
 * it itself (`fileServiceNotices` in session-topics.ts) — a caller inside the Concierge process
 * calls that right after publishing, and a separate process relies on the running owner doing
 * it at startup and when the message is resolved to its thread.
 */
export function publishProviderFreeNotice(db: Database, input: {
  key: string;
  text: string;
  kind: string;
  payload?: Record<string, unknown>;
}): boolean {
  const inbox = db.query(`SELECT id,native_metadata_json FROM sessions
    WHERE json_extract(native_metadata_json,'$.inbox')=1 ORDER BY id DESC LIMIT 1`)
    .get() as { id: number; native_metadata_json: string | null } | null;
  if (!inbox) throw new Error("No Inbox session exists for the service notice.");
  const eventId = `service-notice:${input.key}`;
  const inputId = `service:${eventId}`;
  // A notice is read by Tejas in his Inbox, not by a log reader: a moment is written in his time
  // zone (`noticeTime`) and a file path tells him nothing. Logged, never refused, because a notice
  // that is dropped for its wording is worse than one that is clumsy (2026-09-25).
  const unreadable = [/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(input.text) ? "iso-timestamp" : "", /(?:^|[\s(])(?:\/|~\/)[\w.-]+\/[\w./-]+/.test(input.text) || /\b[\w-]+\/[\w-]+\/[\w-]+\.(?:log|md|txt|json|ts|js|sh)\b/.test(input.text) ? "file-path" : ""].filter(Boolean);
  if (unreadable.length) console.warn(JSON.stringify({ level: "warn", event: "service_notice_unreadable", key: input.key, unreadable }));
  return db.transaction(() => {
    const inserted = db.query(`INSERT OR IGNORE INTO session_inputs
      (id,session_id,scope,action_id,kind,origin,payload_json,receipt_json)
      VALUES(?,?,?,?,?,?,?,?)`).run(inputId, inbox.id, SERVICE_NOTICE_SCOPE, eventId,
        "input", "service", JSON.stringify({ text: input.text, delivery: "queue" }),
        JSON.stringify({ state: "completed", imported: true }));
    if (inserted.changes !== 1) return false;
    const addEvent = (id: string, kind: string, payload: unknown) => db.query(`INSERT INTO session_owner_events
      (event_id,session_id,input_id,turn_id,kind,payload_json) VALUES(?,?,?,NULL,?,?)`)
      .run(id, inbox.id, inputId, kind, JSON.stringify(payload));
    addEvent(`accepted:${inputId}`, "accepted", { origin: "service", text: input.text });
    addEvent(eventId, input.kind, input.payload ?? {});
    const meta = JSON.parse(inbox.native_metadata_json || "{}");
    const generation = (meta.generation ?? 0) + 1;
    const question = input.text.slice(0, 2000);
    db.query("UPDATE sessions SET native_metadata_json=? WHERE id=?")
      .run(JSON.stringify({ ...meta, generation, needs: [...(meta.needs ?? []), {
        inputId, outcome: "response", question, generation, at: new Date().toISOString(), runId: "", eventId,
      }] }), inbox.id);
    addEvent(`needs_you:${eventId}`, "needs_you", { outcome: "response", question, inputId, generation });
    return true;
  })();
}
