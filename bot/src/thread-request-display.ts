import type {Database} from 'bun:sqlite';
import {authorSessionOf} from './session-presence';

/** One retained request, rendered the same way by the owner and its prepared reader. */
export function threadRequestDisplay(database:Database,event:{requestId?:unknown;targetSessionId?:unknown;threadSourceMessageId?:unknown},fallback:string):string {
  const requestId=typeof event.requestId==='string'?event.requestId:null;
  const row=requestId?(database.query('SELECT payload_json FROM session_communication_requests WHERE request_id=?').get(requestId)
    ??database.query('SELECT payload_json FROM session_peer_requests WHERE request_id=?').get(requestId)) as {payload_json:string}|null:null;
  const request=row?JSON.parse(row.payload_json):null;
  const summary=typeof request?.summary==='string'?request.summary.trim():'';
  const words=typeof request?.text==='string'?request.text:fallback;
  const sourceId=typeof event.threadSourceMessageId==='string'?event.threadSourceMessageId:null;
  const source=sourceId?database.query('SELECT origin,payload_json FROM session_inputs WHERE id=?').get(sourceId) as {origin:string;payload_json:string}|null:null;
  const retained=source?.origin==='human'?JSON.parse(source.payload_json):null;
  const sourcePayload=retained?.firstInput??retained;
  const sourceWords=typeof sourcePayload?.text==='string'?sourcePayload.text:'';
  const recipient=typeof event.targetSessionId==='string'?authorSessionOf(database,event.targetSessionId):null;
  return [recipient?`For ${recipient.title??recipient.agentName??'the working agent'}`:'',summary,
    sourceWords.trim()&&!words.includes(sourceWords)?`Tejas wrote:\n${sourceWords}`:'',words].filter(Boolean).join('\n\n');
}
