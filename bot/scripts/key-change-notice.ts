#!/usr/bin/env bun
/**
 * Tells Tejas when a key that keeps him signed in or connected changes, however it changed. It
 * blocks and holds nothing.
 *
 * On 2026-09-23 thnkr.ing's settings were rewritten at 08:22 and applied by a restart 20 seconds
 * later; nothing said so, and he rebuilt the cause from logs after losing a morning. Now each
 * change publishes one `secrets_rotated` event (the file, which keys changed, the agents working
 * at the time, when it takes effect), puts a service message in his Inbox and raises it to Needs
 * attention as something to read, which Thinkering pushes to his phone. No agent turn is involved.
 *
 * Run by remote-box's `remote-box-key-change-notice` units: on a change and once a minute. Only
 * fingerprints are kept (never values), in the Concierge state directory.
 */
import { Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KEY_FILES, keyFingerprints, type KeyFile } from '../src/key-files';

const stateDir = process.env.CONCIERGE_STATE_DIR;
if (!stateDir) throw new Error('CONCIERGE_STATE_DIR is required.');
const baselines = join(stateDir, 'key-change-notice');
mkdirSync(baselines, { recursive: true, mode: 0o700 });
// Only its own few rows, written directly: loading Concierge's state module would run its schema
// setup against the live ledger from outside the running release.
const db = new Database(join(stateDir, 'state.db'));
db.exec('PRAGMA busy_timeout=15000');
const read = (path: string) => { try { return readFileSync(path, 'utf8'); } catch { return null; } };
const log = (fields: object) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
const metadataOf = (id: number) => JSON.parse((db.query('SELECT native_metadata_json FROM sessions WHERE id=?').get(id) as { native_metadata_json: string | null } | null)?.native_metadata_json || '{}');
const titleOf = (id: number): string | null => metadataOf(id).title ?? null;
const event = (eventId: string, sessionId: number, inputId: string, kind: string, payload: object) =>
  db.query('INSERT OR IGNORE INTO session_owner_events(event_id,session_id,input_id,turn_id,kind,payload_json) VALUES(?,?,?,NULL,?,?)').run(eventId, sessionId, inputId, kind, JSON.stringify(payload));

function startedAt(file: KeyFile): string | null {
  if (!file.unit) return null;
  try { return execFileSync('systemctl', ['show', file.unit, '-p', 'ActiveEnterTimestamp', '--value'], { encoding: 'utf8' }).trim() || null; } catch { return null; }
}

/** A service message in the Inbox, raised to Needs attention as something to read. */
function tellHim(eventId: string, text: string, payload: object) {
  const inbox = db.query(`SELECT id FROM sessions WHERE json_extract(native_metadata_json,'$.inbox')=1 ORDER BY id DESC LIMIT 1`).get() as { id: number } | null;
  if (!inbox) { log({ event: 'secrets_rotated_unannounced', reason: 'no Inbox session', eventId }); return; }
  const inputId = `secrets:${eventId}`;
  db.transaction(() => {
    db.query(`INSERT OR IGNORE INTO session_inputs(id,session_id,scope,action_id,kind,origin,payload_json,receipt_json) VALUES(?,?,?,?,?,?,?,?)`)
      .run(inputId, inbox.id, 'service:key-change-notice', eventId, 'input', 'service', JSON.stringify({ text, delivery: 'queue' }), JSON.stringify({ state: 'completed', imported: true }));
    event(`accepted:${inputId}`, inbox.id, inputId, 'accepted', { origin: 'service', text });
    event(eventId, inbox.id, inputId, 'secrets_rotated', payload);
    const meta = metadataOf(inbox.id), generation = (meta.generation ?? 0) + 1;
    db.query('UPDATE sessions SET native_metadata_json=? WHERE id=?').run(JSON.stringify({ ...meta, generation,
      needs: [...(meta.needs ?? []), { inputId, outcome: 'response', question: text.slice(0, 2000), generation, at: new Date().toISOString(), runId: '', eventId }] }), inbox.id);
    event(`needs_you:${eventId}`, inbox.id, inputId, 'needs_you', { outcome: 'response', question: text.slice(0, 2000), inputId, generation });
  })();
}

for (const file of KEY_FILES) {
  const name = file.path.replace(/^\//, '').replace(/[^\w.-]+/g, '_');
  const baselinePath = join(baselines, `${name}.json`);
  const now = keyFingerprints(read(file.path), file.format);
  const saved = read(baselinePath);
  writeFileSync(baselinePath, JSON.stringify(now), { mode: 0o600 });
  if (saved === null) { log({ event: 'key_baseline_recorded', path: file.path, keys: Object.keys(now) }); continue; }
  const before = JSON.parse(saved) as Record<string, string>;
  const keys = {
    changed: Object.keys(now).filter(key => key in before && before[key] !== now[key]),
    added: Object.keys(now).filter(key => !(key in before)),
    removed: Object.keys(before).filter(key => !(key in now)),
  };
  if (!keys.changed.length && !keys.added.length && !keys.removed.length) continue;
  const working = (db.query(`SELECT DISTINCT session_id FROM turns WHERE status IN ('running','delivering') ORDER BY session_id LIMIT 8`).all() as { session_id: number }[])
    .map(row => ({ sessionId: `concierge:${row.session_id}`, title: titleOf(row.session_id) }));
  const detectedAt = new Date().toISOString(), started = startedAt(file);
  const signsOut = [...keys.changed, ...keys.removed].includes('THINKERING_SESSION_KEY');
  const named = (list: string[], verb: string) => list.map(key => key === '(file)' ? verb : `${key} ${verb}`);
  const what = [...named(keys.changed, 'changed'), ...named(keys.added, 'added'), ...named(keys.removed, 'removed')].join(', ');
  const text = `A key changed for ${file.service}: ${what}, at ${detectedAt.slice(11, 16)} UTC.`
    + ` It takes effect the next time ${file.service} restarts${started ? ` (running since ${started})` : ''}.`
    + (signsOut ? ' Changing the session key signs you out of every thnkr.ing screen at that restart.' : '')
    + (working.length ? ` Agents working at the time: ${working.map(item => item.title ?? item.sessionId).join(', ')}.` : ' No agent was working at the time.');
  const eventId = `secrets-rotated:${name}:${Date.now()}`;
  const payload = { path: file.path, service: file.service, unit: file.unit ?? null, keys, signsOut, workingAtTheTime: working, detectedAt, serviceStartedAt: started, takesEffect: 'next restart' };
  log({ event: 'secrets_rotated', ...payload });
  tellHim(eventId, text, payload);
}
