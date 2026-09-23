#!/usr/bin/env bun
/**
 * Notices every change to a file that keeps Tejas signed in or connected, however it was made,
 * says so, and holds it until he approves. The second half of one mechanism: the pre-tool guard
 * (protected-change-guard.ts) stops an agent before it writes; this catches what the guard never
 * saw (a script, another machine, a person) and what it allowed.
 *
 * On 2026-09-23 thnkr.ing's settings were rewritten at 08:22 and applied by a restart 20 seconds
 * later; nothing announced it, and he reconstructed the cause from logs after losing a morning.
 * Now each change publishes a `secrets_rotated` event (file, which keys, who, when it takes effect),
 * raises it to his Needs attention (which Thinkering also pushes to his phone), and, for a file a
 * service reads at start, keeps the previous values in effect through a held override file the
 * service loads after the real one. A change nobody approved is therefore never applied by a
 * restart; he replies "approve <code>" to let it take effect at the next restart.
 *
 * Run by remote-box's protected-secrets-watch units when a watched file changes and every minute.
 * Values never leave this machine's root-only state directory: events name keys, never values.
 */
import { randomInt } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { SECRET_FILES, secretFingerprints, type SecretFile } from '../src/protected-secrets-policy';

const stateDir = process.env.CONCIERGE_STATE_DIR;
if (!stateDir) throw new Error('CONCIERGE_STATE_DIR is required.');
// Only its own few rows, written directly: loading Concierge's state module would run its schema
// setup against the live ledger from outside the running release (it collided, SQLITE_BUSY).
const db = new Database(join(stateDir, 'state.db'));
db.exec('PRAGMA busy_timeout=15000');
type SessionRow = { id: number; native_metadata_json: string | null };
const metadataOf = (id: number) => JSON.parse((db.query('SELECT native_metadata_json FROM sessions WHERE id=?').get(id) as SessionRow | null)?.native_metadata_json || '{}');
const setMetadata = (id: number, change: object) => db.query('UPDATE sessions SET native_metadata_json=? WHERE id=?').run(JSON.stringify({ ...metadataOf(id), ...change }), id);
const titleOf = (id: number): string | null => metadataOf(id).title ?? null;
const inboxSession = () => db.query(`SELECT id FROM sessions WHERE json_extract(native_metadata_json,'$.inbox')=1 ORDER BY id DESC LIMIT 1`).get() as { id: number } | null;
const event = (eventId: string, sessionId: number, inputId: string | null, kind: string, payload: object) =>
  db.query('INSERT OR IGNORE INTO session_owner_events(event_id,session_id,input_id,turn_id,kind,payload_json) VALUES(?,?,?,NULL,?,?)').run(eventId, sessionId, inputId, kind, JSON.stringify(payload));
const home = join(stateDir, 'protected-secrets');
const dirs = { baseline: join(home, 'baseline'), pending: join(home, 'pending'), held: join(home, 'held') };
const acts = join(stateDir, 'protected-change-requests', 'acts');
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true, mode: 0o700 });
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const ACT_WINDOW_MS = 60 * 60 * 1000;
const slug = (file: SecretFile) => file.path.replace(/^\//, '').replace(/[^\w.-]+/g, '_');
const read = (path: string) => { try { return readFileSync(path, 'utf8'); } catch { return null; } };
const readJson = (path: string) => { const text = read(path); return text === null ? null : JSON.parse(text); };
const write = (path: string, text: string) => writeFileSync(path, text, { mode: 0o600 });
const same = (a: Record<string, string>, b: Record<string, string>) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
const log = (fields: object) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }));

/** Who made the change: the guard's record of an approved act, else the agent turns running then. */
function author(file: SecretFile) {
  let names: string[] = [];
  try { names = readdirSync(acts).filter(name => name.endsWith('.json')).sort(); } catch {}
  for (const name of names.reverse()) {
    const act = readJson(join(acts, name));
    if (!act || !act.targets?.includes(file.target) || Date.now() - Date.parse(act.at) > ACT_WINDOW_MS) continue;
    const session = act.providerSession ? db.query(`SELECT id FROM sessions WHERE agent_session_uuid=? OR json_extract(native_metadata_json,'$.runtimeThreadId')=? LIMIT 1`)
      .get(act.providerSession, act.providerSession) as { id: number } | null : null;
    const turn = session ? db.query(`SELECT id, native_run_id FROM turns WHERE session_id=? ORDER BY id DESC LIMIT 1`).get(session.id) as { id: number; native_run_id: string | null } | null : null;
    return { via: 'approved' as const, code: act.code, at: act.at, sessionId: session ? `concierge:${session.id}` : null,
      title: session ? titleOf(session.id) : null, turnId: turn?.id ?? null, runId: turn?.native_run_id ?? null };
  }
  const running = db.query(`SELECT DISTINCT session_id FROM turns WHERE status IN ('running','delivering') ORDER BY session_id LIMIT 8`).all() as { session_id: number }[];
  return { via: 'unapproved' as const, runningSessions: running.map(row => ({ sessionId: `concierge:${row.session_id}`, title: titleOf(row.session_id) })) };
}

function serviceStarted(file: SecretFile): string | null {
  const unit = /\(([\w.-]+\.service)\)/.exec(file.service)?.[1];
  if (!unit) return null;
  try { return execFileSync('systemctl', ['show', unit, '-p', 'ActiveEnterTimestamp', '--value'], { encoding: 'utf8' }).trim() || null; } catch { return null; }
}

/** An Inbox notice he can read and answer, raised to Needs attention without any agent turn. */
function tellHim(eventId: string, text: string, kind: 'needs_you' | 'response', payload: object) {
  const inbox = inboxSession();
  if (!inbox) { log({ event: 'secrets_rotated_unannounced', reason: 'no Inbox session', eventId }); return null; }
  const inputId = `secrets:${eventId}`;
  db.transaction(() => {
    db.query(`INSERT OR IGNORE INTO session_inputs(id,session_id,scope,action_id,kind,origin,payload_json,receipt_json)
      VALUES(?,?,?,?,?,?,?,?)`).run(inputId, inbox.id, 'service:protected-secrets', eventId, 'input', 'service',
      JSON.stringify({ text, delivery: 'queue' }), JSON.stringify({ state: 'completed', imported: true }));
    // Shown in the Inbox as a service message, with no agent turn.
    event(`accepted:${inputId}`, inbox.id, inputId, 'accepted', { origin: 'service', text });
    event(eventId, inbox.id, inputId, 'secrets_rotated', payload);
    const meta = metadataOf(inbox.id), generation = (meta.generation ?? 0) + 1, at = new Date().toISOString();
    setMetadata(inbox.id, { generation, needs: [...(meta.needs ?? []), { inputId, outcome: kind, question: text.slice(0, 2000), generation, at, runId: '', eventId }] });
    event(`needs_you:${eventId}`, inbox.id, inputId, 'needs_you', { outcome: kind, question: text.slice(0, 2000), inputId, generation });
  })();
  return inputId;
}

function settleNeed(eventId: string) {
  const inbox = inboxSession();
  if (!inbox) return;
  const meta = metadataOf(inbox.id);
  const needs = (meta.needs ?? []).filter((need: { eventId?: string }) => need.eventId !== eventId);
  if (needs.length !== (meta.needs ?? []).length) setMetadata(inbox.id, { needs });
}

function approvedBy(code: string, since: string): string | null {
  const row = db.query(`SELECT id FROM session_inputs WHERE origin='human' AND id NOT IN (SELECT input_id FROM session_input_author_corrections)
    AND created_at >= datetime(?) AND upper(coalesce(json_extract(payload_json,'$.text'),json_extract(payload_json,'$.firstInput.text'),'')) LIKE ?
    ORDER BY created_at LIMIT 1`).get(since.replace('T', ' ').slice(0, 19), `%APPROVE ${code}%`) as { id: string } | null;
  return row?.id ?? null;
}

const keyLines = (content: string, keys: string[]) => content.split('\n')
  .filter(line => keys.includes(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1] ?? '')).join('\n') + '\n';

for (const file of SECRET_FILES) {
  const name = slug(file), content = read(file.path), now = secretFingerprints(content, file.format);
  const baselinePath = join(dirs.baseline, `${name}.json`), contentPath = join(dirs.baseline, `${name}.content`), pendingPath = join(dirs.pending, `${name}.json`);
  const heldPath = file.holdFile ? join(dirs.held, file.holdFile) : null;
  const baseline = readJson(baselinePath) as { fingerprints: Record<string, string> } | null;
  const accept = () => { write(baselinePath, JSON.stringify({ fingerprints: now, at: new Date().toISOString() })); if (content !== null) write(contentPath, content); };
  if (!baseline) { accept(); log({ event: 'secrets_baseline_recorded', path: file.path, keys: Object.keys(now) }); continue; }
  const pending = readJson(pendingPath) as { code: string; fingerprints: Record<string, string>; detectedAt: string; eventId: string } | null;
  if (same(now, baseline.fingerprints)) {
    if (pending) { // put back as it was: nothing to hold or approve
      rmSync(pendingPath, { force: true }); if (heldPath) rmSync(heldPath, { force: true }); settleNeed(pending.eventId);
      log({ event: 'secrets_rotation_reverted', path: file.path, code: pending.code });
    }
    continue;
  }
  if (pending && same(now, pending.fingerprints)) {
    const answer = approvedBy(pending.code, pending.detectedAt);
    if (answer) {
      accept(); rmSync(pendingPath, { force: true }); if (heldPath) rmSync(heldPath, { force: true }); settleNeed(pending.eventId);
      log({ event: 'secrets_rotation_approved', path: file.path, code: pending.code, approvedBy: answer, takesEffect: `next restart of ${file.service}` });
    }
    continue;
  }
  // A new change. One still waiting from earlier is superseded by this one.
  if (pending) settleNeed(pending.eventId);
  const keys = {
    changed: Object.keys(now).filter(key => key in baseline.fingerprints && baseline.fingerprints[key] !== now[key]),
    added: Object.keys(now).filter(key => !(key in baseline.fingerprints)),
    removed: Object.keys(baseline.fingerprints).filter(key => !(key in now)),
  };
  const who = author(file), code = Array.from({ length: 5 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  const eventId = `secrets-rotated:${name}:${Date.now()}`, detectedAt = new Date().toISOString(), started = serviceStarted(file);
  const previous = read(contentPath);
  const hold = who.via === 'unapproved' && !!heldPath && previous !== null && file.format === 'env';
  if (hold) write(heldPath!, keyLines(previous!, [...keys.changed, ...keys.removed]));
  const signsOut = [...keys.changed, ...keys.removed].includes('THINKERING_SESSION_KEY');
  const keyList = [...keys.changed.map(key => `${key} changed`), ...keys.added.map(key => `${key} added`), ...keys.removed.map(key => `${key} removed`)].join(', ');
  const whoText = who.via === 'approved'
    ? `the agent in ${who.title ?? who.sessionId ?? 'an unidentified session'}${who.sessionId ? ` (${who.sessionId})` : ''}, with your approval ${who.code}`
    : `something that did not go through the approval check${who.runningSessions.length ? `; agents working at the time: ${who.runningSessions.map(item => item.title ?? item.sessionId).join(', ')}` : ''}`;
  const effect = signsOut ? ' Changing the session key signs you out of every thnkr.ing screen when it takes effect.' : '';
  const text = hold
    ? `Keys that keep you signed in were changed without approval: ${keyList} in ${file.service}'s settings, at ${detectedAt.slice(11, 16)} UTC, by ${whoText}.${effect} It is on hold: ${file.service} keeps the previous values, even across restarts, so nothing changes for you yet. Reply "approve ${code}" to let the change take effect at the next restart. If you did not intend it, leave it and ask an agent to put the file back.`
    : who.via === 'approved'
      ? `The change you approved was made: ${keyList} in ${file.service}'s settings, at ${detectedAt.slice(11, 16)} UTC, by ${whoText}. It takes effect when ${file.service} next restarts${started ? ` (it has been running since ${started})` : ''}.${effect}`
      : `A key was changed without approval: ${keyList} for ${file.service}, at ${detectedAt.slice(11, 16)} UTC, by ${whoText}. It could not be held, so it takes effect when ${file.service} next restarts${started ? ` (running since ${started})` : ''}.${effect} Ask an agent to put it back if you did not intend it.`;
  const payload = { path: file.path, service: file.service, keys, author: who, held: hold, signsOut, code: hold ? code : null,
    takesEffect: hold ? 'after your approval, at the next restart' : 'at the next restart', serviceStartedAt: started, detectedAt };
  log({ event: 'secrets_rotated', ...payload });
  const inputId = tellHim(eventId, text, hold || who.via === 'unapproved' ? 'needs_you' : 'response', payload);
  if (hold) write(pendingPath, JSON.stringify({ code, fingerprints: now, detectedAt, eventId, inputId }));
  else accept();
}
