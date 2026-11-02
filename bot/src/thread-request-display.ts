import type {Database} from 'bun:sqlite';
import {authorSessionOf} from './session-presence';

/** The conversation shows the handoff; the request ledger keeps the full agent brief. */
export function threadRequestDisplay(database:Database,event:{requestId?:unknown;targetSessionId?:unknown}):string {
  const requestId=typeof event.requestId==='string'?event.requestId:null;
  const row=requestId?(database.query('SELECT payload_json FROM session_communication_requests WHERE request_id=?').get(requestId)
    ??database.query('SELECT payload_json FROM session_peer_requests WHERE request_id=?').get(requestId)) as {payload_json:string}|null:null;
  const request=row?JSON.parse(row.payload_json):null;
  const summary=typeof request?.summary==='string'?request.summary.trim():'';
  const recipient=typeof event.targetSessionId==='string'?authorSessionOf(database,event.targetSessionId):null;
  const name=recipient?.title??recipient?.agentName??'an agent';
  return `Sent to ${name}${summary?` · ${summary}`:''}`;
}
