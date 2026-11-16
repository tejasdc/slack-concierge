import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { receiveMacDiskWarning } from '../src/mac-disk-warning';
import { ledgerWriteResults } from '../src/ledger-write-results';

const state = mkdtempSync(join(tmpdir(), 'concierge-mac-disk-notice-'));
const db = ledgerWriteResults(new Database(join(state, 'state.db')));
try {
  db.exec(`CREATE TABLE sessions(id INTEGER PRIMARY KEY,status TEXT,native_metadata_json TEXT);
    INSERT INTO sessions VALUES(1,'idle','{"inbox":true,"standingRole":"inbox"}');
    CREATE TABLE session_inputs(id TEXT PRIMARY KEY,session_id INTEGER,scope TEXT,action_id TEXT,
      kind TEXT,origin TEXT,payload_json TEXT,receipt_json TEXT);
    CREATE TABLE session_owner_events(event_id TEXT PRIMARY KEY,session_id INTEGER,input_id TEXT,
      turn_id INTEGER,kind TEXT,payload_json TEXT);`);
  const sendHealth = (key: string) => {
    const result = spawnSync(process.execPath, [join(import.meta.dir, 'service-notice.ts'), '--key', key,
      '--title', 'Mac disk space is low',
      '--', 'Your Mac has 18 GiB free. Concierge is checking its own output.'],
    {env: {...process.env, CONCIERGE_STATE_DIR: state}, encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  assert.equal(sendHealth('fixture:normal-health'), 'recorded');
  assert.equal(db.query('SELECT count(*) AS n FROM session_inputs').get().n, 0,
    'ordinary health stays with the repair agent');
  assert.throws(() => receiveMacDiskWarning(db, {episode: 1, freeBytes: 18 * 1024 ** 3}, false), /authenticated/);
  assert.throws(() => receiveMacDiskWarning(db, {episode: 1, freeBytes: 18 * 1024 ** 3, text: 'caller prose'}, true), /require/);
  assert.throws(() => receiveMacDiskWarning(db, {episode: -1, freeBytes: -1}, true), /require/);
  assert.equal(receiveMacDiskWarning(db, {episode: 1, freeBytes: 26 * 1024 ** 3, recovered: true}, true).status, 'recorded');
  assert.equal(receiveMacDiskWarning(db, {episode: 1, freeBytes: 17 * 1024 ** 3, recovered: false}, true).status, 'duplicate');
  assert.equal(db.query('SELECT count(*) AS n FROM session_inputs').get().n, 1,
    'requested warning has one actual Inbox input despite repeat transport');
  const event = db.query("SELECT kind FROM session_owner_events WHERE event_id='service-notice:mac-disk-low:1'").get();
  assert.equal(event.kind, 'requested_mac_disk_warning');
  const warning = db.query("SELECT payload_json FROM session_inputs WHERE id='service:service-notice:mac-disk-low:1'").get();
  assert.match(JSON.parse(warning.payload_json).text, /Free space has recovered/);
  assert.match(JSON.parse(warning.payload_json).text, /26.0 GiB/);
  const session = db.query('SELECT native_metadata_json FROM sessions WHERE id=1').get();
  const needs = JSON.parse(session.native_metadata_json).needs;
  assert.equal(needs.length, 1);
  assert.equal(needs[0].outcome, 'response', 'native Inbox attention is requested once');
  console.log('PASS: requested Mac disk warning records one Inbox input and attention; ordinary health stays repair-first');
} finally {
  db.close();
  rmSync(state, { recursive: true, force: true });
}
