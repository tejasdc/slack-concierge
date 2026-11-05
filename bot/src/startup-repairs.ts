import { db } from './state';
import { log, errorFields } from './log';
import { recordSessionEvent } from './session-inputs';
import { inboxSession } from './session-inbox';
import { runStartupStep } from './startup-phase';

/**
 * Startup work must cost what changed since the last start, not the size of history. Repairs for
 * past incidents scanned every forwarded post or every session on each start; on a cold, loaded
 * disk those sweeps held a start for 126 s, past the update's 90 s health deadline (incident
 * ce2c2192, 2026-11-05).
 *
 * A repair that has completed is recorded as an event on the Inbox session (as the topics
 * migration records itself) and skipped from then on. One without a record never runs on the start
 * path: it is queued and runs after Concierge is online, once the update's health proof has had
 * time to finish (DEFERRED_REPAIR_DELAY_MS), one repair per turn of the event loop. Its synchronous
 * sweep then holds the loop once, while serving, instead of failing a start. Without an Inbox
 * session (a fresh or test state) nothing can be recorded, so a repair runs at once, as before.
 */
const DEFERRED_REPAIR_DELAY_MS = 120_000;
const deferred: { name: string; run: () => void }[] = [];

function recordDone(eventId: string, kind: string, payload: Record<string, unknown>) {
  const inbox = inboxSession();
  if (inbox) recordSessionEvent({ eventId, sessionId: inbox.id, kind, payload });
}

export function runStartupRepairOnce<T>(name: string, work: () => T): T | { skipped: 'already_done' } | { deferred: true } {
  const eventId = `startup-repair:${name}`;
  if (db.query('SELECT 1 FROM session_owner_events WHERE event_id=?').get(eventId)) return { skipped: 'already_done' };
  const finish = () => {
    const result = work();
    recordDone(eventId, 'startup_repair', { name, result: result ?? null, completedAt: new Date().toISOString() });
    return result;
  };
  if (!inboxSession()) return finish();
  deferred.push({ name, run: () => { log('info', 'startup_repair_completed', { name, result: runStartupStep(`deferred ${name}`, finish) ?? null }); } });
  return { deferred: true };
}

/**
 * A recurring catch-up over the owner's event log reads only events after its last completed pass;
 * each pass records its high-water sequence as its own event (events are written once). Before its
 * first recorded pass it is deferred like a one-time repair, since that pass reads all history.
 */
export function runStartupCatchUp<T>(name: string, work: (afterSequence: number) => T): T | { deferred: true } {
  const prefix = `startup-catch-up:${name}:`;
  const last = db.query(`SELECT json_extract(payload_json,'$.throughSequence') AS through FROM session_owner_events
    WHERE event_id > ? AND event_id < ? ORDER BY sequence DESC LIMIT 1`).get(prefix, `startup-catch-up:${name};`) as { through: number } | null;
  const pass = () => {
    const afterSequence = Number(last?.through ?? 0);
    const through = Number((db.query('SELECT COALESCE(MAX(sequence),0) AS max FROM session_owner_events').get() as { max: number }).max);
    const result = work(afterSequence);
    if (through > afterSequence) recordDone(`${prefix}${through}`, 'startup_catch_up', { name, afterSequence, throughSequence: through });
    return result;
  };
  if (last || !inboxSession()) return pass();
  deferred.push({ name, run: () => { log('info', 'startup_catch_up_completed', { name, result: runStartupStep(`deferred ${name}`, pass) ?? null }); } });
  return { deferred: true };
}

/** Called once Concierge reports online; runs each deferred repair later, one per event-loop turn. */
export function startDeferredStartupRepairs(shouldStop: () => boolean) {
  if (!deferred.length) return;
  log('info', 'startup_repairs_deferred', { names: deferred.map(item => item.name), delay_ms: DEFERRED_REPAIR_DELAY_MS });
  // A failed repair is not recorded, so the next start defers it again; it is never retried here.
  const runOne = (item: { name: string; run: () => void }) => {
    try { item.run(); } catch (error) { log('error', 'startup_repair_failed', { name: item.name, ...errorFields(error) }); }
  };
  const next = () => {
    const item = deferred.shift();
    if (!item || shouldStop()) return;
    runOne(item);
    setTimeout(next, 0);
  };
  setTimeout(next, DEFERRED_REPAIR_DELAY_MS).unref?.();
}
