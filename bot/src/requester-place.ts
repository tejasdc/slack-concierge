import {db} from './state';
import {CURRENT_INBOX_ID_SQL} from './inbox-lineage-sql';

/**
 * Whether `actor` currently holds the requester's place of `requester`, and so has the
 * requester's rights over the requests it sent (cancel them, propose a handoff for their worker).
 *
 * A session holds its own place. A session that is not itself superseded also holds the place of
 * every session in its accepted provider-handoff predecessor chain, and the current Inbox router
 * holds the place of every earlier Inbox session: binding a new router with `sessions agents bind
 * inbox` moves the role but not the requests earlier routers sent, so before 2026-11-16 a dead
 * writing session kept a saving task from the 11-04 router that no session could retire.
 * This is not a privacy guard: these are agent-to-agent requests within the one operator's work,
 * and agents are never handcuffed [decision: agents-are-never-handcuffed].
 */
export function holdsRequesterPlace(actor:number,requester:number):boolean {
  if(actor===requester)return true;
  if(db.query("SELECT 1 FROM session_handoffs WHERE predecessor_session_id=? AND state='accepted' LIMIT 1").get(actor))return false;
  const inChain=db.query(`WITH RECURSIVE chain(id) AS (SELECT ? UNION
      SELECT predecessor_session_id FROM session_handoffs JOIN chain ON successor_session_id=chain.id WHERE state='accepted')
    SELECT 1 FROM chain WHERE id=? LIMIT 1`).get(actor,requester);
  if(inChain)return true;
  const current=db.query(CURRENT_INBOX_ID_SQL).get() as {id:number}|null;
  if(current?.id!==actor)return false;
  return !!db.query(`SELECT 1 FROM sessions WHERE id=? AND json_extract(native_metadata_json,'$.inbox')=1`).get(requester);
}

/** Every session whose requester place `actor` holds, itself first. */
export function requesterPlacesHeldBy(actor:number):number[] {
  if(db.query("SELECT 1 FROM session_handoffs WHERE predecessor_session_id=? AND state='accepted' LIMIT 1").get(actor))return [actor];
  const chain=(db.query(`WITH RECURSIVE chain(id) AS (SELECT ? UNION
      SELECT predecessor_session_id FROM session_handoffs JOIN chain ON successor_session_id=chain.id WHERE state='accepted')
    SELECT id FROM chain`).all(actor) as {id:number}[]).map(row=>row.id);
  const current=db.query(CURRENT_INBOX_ID_SQL).get() as {id:number}|null;
  const inbox=current?.id===actor?(db.query(`SELECT id FROM sessions WHERE json_extract(native_metadata_json,'$.inbox')=1`).all() as {id:number}[]).map(row=>row.id):[];
  return [...new Set([actor,...chain,...inbox])];
}
