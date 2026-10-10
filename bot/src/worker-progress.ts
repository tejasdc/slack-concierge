import type {Database} from 'bun:sqlite';

/**
 * The newest progress a worker reported on one request (`sessions reply <id> --partial`), as one
 * line Tejas can read: its summary, else the first sentence of its words. thnkr.ing's Brief shows
 * it on the thread's row, so a worker's progress reaches him without the router relaying it and
 * without a chat transcript (Tejas, 2026-10-10: "find figure out a way to communicate with me here").
 * Peer requests keep no progress rows here, so they answer null.
 */
export function latestWorkerProgress(source:Database,requestId:string):{text:string;at:string}|null{
 const row=source.query("SELECT payload_json,created_at_ms FROM session_communication_events WHERE request_id=? AND kind='progress' AND superseded_by_event_id IS NULL ORDER BY rowid DESC LIMIT 1")
  .get(requestId) as {payload_json:string;created_at_ms:number}|null;
 if(!row)return null;
 let payload:any;
 try{payload=JSON.parse(row.payload_json);}catch{return null;}
 const summary=typeof payload?.summary==='string'?payload.summary.replace(/\s+/g,' ').trim():'';
 const words=typeof payload?.text==='string'?payload.text.replace(/\s+/g,' ').trim():'';
 const first=words.match(/^.{1,280}?[.!?](?=\s|$)/)?.[0]??words.slice(0,280);
 const text=summary||first;
 if(!text)return null;
 return {text:text.slice(0,280),at:new Date(row.created_at_ms).toISOString()};
}
