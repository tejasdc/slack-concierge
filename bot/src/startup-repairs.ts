import { db } from './state';
import { log, errorFields } from './log';
import { recordSessionEvent } from './session-inputs';
import { inboxSession } from './session-inbox';
import { runStartupStep } from './startup-phase';
import {applySessionPurposeEntries,fillMissingSessionPurposes,markSessionPurposeFileApplied,readSessionPurposeFile} from './session-purpose';

/**
 * Startup costs what changed since the last start, not the size of history. Sweeps written for
 * past incidents scanned every forwarded post or every session on each start; on a cold, loaded
 * disk they held a start for 126 s, past the update's 90 s health deadline (incident ce2c2192,
 * 2026-11-05).
 *
 * Each such sweep is a catch-up over a key range (an event sequence or a session id) with a
 * high-water mark, recorded as a write-once event on the Inbox session. Every outstanding range,
 * including the remainder after an interrupted pass, runs after Concierge is online and its
 * health proof has had time to finish. It runs in pages of `pageSize` keys with a pause between
 * them, recording the mark after every page, so the serving loop is never held for long. A fresh
 * state without an Inbox session cannot retain a mark and retries its catch-up on the next start.
 */
const DEFERRED_START_DELAY_MS = 120_000;
const PAUSE_BETWEEN_PAGES_MS = 250;
type Pass = (afterKey: number, throughKey: number) => unknown;
type DeferredPass = { name: string; afterKey: number; throughKey: number; pageSize: number; pass: Pass; recordProgress: boolean; onCompleted?: () => void };
const deferred: DeferredPass[] = [];

function lastMark(name: string): number | null {
  const row = db.query(`SELECT json_extract(payload_json,'$.throughKey') AS through FROM session_owner_events
    WHERE event_id > ? AND event_id < ? ORDER BY sequence DESC LIMIT 1`)
    .get(`startup-catch-up:${name}:`, `startup-catch-up:${name};`) as { through: number } | null;
  return row ? Number(row.through) : null;
}

function recordMark(name: string, afterKey: number, throughKey: number) {
  const inbox = inboxSession();
  if (inbox && throughKey > afterKey) recordSessionEvent({ eventId: `startup-catch-up:${name}:${throughKey}`, sessionId: inbox.id,
    kind: 'startup_catch_up', payload: { name, afterKey, throughKey } });
}

export function runStartupCatchUp(name: string, maxKey: () => number, pass: Pass, pageSize: number): unknown {
  const mark = lastMark(name), through = maxKey();
  const after = mark ?? 0;
  if (through <= after) return { caught_up: true, through_key: after };
  deferred.push({ name, afterKey: after, throughKey: through, pageSize, pass, recordProgress: true });
  return { deferred: true, through_key: through };
}

/** Revisit work whose earlier rows can become eligible later; its pages have no permanent mark. */
export function runStartupSweep(name: string, maxKey: () => number, pass: Pass, pageSize: number, onCompleted?: () => void): unknown {
  const through = maxKey();
  deferred.push({ name, afterKey: 0, throughKey: through, pageSize, pass, recordProgress: false, onCompleted });
  return { deferred: true, through_key: through };
}

/** A purpose file must finish before fallback can fill the same missing sessions. */
export function scheduleSessionPurposeRepair(stateDir: string): unknown {
  const fallback = () => runStartupCatchUp('session-purposes', sessionMaxId,
    (afterId, throughId) => fillMissingSessionPurposes({ afterId, throughId }), 500);
  const input = readSessionPurposeFile(stateDir);
  if (!input) return fallback();
  return runStartupSweep('session-purpose-file', () => input.entries.length,
    (after, through) => applySessionPurposeEntries(input.entries.slice(after, through)), 500,
    () => runStartupSweep('session-purpose-fallback', sessionMaxId,
      (afterId, throughId) => fillMissingSessionPurposes({ afterId, throughId }), 500,
      () => {
        if (!markSessionPurposeFileApplied(stateDir, input.text))
          log('warn', 'session_purpose_file_changed_during_apply');
      }));
}

/** Called once Concierge reports online; works through each deferred first pass page by page. */
export function startDeferredStartupRepairs(shouldStop: () => boolean) {
  if (!deferred.length) return;
  log('info', 'startup_repairs_deferred', { names: deferred.map(item => item.name), delay_ms: DEFERRED_START_DELAY_MS });
  setTimeout(() => { void runDeferred(shouldStop); }, DEFERRED_START_DELAY_MS).unref?.();
}

async function runDeferred(shouldStop: () => boolean) {
  while (deferred.length) {
    const item = deferred.shift()!;
    const outcome = await runPages(item, shouldStop);
    log(outcome === 'completed' ? 'info' : 'error', 'startup_catch_up_first_pass', { name: item.name, outcome, through_key: item.throughKey });
    if (outcome === 'completed') {
      try { item.onCompleted?.(); }
      catch (error) { log('error', 'startup_catch_up_completion_failed', { name: item.name, ...errorFields(error) }); }
    }
  }
}

// A failed page records no mark beyond the last good one, so the next start resumes from there.
async function runPages(item: DeferredPass, shouldStop: () => boolean): Promise<'completed' | 'stopped' | 'failed'> {
  for (let after = item.afterKey; after < item.throughKey;) {
    if (shouldStop()) return 'stopped';
    const through = Math.min(after + item.pageSize, item.throughKey);
    if (!runPage(item, after, through)) return 'failed';
    after = through;
    await new Promise(resolve => setTimeout(resolve, PAUSE_BETWEEN_PAGES_MS));
  }
  return 'completed';
}

function runPage(item: DeferredPass, after: number, through: number): boolean {
  try {
    runStartupStep(`catch-up ${item.name}`, () => item.pass(after, through));
    if (item.recordProgress) recordMark(item.name, after, through);
    return true;
  } catch (error) {
    log('error', 'startup_catch_up_page_failed', { name: item.name, after_key: after, through_key: through, ...errorFields(error) });
    return false;
  }
}

export const ownerEventMaxSequence = () =>
  Number((db.query('SELECT COALESCE(MAX(sequence),0) AS max FROM session_owner_events').get() as { max: number }).max);
export const sessionMaxId = () =>
  Number((db.query('SELECT COALESCE(MAX(id),0) AS max FROM sessions').get() as { max: number }).max);
