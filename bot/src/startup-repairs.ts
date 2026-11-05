import { db } from './state';
import { recordSessionEvent } from './session-inputs';
import { inboxSession } from './session-inbox';

/**
 * Startup work must cost what changed since the last start, not the size of history. A repair for
 * an old incident scanned every forwarded post or every session on each start; on a cold, loaded
 * disk those sweeps held a start for 126 s, past the update's 90 s health deadline (incident
 * ce2c2192, 2026-11-05). A finished one-time repair is recorded as an event on the Inbox session,
 * the same way the topics migration records itself, and is skipped from then on. Without an Inbox
 * session (a fresh or test state) there is nowhere to record it, so it simply runs.
 */
export function runStartupRepairOnce<T>(name: string, work: () => T): T | { skipped: 'already_done' } {
  const eventId = `startup-repair:${name}`;
  if (db.query('SELECT 1 FROM session_owner_events WHERE event_id=?').get(eventId)) return { skipped: 'already_done' };
  const result = work();
  const inbox = inboxSession();
  if (inbox) recordSessionEvent({ eventId, sessionId: inbox.id, kind: 'startup_repair',
    payload: { name, result: result ?? null, completedAt: new Date().toISOString() } });
  return result;
}

/**
 * A recurring startup catch-up over the owner's event log looks only at events after its last
 * completed pass. Each pass records its high-water sequence as its own event (events are written
 * once), and the latest one is found by its id range.
 */
export function runStartupCatchUp<T>(name: string, work: (afterSequence: number) => T): T {
  const prefix = `startup-catch-up:${name}:`;
  const last = db.query(`SELECT json_extract(payload_json,'$.throughSequence') AS through FROM session_owner_events
    WHERE event_id > ? AND event_id < ? ORDER BY sequence DESC LIMIT 1`).get(prefix, `startup-catch-up:${name};`) as { through: number } | null;
  const afterSequence = Number(last?.through ?? 0);
  const through = Number((db.query('SELECT COALESCE(MAX(sequence),0) AS max FROM session_owner_events').get() as { max: number }).max);
  const result = work(afterSequence);
  const inbox = inboxSession();
  if (inbox && through > afterSequence) recordSessionEvent({ eventId: `${prefix}${through}`, sessionId: inbox.id,
    kind: 'startup_catch_up', payload: { name, afterSequence, throughSequence: through } });
  return result;
}
