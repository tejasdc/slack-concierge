import type {Database} from 'bun:sqlite';

export type InboxThreadLink={inputId:string;root:string;thread:string;attached:boolean;routedBy:any;at:string};

/** Accepted inputs keep their identity across router changes. The latest exact-input
 * placement wins, including a detach; source-session filtering would lose successor work. */
export function readInboxThreadLink(db:Database,inputId:string):InboxThreadLink|null {
  const row=db.query(`SELECT payload_json,created_at FROM session_owner_events
    WHERE kind='thread_link' AND input_id=? ORDER BY sequence DESC LIMIT 1`).get(inputId) as
    {payload_json:string;created_at:string}|null;
  if(!row)return null;
  const payload=JSON.parse(row.payload_json);
  return {inputId,root:payload.root,thread:payload.thread,attached:payload.attached!==false,
    routedBy:payload.routedBy??null,at:row.created_at.includes('T')?row.created_at:row.created_at+'Z'};
}
