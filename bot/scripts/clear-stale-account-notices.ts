/**
 * The account notices already pinned to his conversations that never described anything.
 *
 * Until 2026-09-29 a conversation with no recorded account announced which account it had landed
 * on, even when that was the account he had selected himself and nothing had changed; and the
 * sentence was never cleared afterwards, so it stayed under the header indefinitely. He found 27
 * of them across his conversations. The emission rule is fixed, but a forward-only fix leaves
 * every one of those still on screen, waiting for him to close them one at a time.
 *
 * This clears the stored sentence — the only thing the banner reads — for conversations whose
 * notice is one of those announcements. A conversation that genuinely continued on another
 * account keeps its sentence, because that one is true and he may not have read it yet. The
 * `account` ledger events are history and are left exactly as they are.
 *
 * Run once, from the repository, with CONCIERGE_STATE_DIR pointing at the live state directory.
 */
import { db } from "../src/state";

const rows = db.query(`SELECT id, json_extract(native_metadata_json,'$.claudeAccountNotice') AS notice
  FROM sessions WHERE json_extract(native_metadata_json,'$.claudeAccountNotice') IS NOT NULL`)
  .all() as { id: number; notice: string }[];

const stale = rows.filter(row => row.notice.startsWith("Running on "));
for (const row of stale) {
  db.query(`UPDATE sessions SET native_metadata_json = json_set(native_metadata_json,'$.claudeAccountNotice', json('null'))
    WHERE id = ?`).run(row.id);
}
console.log(JSON.stringify({ examined: rows.length, cleared: stale.length, kept: rows.length - stale.length }));
