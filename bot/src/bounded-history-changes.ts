import type {Database} from 'bun:sqlite';

export const HISTORY_CHANGE_LIMIT=200;
type MessageChange={id:string|null};
type TurnChange={turn_id:number|null};

/** Only IDs in the held page can need re-projection. A burst beyond one page asks the
 * client for a fresh latest page rather than examining an unbounded ledger suffix. */
export function boundedChangedMessageIds(db:Database,sessionId:number,after:number,head:number,heldIds:readonly string[]):Set<string>|null {
  if(heldIds.length>HISTORY_CHANGE_LIMIT)return null;
  const versions=db.query(`SELECT json_extract(payload_json,'$.message.id') AS id FROM session_owner_events
    WHERE session_id=? AND kind='message' AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?`)
    .all(sessionId,after,head,HISTORY_CHANGE_LIMIT+1) as MessageChange[];
  if(versions.length>HISTORY_CHANGE_LIMIT)return null;
  const turns=db.query(`SELECT turn_id FROM session_owner_events
    WHERE session_id=? AND kind<>'message' AND turn_id IS NOT NULL AND sequence>? AND sequence<=?
    ORDER BY sequence LIMIT ?`).all(sessionId,after,head,HISTORY_CHANGE_LIMIT+1) as TurnChange[];
  if(turns.length>HISTORY_CHANGE_LIMIT)return null;
  const actions=db.query(`SELECT json_extract(payload_json,'$.action.messageId') AS id FROM session_owner_events
    WHERE session_id=? AND kind='message-action' AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?`)
    .all(sessionId,after,head,HISTORY_CHANGE_LIMIT+1) as MessageChange[];
  if(actions.length>HISTORY_CHANGE_LIMIT)return null;
  const held=new Set(heldIds),changed=new Set<string>();
  for(const row of [...versions,...actions])if(row.id&&held.has(row.id))changed.add(row.id);
  const changedTurns=new Set(turns.flatMap(row=>row.turn_id?[row.turn_id]:[]));
  if(changedTurns.size&&held.size){
    const turnIds=[...changedTurns],ids=[...held];
    const rows=db.query(`SELECT DISTINCT json_extract(payload_json,'$.message.id') AS id
      FROM session_owner_events WHERE kind='message' AND session_id=?
        AND turn_id IN (${turnIds.map(()=>'?').join(',')})
        AND json_extract(payload_json,'$.message.id') IN (${ids.map(()=>'?').join(',')})
      LIMIT ?`).all(sessionId,...turnIds,...ids,HISTORY_CHANGE_LIMIT+1) as MessageChange[];
    if(rows.length>HISTORY_CHANGE_LIMIT)return null;
    for(const row of rows)if(row.id)changed.add(row.id);
  }
  return changed;
}
