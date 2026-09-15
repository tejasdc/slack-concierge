import { createHash } from "node:crypto";
import { codexHistoryMessages } from "./provider-history";
import {
  boundCodexSessionId,
  db,
  getSessionById,
  isConciergeProviderTurn,
} from "./state";
import { recordSessionEvent, sessionMetadata, updateSessionMetadata } from "./session-inputs";

/**
 * A Codex thread is one conversation no matter which client advanced it. Turns this owner
 * dispatched already reach the session through `projectSessionProviderMessage`, which keeps
 * their accepted input and human/agent/service identity attached. Turns entered from another
 * Codex client have no accepted input here and previously reached only the Slack mirror, so
 * the same conversation read differently depending on the surface it was opened from. This
 * projects those observed items onto the owner's event stream as what they are: retained
 * provider messages with no admitted input behind them.
 *
 * It admits nothing, executes nothing and claims no new authority. The session binding is
 * the only thing that establishes ownership, and a thread claimed by more than one live
 * session is left alone.
 */
export function projectObservedCodexItem(
  providerThreadUuid: string,
  providerTurnId: string,
  item: any,
): boolean {
  if (!providerThreadUuid || !providerTurnId || typeof item?.id !== "string" || !item.id) return false;
  const sessionId = boundCodexSessionId(providerThreadUuid);
  if (sessionId === null) return false;
  // The owner's own turn already owns these items, including their input correlation.
  if (isConciergeProviderTurn(providerThreadUuid, providerTurnId)) return false;
  let messages;
  try { messages = codexHistoryMessages(item, providerTurnId, providerThreadUuid); }
  catch { return false; } // Missing native identity cannot become a fabricated message.
  let recorded = false;
  for (const message of messages) {
    const payload = { message };
    const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const eventId = `observed:${providerThreadUuid}:${providerTurnId}:${message.id}:${digest}`;
    // A redelivered item is the same retained fact; it must not advance the surface again.
    if (db.query("SELECT 1 FROM session_owner_events WHERE event_id=?").get(eventId)) continue;
    recordSessionEvent({ eventId, sessionId, inputId: null, turnId: null, kind: "message", payload });
    recorded = true;
  }
  if (!recorded) return false;
  // New unread conversation content, not a new execution outcome: generation advances so the
  // surface re-reads, while attention/outcome stay with their existing owners.
  const session = getSessionById(sessionId);
  if (session) updateSessionMetadata(sessionId, { generation: (sessionMetadata(session).generation ?? 0) + 1 });
  return true;
}
